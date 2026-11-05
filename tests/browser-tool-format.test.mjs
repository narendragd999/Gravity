import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJobPrompt, parseSiteResult, recoverTextOnlyEnvelope } from '../browser-extension/core.mjs';

const tools = [{ type: 'function', function: { name: 'list_files', description: 'List workspace files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const job = { id: 'claude-format', siteId: 'claude', tools, messages: [
  { role: 'system', content: 'Before using tools, explain your next action in a progress update.' },
  { role: 'user', content: 'Find the PDFs in this folder.' }
] };
const call = { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: { path: '.' } } };
const envelope = JSON.stringify({ content: 'I will inspect the folder.', tool_calls: [call] });

test('browser prompt uses ordinary text for answers and puts tool-request commentary inside its envelope', () => {
  const prompt = formatJobPrompt(job);
  const contract = prompt.slice(prompt.lastIndexOf('RESPONSE FORMAT FOR THIS TURN'));
  assert.match(contract, /exactly one fenced JSON code block as your entire response/);
  assert.match(contract, /preserves straight JSON quotes and underscores/);
  assert.match(contract, /exact field name "tool_calls"/);
  assert.match(contract, /progress text inside the content field/);
  assert.ok(prompt.indexOf('progress update.') < prompt.indexOf('RESPONSE FORMAT FOR THIS TURN'));
  assert.match(contract, /When no application tool is needed, answer the user in ordinary text/);
  assert.match(contract, /To request an application tool, return exactly one fenced JSON/);
  assert.doesNotMatch(contract, /When no tool is needed, use \{"content"/);
  assert.match(prompt, /"name":"list_files"/);
});

test('browser prompt preserves ordinary no-tool replies and required or named tool choices', () => {
  assert.match(formatJobPrompt({ ...job, tools: [] }), /Answer directly in ordinary text unless the user requested a specific format/);
  assert.match(formatJobPrompt({ ...job, tool_choice: 'none' }), /Application tool requests are unavailable/);
  assert.match(formatJobPrompt({ ...job, tool_choice: 'required' }), /A tool call is required for this response/);
  assert.match(formatJobPrompt({ ...job, tool_choice: { type: 'function', function: { name: 'list_files' } } }), /requested next tool is list_files.*requires its canonical tool envelope/);
  assert.deepEqual(parseSiteResult('Hello! How can I help?', tools, 'auto'), { role: 'assistant', content: 'Hello! How can I help?' });
});

test('whole response can carry commentary and object arguments without losing the tool request', () => {
  const parsed = parseSiteResult(envelope, tools);
  assert.equal(parsed.content, 'I will inspect the folder.');
  assert.equal(parsed.tool_calls.length, 1);
  assert.equal(parsed.tool_calls[0].function.name, 'list_files');
  assert.deepEqual(JSON.parse(parsed.tool_calls[0].function.arguments), { path: '.' });
  assert.deepEqual(parseSiteResult(JSON.stringify({ content: 'The PDFs were merged.', tool_calls: [] }), tools), { role: 'assistant', content: 'The PDFs were merged.' });
});

test('narrative and quoted examples cannot authorize embedded tool calls', () => {
  for (const response of [
    `I will inspect the folder.\n\n${envelope}`,
    `Here is an example only:\n\`\`\`json\n${envelope}\n\`\`\``,
    `\`\`\`json\n${envelope}\n\`\`\`\nNext I will merge the files.`,
    `\`\`\`json\n${envelope}\n\`\`\`\n\`\`\`json\n${envelope}\n\`\`\``
  ]) assert.throws(() => parseSiteResult(response, tools), /tool-call JSON|malformed tool-call JSON/);
});

test('code block language prefix preserves tool calls', () => {
  for (const response of [
    `json\n\`\`\`\n${envelope}\n\`\`\``,
    `json\n\`\`\`json\n${envelope}\n\`\`\``,
    `json\n${envelope}`
  ]) {
    const parsed = parseSiteResult(response, tools);
    assert.equal(parsed.tool_calls.length, 1);
    assert.equal(parsed.tool_calls[0].function.name, 'list_files');
    assert.equal(parsed.content, 'I will inspect the folder.');
  }
});

test('raw JSON requirement does not remove tool choice or declaration checks', () => {
  assert.throws(() => parseSiteResult(JSON.stringify({ content: 'Done.', tool_calls: [] }), tools, 'required'), /required tool call/);
  assert.throws(() => parseSiteResult(envelope, tools, { type: 'function', function: { name: 'read_file' } }), /different tool/);
  assert.throws(() => parseSiteResult(JSON.stringify({ content: null, tool_calls: [{ ...call, function: { name: 'run_command', arguments: { command: 'do not run' } } }] }), tools), /undeclared/);
  assert.deepEqual(parseSiteResult(envelope, tools, 'none'), { role: 'assistant', content: envelope });
  assert.doesNotMatch(formatJobPrompt({ ...job, tool_choice: 'none' }), /RESPONSE FORMAT FOR THIS TURN/);
});


test('misspelled keys and smart quotes are rejected rather than displayed as successful actions', () => {
  for (const text of [
    '{"content":null,"toolcalls":[{"function":{"name":"list_files"}}]}',
    '{“content”:null,”tool_calls”:[{“function”:{“name”:”list_files”}}]}',
    'Claude responded: {"content":null,"toolcalls":[]}\n\n{“content”:null,”tool_calls”:[]}\n\njust now',
    '```json\n{"content":null,"toolCalls":[]}\n```'
  ]) assert.throws(() => parseSiteResult(text, tools), /tool-call JSON/);
  assert.deepEqual(parseSiteResult('The field name is "tool_calls".', tools), { role: 'assistant', content: 'The field name is "tool_calls".' });
});

test('fenced action preserves command punctuation and produces exactly one normalized request', () => {
  const commandTools = [{ type: 'function', function: { name: 'run_command' } }];
  const command = "New-Item -ItemType Directory -Path 'One','Two'";
  const text = '```json\n' + JSON.stringify({ content: null, tool_calls: [{ id: 'make_dirs', type: 'function', function: { name: 'run_command', arguments: { command } } }] }) + '\n```';
  const result = parseSiteResult(text, commandTools);
  assert.equal(result.tool_calls.length, 1);
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { command });
});

