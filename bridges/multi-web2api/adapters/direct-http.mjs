// Shared transport for the direct web adapters. Upstream bodies never enter errors.
export function adapterError(provider, status, code, detail) {
  return Object.assign(new Error(`${provider}: ${detail}`), { status, code });
}

export function requestSignal(signal, timeoutMs = 180_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function requireToken(token, provider) {
  if (typeof token !== 'string' || !token.trim()) {
    throw adapterError(provider, 401, 'authentication_required', 'configure your web session token first.');
  }
  // Tokens are opaque header/cookie values, never whole pasted request headers.
  if (token.length > 16384 || /[\s;\x00-\x1f\x7f]/.test(token)) {
    throw adapterError(provider, 400, 'invalid_token', 'the configured session token has an invalid format.');
  }
  return token;
}

export async function send(fetchImpl, url, options, provider) {
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error' });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      const status = [401, 403, 429].includes(response.status) ? response.status : 502;
      const code = status === 429 ? 'rate_limited' : status === 401 ? 'authentication_required' : status === 403 ? 'verification_required' : 'upstream_error';
      const message = status === 429 ? 'the website rate limit was reached; try again later.'
        : status === 401 ? 'the web session expired; sign in again.'
          : status === 403 ? 'the website requires access verification; open the website and complete it.'
            : `the website returned HTTP ${response.status}.`;
      throw adapterError(provider, status, code, message);
    }
    return response;
  } catch (error) {
    if (error?.status && error?.code) throw error;
    if (options.signal?.aborted) throw adapterError(provider, 504, 'request_aborted', 'the request was cancelled or timed out.');
    throw adapterError(provider, 502, 'upstream_unavailable', 'the website request failed; check the connection and session.');
  }
}

async function* responseChunks(response, provider, signal, maxBytes) {
  if (!response.body) throw adapterError(provider, 502, 'invalid_response', 'the website returned no response body.');
  const reader = response.body.getReader();
  let total = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw adapterError(provider, 504, 'request_aborted', 'the request was cancelled or timed out.');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw adapterError(provider, 504, 'request_aborted', 'the request was cancelled or timed out.');
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw adapterError(provider, 502, 'response_too_large', 'the website response exceeded the bridge limit.');
      yield value;
    }
  } catch (error) {
    if (error?.status && error?.code) throw error;
    if (signal?.aborted) throw adapterError(provider, 504, 'request_aborted', 'the request was cancelled or timed out.');
    throw adapterError(provider, 502, 'response_incomplete', 'the website stream ended unexpectedly.');
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJson(response, provider, signal) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('json')) {
    await response.body?.cancel().catch(() => {});
    throw adapterError(provider, 403, 'verification_required', 'the website returned a verification page; open it and complete verification.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  try {
    for await (const chunk of responseChunks(response, provider, signal, 2 * 1024 * 1024)) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error?.status && error?.code) throw error;
    throw adapterError(provider, 502, 'invalid_response', 'the website returned invalid JSON.');
  }
}

export async function* readSse(response, provider, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const parse = block => {
    let event = null;
    const lines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!lines.length) return null;
    const raw = lines.join('\n');
    if (raw === '[DONE]') return { event, data: raw };
    try { return { event, data: JSON.parse(raw) }; } catch {
      throw adapterError(provider, 502, 'invalid_response', 'the website returned an invalid stream event.');
    }
  };
  try {
    for await (const chunk of responseChunks(response, provider, signal, 8 * 1024 * 1024)) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > 1_000_000) throw adapterError(provider, 502, 'response_too_large', 'the website stream event exceeded the bridge limit.');
        const event = parse(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) yield event;
      }
      if (buffer.length > 1_000_000) throw adapterError(provider, 502, 'response_too_large', 'the website stream event exceeded the bridge limit.');
    }
    buffer += decoder.decode();
    if (buffer.split(/\r?\n/).some(line => line.trim() && !line.startsWith(':'))) throw adapterError(provider, 502, 'response_incomplete', 'the website stream ended within an event.');
  } catch (error) {
    if (error?.status && error?.code) throw error;
    throw adapterError(provider, 502, 'invalid_response', 'the website returned an invalid UTF-8 stream.');
  }
}
