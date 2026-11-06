// These decoders consume website network messages, never rendered page text.
export const RESPONSE_BYTES = 8 * 1024 * 1024;
export const OUTPUT_CHARACTERS = 200000;
export const bridgeError = (message, status = 502, code = 'website_error') => Object.assign(new Error(message), { status, code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const malformed = label => bridgeError(`${label} sent malformed event data. No completed answer was accepted.`, 502, 'malformed_response');

export function decodeEvents(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RESPONSE_BYTES) throw bridgeError('Website response exceeded the supported size.', 502, 'response_too_large');
  const blocks = raw.replace(/\r\n?/g, '\n').split('\n\n');
  // A partial final frame is not an SSE event, even when its JSON parses.
  if (blocks.at(-1).split('\n').some(line => line.startsWith('data:'))) throw malformed('The website');
  const events = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || ['ping', 'keepalive'].includes(name)) continue;
    if (events.length >= 65536 || Buffer.byteLength(data) > 1024 * 1024) throw bridgeError('Website response exceeded the supported event limits.', 502, 'response_too_large');
    if (data === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push({ value: JSON.parse(data) }); }
    catch { throw malformed('The website'); }
  }
  if (!events.length) throw bridgeError('The website did not return a supported event stream.');
  return events;
}

export function parseChatGPTStream(raw) {
  let message = null, done = false, priorPath, priorOperation;
  const snapshot = value => {
    if (!object(value) || !object(value.author) || typeof value.author.role !== 'string') throw malformed('ChatGPT');
    if (value?.author?.role === 'assistant') {
      if (!object(value.content)) throw malformed('ChatGPT');
      message = structuredClone(value);
    } else message = null;
  };
  const patch = (operation, pointer, value) => {
    if (typeof pointer !== 'string' || !['append', 'replace', 'add', 'remove'].includes(operation)) throw malformed('ChatGPT');
    if (pointer === '' || pointer === '/') {
      if (!object(value)) throw malformed('ChatGPT');
      snapshot(value.message || value); return;
    }
    if (pointer === '/message') { snapshot(value); return; }
    if (!pointer.startsWith('/message/')) return;
    const keys = pointer.slice('/message/'.length).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!['content', 'status', 'end_turn', 'channel', 'recipient'].includes(keys[0])) return;
    if (!message || keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw malformed('ChatGPT');
    let target = message;
    for (const key of keys.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !(key in target)) throw malformed('ChatGPT');
      target = target[key];
    }
    if (!target || typeof target !== 'object') throw malformed('ChatGPT');
    let key = keys.at(-1);
    if (Array.isArray(target)) {
      if (key === '-' && operation === 'add') key = String(target.length);
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > target.length || (operation !== 'add' && Number(key) === target.length)) throw malformed('ChatGPT');
    }
    if (operation === 'append') {
      if (typeof target[key] === 'string' && typeof value === 'string') target[key] += value;
      else if (Array.isArray(target[key]) && Array.isArray(value)) target[key].push(...value);
      else throw malformed('ChatGPT');
    } else if (operation === 'remove') {
      if (!(key in target)) throw malformed('ChatGPT');
      if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key];
    } else {
      if (operation === 'replace' && !(key in target)) throw malformed('ChatGPT');
      if (operation === 'add' && Array.isArray(target)) target.splice(Number(key), 0, structuredClone(value));
      else target[key] = structuredClone(value);
    }
    const parts = message.content?.parts;
    if (Array.isArray(parts) && parts.reduce((size, item) => size + (typeof item === 'string' ? item.length : 0), 0) > OUTPUT_CHARACTERS) throw bridgeError('ChatGPT response exceeded the supported size.', 502, 'response_too_large');
  };
  function apply(event) {
    if (Array.isArray(event)) { for (const item of event) apply(item); return; }
    if (!object(event)) throw malformed('ChatGPT');
    if (event.error || event.type === 'error') throw bridgeError('ChatGPT returned an error. Check the login browser and account limits.');
    if (event.message) { snapshot(event.message); return; }
    if (event.v?.message) snapshot(event.v.message);
    else if (event.v?.author) snapshot(event.v);
    if (event.o === 'patch' || event.op === 'patch' || (Array.isArray(event.v) && event.o === undefined)) {
      if (!Array.isArray(event.v ?? event.value)) throw malformed('ChatGPT');
      for (const item of event.v ?? event.value) apply(item);
      return;
    }
    if (event.p !== undefined || event.path !== undefined || event.o !== undefined || event.op !== undefined || Object.hasOwn(event, 'v')) {
      const pointer = event.p ?? event.path ?? (event.v?.message ? '' : event.v?.author ? '/message' : priorPath);
      const operation = event.o ?? event.op ?? (event.v?.message || event.v?.author ? 'replace' : priorOperation);
      if (pointer !== undefined && operation !== undefined) {
        priorPath = pointer; priorOperation = operation;
        patch(operation, pointer, Object.hasOwn(event, 'v') ? event.v : event.value);
      }
    }
  }
  for (const event of decodeEvents(raw)) {
    if (event.done) { done = true; continue; }
    if (done) throw malformed('ChatGPT');
    apply(event.value);
  }
  const final = message && (!message.channel || message.channel === 'final') && (!message.recipient || message.recipient === 'all') && message.content?.content_type === 'text';
  const content = final && Array.isArray(message.content.parts) && message.content.parts.every(part => typeof part === 'string') ? message.content.parts.join('') : '';
  if (!done || !content.trim() || content.length > OUTPUT_CHARACTERS || !(message?.end_turn === true || message?.status === 'finished_successfully')) {
    throw bridgeError('ChatGPT did not return a completed final answer in a supported network format. No partial reply was accepted.', 502, 'incomplete_response');
  }
  return content;
}