test('complete greetings recover text from canonical or smart-quoted empty-tool envelopes', () => {
  const greeting = 'Hello! I’m Gravity, your AI assistant. How can I help you today?';
  const expected = { role: 'assistant', content: greeting };
  for (const response of [
    JSON.stringify({ content: greeting, tool_calls: [] }),
    JSON.stringify({ tool_calls: [], content: greeting }),
    `{“content”:”${greeting}”,”tool_calls”:[]}`,
    `{“tool_calls”: [], “content”: “${greeting}”}`,
    `{\"content\":”${greeting}”,\"tool_calls\":[]}`,
    '```json\n' + JSON.stringify({ content: greeting, tool_calls: [] }) + '\n```',
    '```json\n' + `{“content”:”${greeting}”,”tool_calls”:[]}` + '\n```'
  ]) {
    assert.deepEqual(recoverTextOnlyEnvelope(response), expected);
    assert.deepEqual(parseSiteResult(response, tools), expected);
  }
  for (const response of [
    'json\n' + JSON.stringify({ content: greeting }),
    'json\n' + JSON.stringify({ content: greeting, tool_calls: [] }),
    'json\n```\n' + JSON.stringify({ content: greeting }) + '\n```',
    'json\n```\n' + JSON.stringify({ content: greeting, tool_calls: [] }) + '\n```',
    JSON.stringify({ content: greeting }),
    '```json\n' + JSON.stringify({ content: greeting }) + '\n```'
  ]) {
    assert.deepEqual(parseSiteResult(response, tools), expected);
  }
});

test('smart text recovery preserves Unicode, interior quotes, and JSON string escapes', () => {
  const content = 'नमस्ते 🌍 — I’m Gravity. Say “hello”, then "welcome".\nFolder: C:\\Users\\O\'Brien\t\"quoted\"';
  const encoded = JSON.stringify(content).slice(1, -1);
  const smart = `{“content”:”${encoded}”,”tool_calls”:[]}`;
  assert.deepEqual(recoverTextOnlyEnvelope(smart), { role: 'assistant', content });
  assert.deepEqual(parseSiteResult(smart, tools), { role: 'assistant', content });
  assert.deepEqual(recoverTextOnlyEnvelope('{“tool_calls”:[],“content”:“Say "hello" and “welcome”. \\u263a \\uD83D\\uDE00”}'), {
    role: 'assistant', content: 'Say "hello" and “welcome”. ☺ 😀'
  });
});

test('recovered content remains text even when it contains literal tool-call examples', () => {
  const content = `The tool_calls field is a list. Here is a code example:\n\`\`\`json\n${envelope}\n\`\`\``;
  for (const response of [
    JSON.stringify({ content, tool_calls: [] }),
    '```json\n' + JSON.stringify({ content, tool_calls: [] }) + '\n```',
    `{“content”:”${JSON.stringify(content).slice(1, -1)}”,”tool_calls”:[]}`
  ]) {
    const result = parseSiteResult(response, tools);
    assert.deepEqual(result, { role: 'assistant', content });
    assert.equal(result.tool_calls, undefined);
  }
});

