import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { complete, discoverModels, streamCompletion } from '../electron/providers.mjs';

const body = { model: 'custom-model', messages: [{ role: 'user', content: 'Hello' }] };
const answer = content => ({ id: 'mock-completion', object: 'chat.completion', model: 'custom-model', created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const openChunk = (delta, finish_reason = null) => ({ id: 'mock-stream', object: 'chat.completion.chunk', created: 1, model: 'custom-model', choices: [{ index: 0, delta, finish_reason }] });
const tool = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };

async function fixture(t, handler) {
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const buffer of req) raw += buffer;
      const input = raw ? JSON.parse(raw) : undefined;
      await handler(req, res, input);
    } catch (error) { errors.push(error); res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (errors.length) throw errors[0];
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
const sse = res => res.setHeader('content-type', 'text/event-stream');

test('stopped local bridge reports an actionable connection error without secrets', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(discoverModels({ type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'private-bridge-token' }), error => {
    assert.equal(error.code, 'connection_refused');
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(error.message, /Start the matching Web2API bridge/);
    assert.doesNotMatch(error.message, /private-bridge-token/);
    return true;
  });
});

test('OpenAI preserves custom prefix/query, normalizes full completion URL, and discovers actual IDs', async t => {
  const url = await fixture(t, (req, res, input) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    assert.equal(req.headers['x-tenant'], 'tenant-a');
    if (req.method === 'GET') {
      assert.equal(req.url, '/proxy/custom/models?api-version=preview');
      json(res, { data: [{ id: 'z-custom' }, { id: 'a-custom' }, { id: 'z-custom' }] });
    } else {
      assert.equal(req.url, '/proxy/custom/chat/completions?api-version=preview');
      assert.equal(input.model, 'custom-model'); assert.equal(input.stream, false);
      json(res, answer('Works'));
    }
  });
  const provider = { type: 'openai', baseUrl: `${url}/proxy/custom/chat/completions/?api-version=preview`, apiKey: 'test-secret', headers: { 'x-tenant': 'tenant-a' } };
  assert.deepEqual(await discoverModels(provider), ['a-custom', 'z-custom']);
  assert.equal((await complete(provider, body)).choices[0].message.content, 'Works');
});

test('OpenAI SSE handles byte-split UTF8, CRLF, multiline data and fragmented tool arguments', async t => {
  const url = await fixture(t, async (req, res, input) => {
    assert.equal(req.url, '/custom/chat/completions'); assert.equal(input.stream, true);
    sse(res);
    res.write(': keepalive\r\n\r\n');
    const unicode = Buffer.from(event(openChunk({ role: 'assistant', content: 'Hello 🌍' })));
    const split = unicode.indexOf(Buffer.from('🌍')) + 2;
    res.write(unicode.subarray(0, split)); await delay(10); res.write(unicode.subarray(split));
    res.write('data: {"choices": [\r\ndata: {"index":0,"delta":{"content":"!"},"finish_reason":null}]}\r\n\r\n');
    res.write(event(openChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] })));
    res.write(event(openChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] })));
    res.write(event(openChunk({}, 'tool_calls')));
    res.end('data: [DONE]\r\n\r\n');
  });
  const deltas = [];
  const result = await complete({ type: 'openai', baseUrl: `${url}/custom` }, { ...body, tools: [tool] }, { onDelta: text => deltas.push(text) });
  assert.equal(deltas.join(''), 'Hello 🌍!');
  assert.equal(result.choices[0].message.content, 'Hello 🌍!');
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
});

test('OpenAI accepts bridge single buffered SSE call with no tool index and EOF without newline', async t => {
  const url = await fixture(t, (_, res) => {
    sse(res); res.end(`data: ${JSON.stringify(openChunk({ role: 'assistant', content: null, tool_calls: [{ id: 'bridge-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, 'tool_calls'))}`);
  });
  const result = await complete({ baseUrl: url }, { ...body, stream: true });
  assert.equal(result.choices[0].message.tool_calls[0].id, 'bridge-call');
  assert.equal(result.choices[0].message.content, null);
});