// The pinned Z.ai protocol reference folds snapshots and UTF-16 edits into one
// raw string. Older replies carry reasoning inside <details> blocks. The public
// production frontend prod-fe-1.1.128 also defines thinking/answer phases; track
// their raw positions so edits still use website offsets. Split after edits.
// Reference: glm-proxy cc8165b675af2db10fb6ae85aa01cf33568c2e46,
// internal/zbridge/zai.go and sse_reasoning_test.go; public frontend provenance
// is in ../THIRD_PARTY.md. No live account capture is implied.
function zaiLiteralEnd(raw, index, limit = raw.length) {
  // JSON strings and Markdown examples can contain literal HTML. Never change
  // tool arguments, or confuse a quoted tag with a provider channel delimiter.
  // Lexical context from thinking cannot extend into a later answer phase.
  if (limit < raw.length) raw = raw.slice(0, limit);
  if (raw[index] === '"') {
    let end = index + 1;
    while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
    if (end < raw.length) return end + 1;
  }
  if (raw[index] === '`' || raw[index] === '~') {
    const marker = raw[index]; let count = 1;
    while (raw[index + count] === marker) count++;
    const lineStart = raw.lastIndexOf('\n', index - 1) + 1;
    if (count >= 3 && /^ {0,3}$/.test(raw.slice(lineStart, index))) {
      const closing = new RegExp(`^ {0,3}${marker}{${count},}[^${marker}\\S]*$`, 'gm');
      closing.lastIndex = index + count;
      const match = closing.exec(raw);
      return match ? match.index + match[0].length : raw.length;
    }
    if (marker === '`') {
      const delimiter = marker.repeat(count); let end = raw.indexOf(delimiter, index + count);
      while (end >= 0 && (raw[end - 1] === marker || raw[end + count] === marker)) end = raw.indexOf(delimiter, end + count);
      if (end >= 0) return end + count;
    }
  }
  return index;
}

