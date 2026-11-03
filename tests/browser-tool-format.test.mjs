import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJobPrompt, parseSiteResult } from '../browser-extension/core.mjs';

const tools = [{ type: 'function', function: { name: 'list_files', description: 'List workspace files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const job = { id: 'claude-format', siteId: 'claude', tools, messages: [
  { role: 'system', content: 'Before using tools, explain your next action in a progress update.' },
  { role: 'user', content: 'Find the PDFs in this folder.' }
] };
const call = { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: { path: '.' } } };
const envelope = JSON.stringify({ content: 'I will inspect the folder.', tool_calls: [call] });

test('browser prompt puts progress commentary inside the whole-response JSON contract', () => {
  const prompt = formatJobPrompt(job);
  const contract = prompt.slice(prompt.lastIndexOf('RESPONSE FORMAT FOR THIS TURN'));
  assert.match(contract, /exactly one raw JSON object as your entire response/);
  assert.match(contract, /Do not wrap it in a Markdown code block/);
  assert.match(contract, /progress text inside the content field/);
  assert.ok(prompt.indexOf('progress update.') < prompt.indexOf('RESPONSE FORMAT FOR THIS TURN'));
  assert.match(contract, /"tool_calls":\[\]/);
  assert.match(prompt, /"name":"list_files"/);
});

test('whole response can carry commentary and object arguments without losing the tool request', () => {
  const parsed = parseSiteResult(envelope, tools);
  assert.equal(parsed.content, 'I will inspect the folder.');
  assert.equal(parsed.tool_calls.length, 1);
  assert.equal(parsed.tool_calls[0].function.name, 'list_files');
  assert.deepEqual(JSON.parse(parsed.tool_calls[0].function.arguments), { path: '.' });
  assert.deepEqual(parseSiteResult(JSON.stringify({ content: 'The PDFs were merged.', tool_calls: [] }), tools), { role: 'assistant', content: 'The PDFs were merged.' });
});

test('narrative, code labels, and quoted examples cannot authorize embedded tool calls', () => {
  for (const response of [
    `I will inspect the folder.\n\n${envelope}`,
    `json\n\`\`\`\n${envelope}\n\`\`\``,
    `Here is an example only:\n\`\`\`json\n${envelope}\n\`\`\``,
    `\`\`\`json\n${envelope}\n\`\`\`\nNext I will merge the files.`,
    `\`\`\`json\n${envelope}\n\`\`\`\n\`\`\`json\n${envelope}\n\`\`\``
  ]) assert.throws(() => parseSiteResult(response, tools), /tool-call JSON|malformed tool-call JSON/);
});

test('raw JSON requirement does not remove tool choice or declaration checks', () => {
  assert.throws(() => parseSiteResult(JSON.stringify({ content: 'Done.', tool_calls: [] }), tools, 'required'), /required tool call/);
  assert.throws(() => parseSiteResult(envelope, tools, { type: 'function', function: { name: 'read_file' } }), /different tool/);
  assert.throws(() => parseSiteResult(JSON.stringify({ content: null, tool_calls: [{ ...call, function: { name: 'run_command', arguments: { command: 'do not run' } } }] }), tools), /undeclared/);
  assert.deepEqual(parseSiteResult(envelope, tools, 'none'), { role: 'assistant', content: envelope });
  assert.doesNotMatch(formatJobPrompt({ ...job, tool_choice: 'none' }), /RESPONSE FORMAT FOR THIS TURN/);
});