test('text recovery never repairs nonempty actions, typo keys, or mixed narrative', () => {
  for (const response of [
    `{“content”:”Hello”,”tool_calls”:[${JSON.stringify(call)}]}`,
    '{“content”:”Hello”,”toolcalls”:[]}',
    'Here is my answer: {“content”:”Hello”,”tool_calls”:[]}',
    '```json\n{“content”:”Hello”,”tool_calls”:[]}\n```\nDone.',
    '```json\n{“content”:”Hello”,”tool_calls”:[]}\n```\n```json\n{“content”:”Again”,”tool_calls”:[]}\n```'
  ]) {
    assert.equal(recoverTextOnlyEnvelope(response), null);
    assert.throws(() => parseSiteResult(response, tools), /tool-call JSON/);
  }
});

test('text recovery declines extra fields and malformed envelopes', () => {
  for (const response of [
    '{"content":"Hello","tool_calls":[],"extra":true}',
    '{“content”:”Hello”,”extra”:true,”tool_calls”:[]}',
    '{“tool_calls”:[],”content”:”Hello”,”extra”:true}',
    '{“content”:”Hello”,\'extra\':true,”tool_calls”:[]}',
    '{“content”:”Hello”,extra:true,”tool_calls”:[]}',
    '{“content”:”Hello”,”content”:”Again”,”tool_calls”:[]}',
    '{“content”:”Hello”,”tool_calls”:[{}],”tool_calls”:[]}',
    '{“content”:null,”tool_calls”:[]}',
    '{“content”:”   ”,”tool_calls”:[]}',
    '{“content”:”Hello \\x21”,”tool_calls”:[]}',
    '{“content”:”Hello \\u123”,”tool_calls”:[]}',
    '{“content”:”Hello\nworld”,”tool_calls”:[]}',
    '{"content":"Say "hello" and “welcome”.","tool_calls":[]}',
    '{“content”:”Hello”,”tool_calls”:[]'
  ]) assert.equal(recoverTextOnlyEnvelope(response), null, response);
});

test('empty-tool greeting recovery respects required, forced, and disabled tool choices', () => {
  const response = '{“content”:”Hello!”,”tool_calls”:[]}';
  for (const choice of ['required', { type: 'function', function: { name: 'list_files' } }]) {
    assert.throws(() => parseSiteResult(response, tools, choice), /no required tool call/);
  }
  assert.deepEqual(parseSiteResult(response, tools, 'none'), { role: 'assistant', content: response });
  assert.deepEqual(parseSiteResult(response, []), { role: 'assistant', content: response });
});

test('duplicate top-level envelope keys cannot select a different action or answer', () => {
  const calls = JSON.stringify([call]);
  for (const body of [
    `{"content":"Hello","tool_calls":[],"tool_calls":${calls}}`,
    `{"content":"Hello","tool_calls":${calls},"tool_calls":[]}`,
    '{"content":"First","content":"Last","tool_calls":[]}',
    `{"content":"Hello","\\u0074ool_calls":[],"tool_calls":${calls}}`,
    `{"content":"Hello","\\u0074ool_calls":[],"tool_\\u0063alls":${calls}}`,
    '{"content":"First","con\\u0074ent":"Last","tool_calls":[]}'
  ]) {
    for (const response of [body, '```json\n' + body + '\n```']) {
      assert.equal(recoverTextOnlyEnvelope(response), null);
      assert.throws(() => parseSiteResult(response, tools), /duplicate top-level fields/);
    }
  }
});

test('duplicate-looking JSON inside content is not an envelope field', () => {
  const content = 'Example: {"content":"First","content":"Last","tool_calls":[],"tool_calls":[{"name":"example"}]}\nEscapes: \\ and \\"';
  const response = JSON.stringify({ content, tool_calls: [] });
  assert.deepEqual(recoverTextOnlyEnvelope(response), { role: 'assistant', content });
  assert.deepEqual(parseSiteResult(response, tools), { role: 'assistant', content });
});

test('smart text recovery cannot swallow escaped or mixed-quote extra keys', () => {
  for (const response of [
    '{“content”:“Hello”,“extr\\u0061”:“hidden”,“tool_calls”:[]}',
    '{“content”:“Hello”,“con\\u0074ent”:“hidden”,“tool_calls”:[]}',
    '{“tool_calls”:[],“content”:“Hello”,“extr\\u0061”:“hidden”}',
    '{“content”:“Hello”,"extr\\\"a":"hidden",“tool_calls”:[]}',
    '{“content”:“Hello”,"extr“a":"hidden",“tool_calls”:[]}'
  ]) {
    assert.equal(recoverTextOnlyEnvelope(response), null, response);
    assert.throws(() => parseSiteResult(response, tools), /tool-call JSON/);
  }
});
