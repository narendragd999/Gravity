// Synthetic protocol fixtures, not captured account messages. Mutation and
// reasoning-wrapper shapes are based on this public pinned reference:
export const protocolReference = 'https://github.com/jubinjacob03/glm-proxy/tree/cc8165b675af2db10fb6ae85aa01cf33568c2e46/internal/zbridge';
export const capturedFromLiveAccount = false;

export const greeting = 'Hello! What would you like to work on?';
const example = '{"content":null,"tool_calls":[{"id":"example","type":"function","function":{"name":"read_file","arguments":{"path":"example-only.txt"}}}]}';
const prefix = `<details>> A tool-call example, not a request: ${example}\n> Revised `;

// Z.ai uses JavaScript/UTF-16 offsets against the combined raw buffer. Keep
// reasoning there until all edits settle, then classify the final text.
export const editedReasoningGreeting = [
  { data: { content: prefix + 'wrong tail' } },
  { data: { edit_index: prefix.length, edit_content: 'right tail</details>' } },
];
let raw = prefix + 'right tail</details>';
for (const character of greeting) {
  editedReasoningGreeting.push({ data: { edit_index: raw.length, edit_content: character } });
  raw += character;
}
editedReasoningGreeting.push({ data: { phase: 'done' } });

export const splitReasoningGreeting = [
  { data: { delta_content: '<det' } },
  { data: { delta_content: `ails>> First example: ${example}\n> Second example: ${example}` } },
  { data: { delta_content: '</details>' + greeting } },
  { data: { phase: 'done' } },
];

export const replacedReasoningGreeting = [
  { data: { content: '<details type="reasoning">Draft explanation</details>Wrong answer' } },
  { data: { content: `<details type="reasoning">Revised explanation</details>${greeting}` } },
  { data: { phase: 'done' } },
];