test('Anthropic JSON maps system, tool history, auth, tool choice, and usage', async t => {
  const url = await fixture(t, (req, res, input) => {
    assert.equal(req.url, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'anthropic-secret');
    assert.equal(req.headers['anthropic-version'], '2023-06-01'); assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(input.system, [{ type: 'text', text: 'Be precise.' }]);
    assert.deepEqual(input.tool_choice, { type: 'tool', name: 'read_file' });
    assert.equal(input.tools[0].input_schema.type, 'object'); assert.equal(input.max_tokens, 256);
    assert.equal(input.messages[1].content[0].type, 'tool_use');
    assert.deepEqual(input.messages[2].content[0], { type: 'tool_result', tool_use_id: 'prior', content: 'file text' });
    json(res, { id: 'msg_a', model: 'claude-custom', content: [{ type: 'text', text: 'Read result' }, { type: 'tool_use', id: 'next', name: 'read_file', input: { path: 'b.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 22 } });
  });
  const result = await complete({ type: 'anthropic', baseUrl: url, apiKey: 'anthropic-secret' }, {
    ...body, max_tokens: 256, tools: [tool], tool_choice: { type: 'function', function: { name: 'read_file' } },
    messages: [{ role: 'system', content: 'Be precise.' }, ...body.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'prior', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'prior', content: 'file text' }]
  });
  assert.equal(result.id, 'msg_a'); assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"path":"b.txt"}');
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
});

test('Anthropic SSE translates text, partial tool input, reasoning, and terminal usage', async t => {
  const url = await fixture(t, (_, res, input) => {
    assert.equal(input.stream, true); sse(res);
    for (const value of [
      { type: 'message_start', message: { id: 'msg_stream', model: 'claude-custom', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-a', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"readme.md"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' }
    ]) res.write(event(value));
    res.end();
  });
  const result = await complete({ type: 'anthropic', baseUrl: `${url}/v1` }, { ...body, stream: true });
  assert.equal(result.choices[0].message.content, 'Checking');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"path":"readme.md"}');
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 });
});

test('Gemini JSON translates tool history and preserves thought signatures', async t => {
  const url = await fixture(t, (req, res, input) => {
    assert.equal(req.url, '/v1beta/models/custom-model:generateContent');
    assert.equal(req.headers['x-goog-api-key'], 'gemini-secret');
    assert.deepEqual(input.systemInstruction, { parts: [{ text: 'Use tools.' }] });
    assert.deepEqual(input.contents[1].parts[0], { functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'opaque-signature' });
    assert.deepEqual(input.contents[2].parts[0], { functionResponse: { name: 'read_file', response: { result: 'plain result' } } });
    assert.equal(input.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
    json(res, { modelVersion: 'gemini-version', candidates: [{ content: { parts: [
      { text: 'Found it.' }, { functionCall: { name: 'read_file', args: { path: 'b.txt' } }, thoughtSignature: 'next-signature' }
    ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } });
  });
  const result = await complete({ type: 'gemini', baseUrl: `${url}/v1beta`, apiKey: 'gemini-secret' }, {
    ...body, tools: [tool], messages: [{ role: 'system', content: 'Use tools.' }, ...body.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'prior', type: 'function', thought_signature: 'opaque-signature', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'prior', content: 'plain result' }]
  });
  assert.equal(result.model, 'gemini-version'); assert.equal(result.choices[0].message.content, 'Found it.');
  assert.equal(result.choices[0].message.tool_calls[0].thought_signature, 'next-signature');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('Gemini SSE URL and tool calls normalize into OpenAI streaming output', async t => {
  const url = await fixture(t, (req, res, input) => {
    assert.equal(req.url, '/v1beta/models/custom-model:streamGenerateContent?alt=sse');
    assert.equal(input.stream, undefined); sse(res);
    res.write(event({ candidates: [{ index: 0, content: { parts: [{ text: 'One ' }] } }] }));
    res.write(event({ candidates: [{ index: 0, content: { parts: [{ text: 'two.' }, { functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }));
    res.end();
  });
  const result = await complete({ type: 'gemini', baseUrl: url }, { ...body, stream: true });
  assert.equal(result.choices[0].message.content, 'One two.');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.equal(result.choices[0].message.tool_calls[0].thought_signature, 'sig');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
});

test('Native discovery paginates and filters non-generative Gemini models', async t => {
  const requests = [];
  const url = await fixture(t, (req, res) => {
    requests.push(req.url);
    if (req.url === '/v1/models') json(res, { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' });
    else if (req.url === '/v1/models?after_id=claude-a') json(res, { data: [{ id: 'claude-b' }], has_more: false });
    else if (req.url === '/v1beta/models') json(res, { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next-page' });
    else if (req.url === '/v1beta/models?pageToken=next-page') json(res, { models: [{ name: 'models/gemini-b' }] });
    else assert.fail(req.url);
  });
  assert.deepEqual(await discoverModels({ type: 'anthropic', baseUrl: url }), ['claude-a', 'claude-b']);
  assert.deepEqual(await discoverModels({ type: 'gemini', baseUrl: url }), ['gemini-a', 'gemini-b']);
  assert.equal(requests.length, 4);
});

test('Provider errors preserve HTTP status while redacting credentials', async t => {
  const url = await fixture(t, (_, res) => { res.statusCode = 401; json(res, { error: { message: 'Invalid test-secret', code: 'invalid_api_key' } }); });
  await assert.rejects(complete({ baseUrl: url, apiKey: 'test-secret' }, body), error => {
    assert.equal(error.status, 401); assert.equal(error.code, 'invalid_api_key'); assert.equal(error.message, 'Invalid [redacted]'); return true;
  });
});

test('Malformed and truncated streams fail instead of returning a successful partial answer', async t => {
  const url = await fixture(t, (req, res) => {
    sse(res);
    if (req.url.startsWith('/malformed')) res.end('data: not-json\n\n');
    else if (req.url.startsWith('/error')) res.end(event({ error: { message: 'Generation unavailable' } }));
    else res.end(event(openChunk({ content: 'Partial' })));
  });
  await assert.rejects(complete({ baseUrl: `${url}/malformed` }, { ...body, stream: true }), /malformed JSON/);
  await assert.rejects(complete({ baseUrl: `${url}/error` }, { ...body, stream: true }), /Generation unavailable/);
  await assert.rejects(complete({ baseUrl: `${url}/truncated` }, { ...body, stream: true }), /before a completion marker/);
});

test('Cancellation and timeout abort pending provider requests', async t => {
  const url = await fixture(t, () => {});
  const controller = new AbortController();
  const pending = complete({ baseUrl: url }, body, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, error => error.name === 'AbortError');
  await assert.rejects(complete({ baseUrl: url }, body, { timeoutMs: 30 }), error => error.name === 'TimeoutError');
});

test('No fabricated models on broken discovery and no embedded URL credentials', async t => {
  const url = await fixture(t, (_, res) => json(res, { unexpected: [] }));
  await assert.rejects(discoverModels({ baseUrl: url }), /unexpected response/);
  await assert.rejects(complete({ baseUrl: 'http://user:secret@127.0.0.1' }, body), /without embedded credentials/);
});

test('A JSON-only service can still satisfy a streaming caller', async t => {
  const url = await fixture(t, (_, res) => json(res, answer('Buffered answer')));
  const chunks = [];
  for await (const chunk of streamCompletion({ baseUrl: url }, body)) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].object, 'chat.completion.chunk');
  assert.equal(chunks[0].choices[0].delta.content, 'Buffered answer');
});

test('completed JSON and SSE responses without an answer fail with recovery guidance', async t => {
  let content;
  const url = await fixture(t, (req, res) => {
    if (req.url.startsWith('/stream')) {
      sse(res);
      res.write(event(openChunk({ role: 'assistant', content })));
      res.end(event(openChunk({}, 'stop')) + 'data: [DONE]\n\n');
    } else json(res, answer(content));
  });
  for (content of [null, '', ' \n\t', [{ type: 'text', text: '  ' }]]) {
    for (const stream of [false, true]) {
      await assert.rejects(complete({ id: 'gemini-local', baseUrl: `${url}/${stream ? 'stream' : 'json'}` }, { ...body, stream }), error => {
        assert.equal(error.code, 'empty_response');
        assert.match(error.message, /Gemini Web2API returned no answer/);
        assert.match(error.message, /normal Chrome/);
        return true;
      });
    }
  }
});

test('reasoning without a final answer and explicit refusal are not successful responses', async t => {
  const url = await fixture(t, (req, res) => {
    const result = answer(null);
    if (req.url.startsWith('/reasoning')) result.choices[0].message.reasoning_content = 'I am thinking about it.';
    else result.choices[0].message.refusal = 'Declined.';
    json(res, result);
  });
  await assert.rejects(complete({ baseUrl: `${url}/reasoning` }, body), error => error.code === 'reasoning_only_response');
  await assert.rejects(complete({ baseUrl: `${url}/refusal` }, body), error => error.code === 'blocked_response');
});

test('streamed text parts stay text and valid tool-only turns still succeed', async t => {
  const url = await fixture(t, (req, res) => {
    sse(res);
    const delta = req.url.startsWith('/tool')
      ? { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }] }
      : { content: [{ type: 'text', text: 'A usable answer.' }] };
    res.write(event(openChunk(delta)));
    res.end(event(openChunk({}, req.url.startsWith('/tool') ? 'tool_calls' : 'stop')) + 'data: [DONE]\n\n');
  });
  const deltas = [];
  const text = await complete({ baseUrl: `${url}/text` }, body, { onDelta: text => deltas.push(text) });
  assert.equal(text.choices[0].message.content, 'A usable answer.');
  assert.deepEqual(deltas, ['A usable answer.']);
  const tools = await complete({ baseUrl: `${url}/tool` }, { ...body, stream: true });
  assert.equal(tools.choices[0].message.content, null);
  assert.equal(tools.choices[0].message.tool_calls[0].function.arguments, '{"path":"note.txt"}');
});

test('malformed tool batches fail before any action is accepted', async t => {
  let argumentsText;
  const url = await fixture(t, (_, res) => {
    const result = answer(null);
    result.choices[0].message.tool_calls = [{ id: 'valid', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'invalid', type: 'function', function: { name: 'propose_file', arguments: argumentsText } }];
    json(res, result);
  });
  for (argumentsText of ['not-json', '[]', 'null', '"text"']) await assert.rejects(complete({ baseUrl: url }, body), error => error.code === 'invalid_tool_call');
});

test('native Gemini blocks safety and malformed-function results even when a tool payload exists', async t => {
  let finishReason, streaming;
  const url = await fixture(t, (_, res) => {
    const data = { candidates: [{ content: { parts: [{ functionCall: { name: 'propose_file', args: { path: 'a.txt', content: 'blocked' } } }] }, finishReason }] };
    if (streaming) { sse(res); res.end(event(data)); } else json(res, data);
  });
  for (streaming of [false, true]) for (finishReason of ['SAFETY', 'PROHIBITED_CONTENT', 'MALFORMED_FUNCTION_CALL']) {
    await assert.rejects(complete({ type: 'gemini', baseUrl: url }, { ...body, stream: streaming }), error => error.code === (finishReason === 'MALFORMED_FUNCTION_CALL' ? 'invalid_tool_call' : 'blocked_response'));
  }
});

test('explicit bridge model fallback fails while ordinary model version aliases remain valid', async t => {
  let fallback = false;
  const url = await fixture(t, (_, res) => {
    if (fallback) res.setHeader('X-Model-Fallback', 'true');
    json(res, { ...answer('OK'), model: 'custom-model-version-2026' });
  });
  assert.equal((await complete({ baseUrl: url }, body)).model, 'custom-model-version-2026');
  fallback = true;
  await assert.rejects(complete({ baseUrl: url }, body), error => error.code === 'model_fallback');
});

test('native Gemini unavailable model errors give model discovery and Base URL guidance', async t => {
  const url = await fixture(t, (_, res) => { res.statusCode = 404; json(res, { error: { message: 'models/retired-model is unavailable' } }); });
  await assert.rejects(complete({ type: 'gemini', baseUrl: url }, body), error => {
    assert.equal(error.code, 'model_not_found');
    assert.equal(error.status, 404);
    assert.match(error.message, /Discover models/);
    assert.match(error.message, /Base URL/);
    return true;
  });
});

test('direct stream callers never receive a successful finish for empty or malformed action output', async t => {
  let toolArguments;
  const url = await fixture(t, (req, res) => {
    sse(res);
    const delta = req.url.startsWith('/invalid-tool') ? { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'run_command', arguments: toolArguments } }] } : { role: 'assistant' };
    res.write(event(openChunk(delta)));
    res.end(event(openChunk({}, toolArguments ? 'tool_calls' : 'stop')) + 'data: [DONE]\n\n');
  });
  for (toolArguments of [undefined, 'not-json']) {
    const received = [];
    await assert.rejects(async () => {
      for await (const value of streamCompletion({ baseUrl: `${url}/${toolArguments ? 'invalid-tool' : 'empty'}` }, body)) received.push(value);
    }, error => error.code === (toolArguments ? 'invalid_tool_call' : 'empty_response'));
    assert.ok(!received.some(value => value.choices?.some(choice => choice.finish_reason != null)));
  }
});
