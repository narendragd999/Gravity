export const CONNECTOR_ORIGIN = 'http://127.0.0.1:4319';
export const SITES = Object.freeze([
  { id: 'claude', name: 'Claude', model: 'claude-web', url: 'https://claude.ai/new', host: 'claude.ai',
    composer: ['[data-testid="chat-input"][contenteditable="true"]', '[contenteditable="true"].ProseMirror', '[contenteditable="true"][role="textbox"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[data-testid="send-button"]'],
    stop: ['button[aria-label="Stop Response"]', 'button[aria-label="Stop response"]', 'button[aria-label="Stop generating"]'],
    response: ['[data-testid="assistant-message"]', '[data-message-author-role="assistant"]', '.font-claude-response'], user: ['[data-testid="user-message"]', '[data-message-author-role="user"]'],
    complete: ['button[aria-label="Copy"]', 'button[aria-label="Copy response"]', 'button[data-testid="copy-message-button"]'], enter: true },
  { id: 'chatgpt', name: 'ChatGPT', model: 'chatgpt-web', url: 'https://chatgpt.com/', host: 'chatgpt.com',
    composer: ['#prompt-textarea'], send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop generating"]'], response: ['[data-message-author-role="assistant"]'], user: ['[data-message-author-role="user"]'],
    complete: ['button[data-testid="copy-turn-action-button"]', 'button[aria-label="Copy"]'], enter: true },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-web', url: 'https://chat.deepseek.com/', host: 'chat.deepseek.com',
    composer: ['textarea[placeholder*="DeepSeek"]', 'textarea[placeholder*="Message"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send"]', '[role="button"][aria-label="Send"]', 'button[data-testid="send-button"]'],
    stop: ['button[aria-label="Stop generating"]', '[role="button"][aria-label="Stop"]', '[role="button"][aria-label="停止生成"]'],
    response: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '.ds-message--assistant .ds-markdown', '.ds-markdown'], user: ['[data-message-author-role="user"]', '[data-role="user"]', '.ds-message--user'],
    complete: ['button[aria-label="Copy"]', '[role="button"][aria-label="Copy"]', '[role="button"][aria-label="复制"]'], enter: true },
  { id: 'qwen', name: 'Qwen', model: 'qwen-web', url: 'https://chat.qwen.ai/', host: 'chat.qwen.ai',
    composer: ['#chat-input', 'textarea[placeholder*="Qwen"]', 'textarea[placeholder*="Message"]', 'textarea[placeholder="How can I help you today?"]', '[contenteditable="true"][role="textbox"]'],
    send: ['button[aria-label="Send"]', 'button[aria-label="Send message"]', 'button[data-testid="send-button"]', 'button.send-button'],
    stop: ['button[aria-label="Stop generating"]', 'button[aria-label="Stop"]', 'button[aria-label="停止生成"]'],
    response: ['[data-message-author-role="assistant"]', '.assistant-message .message-content', '.response-message-content', '[data-role="assistant"]'], user: ['[data-message-author-role="user"]', '[data-role="user"]', '.user-message'],
    complete: ['button[aria-label="Copy"]', 'button[aria-label="Copy response"]', 'button[title="Copy"]'], enter: true },
  { id: 'zai', name: 'Z.ai', model: 'zai-web', url: 'https://chat.z.ai/', host: 'chat.z.ai',
    composer: ['#chat-input', 'textarea[placeholder*="Message"]', 'textarea[placeholder*="Ask"]', '[contenteditable="true"][role="textbox"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send"]', 'button[data-testid="send-button"]', '#send-message-button'],
    stop: ['button[aria-label="Stop generating"]', 'button[aria-label="Stop"]', '#stop-response-button'],
    response: ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '.assistant-message .markdown-prose', '.message-assistant .prose'], user: ['[data-message-author-role="user"]', '[data-role="user"]', '.user-message'],
    complete: ['button[aria-label="Copy"]', 'button[aria-label="Copy response"]', 'button[title="Copy"]'], enter: true },
  { id: 'gemini', name: 'Gemini', model: 'gemini-web', url: 'https://gemini.google.com/app', host: 'gemini.google.com',
    composer: ['rich-textarea [contenteditable="true"]', 'rich-textarea p', '.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', '[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Gemini"]', 'textarea[aria-label*="Gemini"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Send"]', 'button.send-button', 'button[mattooltip="Send message"]', 'button[aria-label*="Send"]'],
    stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop"]'],
    response: ['model-response .model-response-text', 'model-response .markdown', 'model-response', '[data-message-author="model"]'], user: ['user-query', '[data-message-author="user"]'],
    complete: ['button[aria-label="Copy response"]', 'button[aria-label="Copy"]', 'button[data-test-id="copy-button"]'], enter: true }
]);

export function siteById(id) { return SITES.find(site => site.id === id); }
export function siteForUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port ? SITES.find(site => site.host === url.hostname) : undefined; }
  catch { return undefined; }
}
export function siteMatchesUrl(siteId, value) { return siteForUrl(value)?.id === siteId; }

function textContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part => part?.type === 'text' && typeof part.text === 'string')) return content.map(part => part.text).join('\n');
  throw new Error('Browser-connected chats currently support text messages only. Use a direct API for images or attachments.');
}
export function formatJobPrompt(job) {
  if (!job || typeof job.id !== 'string' || !job.id.trim() || job.id.includes('\0') || job.id.length > 200 || !siteById(job.siteId)) throw new Error('Invalid browser job or unsupported site.');
  if (!Array.isArray(job.messages) || !job.messages.length || job.messages.length > 256) throw new Error('Browser job must contain 1–256 messages.');
  const transcript = job.messages.map(message => {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('Browser job contains an unsupported message role.');
    let content = textContent(message.content);
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new Error('Previous tool calls must be an array.');
      content += `\nPrevious tool calls: ${JSON.stringify(message.tool_calls)}`;
    }
    return `[${message.role.toUpperCase()}${message.role === 'tool' && message.tool_call_id ? ` result ${String(message.tool_call_id).slice(0, 200)}` : ''}]\n${content}`;
  }).join('\n\n');
  const tools = job.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 64 || tools.some(tool => tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(tool.function.name))) throw new Error('Browser tools must be named function definitions.');
  if (job.tool_choice !== undefined && !['auto', 'none', 'required'].includes(job.tool_choice) && !(job.tool_choice && typeof job.tool_choice === 'object' && job.tool_choice.type === 'function' && typeof job.tool_choice.function?.name === 'string')) throw new Error('Unsupported browser tool choice.');
  let prompt = `Continue the following conversation and answer the latest user request. Earlier messages are context. Do not repeat the transcript. This browser relay cannot change the website's selected model.\n\n${transcript}`;
  if (tools.length && job.tool_choice !== 'none') {
    const required = typeof job.tool_choice === 'object' ? job.tool_choice?.function?.name : null;
    if (required && !tools.some(tool => tool.function.name === required)) throw new Error('Requested tool is not available.');
    prompt += `\n\nAVAILABLE APPLICATION TOOLS\n${JSON.stringify(tools.map(tool => tool.function))}\n\nThese tools are executed by the local application after its own checks and approvals, never by this website. Do not claim execution before receiving a tool result.\n\nRESPONSE FORMAT FOR THIS TURN\nReturn exactly one raw JSON object as your entire response. Start with { and end with }. Do not wrap it in a Markdown code block, add a language label, or write any text before or after it. This format also applies to progress updates requested earlier in the conversation: put any explanation or progress text inside the content field.\nTo request tools, use this shape: {"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"allowed_tool_name","arguments":{}}}]}. Replace allowed_tool_name with a declared tool name and supply arguments matching its parameter schema. Use a unique id for every call. The arguments field is a JSON object, not JavaScript or a shell command string. Request only the next actions needed, then wait for their tool results.\nWhen no tool is needed, use {"content":"Your answer to the user.","tool_calls":[]}. Never present a tool call as a quoted example or surround it with narrative.${required ? ` The requested next tool is ${required}.` : job.tool_choice === 'required' ? ' A tool call is required for this response.' : ''}`;
  }
  if (prompt.length > 120000) throw new Error('Conversation is too large for the browser connector (120,000 characters). Start a new conversation or use a direct API.');
  return prompt;
}

export function parseSiteResult(text, tools = [], toolChoice) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The website returned no assistant text.');
  if (text.length > 200000) throw new Error('The website response exceeded the 200,000-character limit.');
  if (!tools.length || toolChoice === 'none') return { role: 'assistant', content: text };
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)```$/i.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed.startsWith('{') ? trimmed : '';
  let payload;
  if (/"tool_calls"\s*:/.test(body)) {
    try { payload = JSON.parse(body); }
    catch { throw new Error('The website returned malformed tool-call JSON. No tool call was accepted. Retry or use a direct API with native tools.'); }
  }
  if (!payload) {
    if (/"tool_calls"\s*:/.test(text)) throw new Error('The website mixed tool-call JSON with other text. Tool calls must be the entire response as one JSON object or fenced block; put explanations inside its content field. No tool call was accepted from this response. Retry from the app, or use a provider with native tool support.');
    if (toolChoice === 'required' || typeof toolChoice === 'object') throw new Error('The website did not return the requested structured tool call.');
    return { role: 'assistant', content: text };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['content', 'tool_calls'].includes(key)) || !Array.isArray(payload.tool_calls) || payload.tool_calls.length > 16) throw new Error('Invalid browser tool-call response.');
  const allowed = new Set(tools.map(tool => tool.function.name)), ids = new Set();
  const calls = payload.tool_calls.map((call, index) => {
    if (!call || call.type !== 'function' || !allowed.has(call.function?.name)) throw new Error('The website requested an undeclared tool. No tool call was accepted.');
    const required = typeof toolChoice === 'object' ? toolChoice.function?.name : null;
    if (required && call.function.name !== required) throw new Error('The website returned a different tool from the requested one.');
    let args;
    try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; }
    catch { throw new Error('Browser tool arguments are not valid JSON.'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Browser tool arguments must be a JSON object.');
    const identifier = typeof call.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(call.id) ? call.id : `web_call_${index + 1}`;
    if (ids.has(identifier)) throw new Error('Browser tool call IDs must be unique.'); ids.add(identifier);
    return { id: identifier, type: 'function', function: { name: call.function.name, arguments: JSON.stringify(args) } };
  });
  if (!calls.length && (toolChoice === 'required' || typeof toolChoice === 'object')) throw new Error('The website returned no required tool call.');
  if (payload.content !== undefined && payload.content !== null && typeof payload.content !== 'string') throw new Error('Browser response content must be text.');
  const content = payload.content ?? null;
  if (!calls.length && !content?.trim()) throw new Error('The website returned an empty tool envelope.');
  return { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) };
}