function zaiDetailsEnd(raw, index, reasoning) {
  let depth = 1, spanEnd = index;
  while (index < raw.length) {
    if (index >= spanEnd) spanEnd = zaiPhaseSpanEnd(raw, reasoning, index);
    const literal = zaiLiteralEnd(raw, index, spanEnd);
    if (literal > index) { index = literal; continue; }
    const tag = /^(?:<details\b[^>]*>|<\/details\s*>)/i.exec(raw.slice(index));
    if (tag) {
      depth += /^<\//.test(tag[0]) ? -1 : 1;
      index += tag[0].length;
      if (!depth) return index;
    } else index++;
  }
}

function zaiPhaseSpanEnd(raw, reasoning, index) {
  if (!reasoning) return raw.length;
  let end = index + 1;
  while (end < raw.length && reasoning[end] === reasoning[index]) end++;
  return end;
}

function zaiAnswerChannel(raw, reasoning) {
  let answer = '', index = 0, spanEnd = 0, leadingReasoning = false;
  const append = (start, end) => {
    if (!reasoning) { answer += raw.slice(start, end); return; }
    while (start < end) {
      while (start < end && reasoning[start]) start++;
      const from = start;
      while (start < end && !reasoning[start]) start++;
      answer += raw.slice(from, start);
    }
  };
  while (index < raw.length) {
    if (index >= spanEnd) spanEnd = zaiPhaseSpanEnd(raw, reasoning, index);
    const literal = zaiLiteralEnd(raw, index, spanEnd);
    if (literal > index) { append(index, literal); index = literal; continue; }
    const opener = /^<details\b[^>]*>/i.exec(raw.slice(index));
    if (opener) {
      const explicit = /\btype\s*=\s*(["'])reasoning\1/i.test(opener[0]);
      const bare = /^<details\s*>$/i.test(opener[0]);
      // Ordinary expandable answer HTML keeps its summary and body. Bare
      // provider wrappers without a summary are the verified reasoning shape.
      const summary = /^\s*<summary\b/i.test(raw.slice(index + opener[0].length));
      if (explicit || (bare && !summary)) {
        const close = zaiDetailsEnd(raw, index + opener[0].length, reasoning);
        // Explicit thinking can quote an unfinished HTML example. Its masked
        // text must not consume a later answer, or become an answer itself.
        if (close === undefined && reasoning?.[index]) {
          while (index < raw.length && reasoning[index]) index++;
          continue;
        }
        if (close === undefined) throw bridgeError('Z.ai ended inside its reasoning block. No partial answer was accepted.', 502, 'incomplete_response');
        if (reasoning?.[index]) {
          const closingStart = close - /<\/details\s*>$/i.exec(raw.slice(index, close))[0].length;
          for (let cursor = index + opener[0].length; cursor < closingStart; cursor++) {
            if (!reasoning[cursor] && !/\s/.test(raw[cursor])) throw bridgeError('Z.ai returned an ambiguous reasoning boundary. No answer or tool call was accepted.', 502, 'unsupported_response_format');
          }
        }
        if (!answer.trim()) { leadingReasoning = true; answer = ''; }
        index = close; continue;
      }
      const close = zaiDetailsEnd(raw, index + opener[0].length, reasoning) ?? raw.length;
      append(index, close); index = close; continue;
    }
    append(index, index + 1); index++;
  }
  return leadingReasoning ? answer.trimStart() : answer;
}

export function parseZaiStream(raw) {
  let text = '', completed = false, terminated = false, phase, channel;
  const reasoning = new Uint8Array(OUTPUT_CHARACTERS);
  const unsupported = () => bridgeError('Z.ai returned an unsupported response channel. No answer or tool call was accepted.', 502, 'unsupported_response_format');
  for (const event of decodeEvents(raw)) {
    if (event.done) { terminated = true; continue; }
    if (terminated) throw malformed('Z.ai');
    const value = event.value;
    if (!object(value)) throw malformed('Z.ai');
    if (value.type === 'error' || value?.error || value?.data?.error || value?.data?.data?.error) throw bridgeError('Z.ai returned an error. Check the login browser and account limits.');
    const data = value?.data;
    if (data === undefined) continue;
    if (!object(data)) throw malformed('Z.ai');
    // Source/status/citation events have their own data; only completions can
    // supply an answer or mark it complete in the public frontend.
    if (value.type !== undefined && value.type !== 'chat:completion') continue;
    if (Object.hasOwn(data, 'scope')) {
      if (typeof data.scope !== 'string') throw malformed('Z.ai');
      if (data.scope !== 'legacy') throw unsupported();
    }
    if (Object.hasOwn(data, 'done') && typeof data.done !== 'boolean') throw malformed('Z.ai');
    if (data.phase === 'done' && data.done === false) throw malformed('Z.ai');
    // Website tools and structured agent snapshots have separate frontend
    // decoders. Never silently discard them and accept a stale text result.
    if (Object.hasOwn(value, 'version') || Object.hasOwn(data, 'version') || Object.hasOwn(data, 'message_version') || Object.hasOwn(data, 'content_blocks') || Object.hasOwn(data, 'tool_calls') || Object.hasOwn(data, 'function_call') || data.delta_name || data.delta_arguments || data.metadata?.tool_call_id) throw unsupported();
    const contentFields = ['edit_content', 'content', 'delta_content'].filter(key => Object.hasOwn(data, key));
    if (contentFields.some(key => typeof data[key] !== 'string') || contentFields.length > 1) throw malformed('Z.ai');
    const priorPhase = phase;
    if (Object.hasOwn(data, 'phase')) {
      if (typeof data.phase !== 'string') throw malformed('Z.ai');
      phase = data.phase;
    }
    if (Object.hasOwn(data, 'channel')) {
      if (typeof data.channel !== 'string') throw malformed('Z.ai');
      channel = data.channel;
    }
    // Only the production frontend's verified answer/thinking phases are
    // accepted. A completion marker does not reclassify prior thinking.
    const contentPhase = phase === 'done' ? priorPhase : phase;
    if (channel !== undefined || (phase !== undefined && !['answer', 'thinking', 'done'].includes(phase))) throw unsupported();
    if (completed && contentFields.length) throw malformed('Z.ai');
    if (contentFields.length) {
      const field = contentFields[0];
      const index = field === 'edit_content' ? data.edit_index ?? 0 : field === 'delta_content' ? text.length : 0;
      if (!Number.isInteger(index) || index < 0 || index > text.length || (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]))) throw bridgeError('Z.ai returned an invalid content edit.', 502, 'malformed_response');
      const replacement = data[field];
      const next = text.slice(0, index) + replacement;
      if (next.length > OUTPUT_CHARACTERS) throw bridgeError('Z.ai response exceeded the supported size.', 502, 'response_too_large');
      // Unchanged prefixes in full snapshots/replayed edits retain their
      // channel. Repeating earlier thinking in an answer snapshot cannot leak
      // that thinking, or reinterpret its tool-call examples as actions.
      let unchanged = 0;
      while (contentPhase !== 'thinking' && index + unchanged < text.length && unchanged < replacement.length && text[index + unchanged] === replacement[unchanged]) unchanged++;
      // A shared prefix ending inside previous thinking cannot establish
      // whether this is a cumulative edit or a phase-local snapshot. Returning
      // only its changed suffix would corrupt the answer; reject the ambiguity.
      if (unchanged && unchanged < replacement.length && index + unchanged < text.length && reasoning[index + unchanged]) throw unsupported();
      if (unchanged && /[\uD800-\uDBFF]/.test(replacement[unchanged - 1]) && /[\uDC00-\uDFFF]/.test(replacement[unchanged])) unchanged--;
      reasoning.fill(contentPhase === 'thinking' ? 1 : 0, index + unchanged, next.length);
      text = next;
    }
    if (data.phase === 'done' || data.done === true) completed = true;
  }
  text = zaiAnswerChannel(text, reasoning);
  if (!completed || !text.trim()) throw bridgeError('Z.ai did not return a completed answer. No partial reply was accepted.', 502, 'incomplete_response');
  return text;
}
