// Serialized by chrome.scripting into the isolated world. Keep helpers inside this function.
export async function pageBridge(action, adapter, payload = {}) {
  if (location.protocol !== 'https:' || location.hostname !== adapter.host || location.port) throw new Error('This tab is no longer on the allowed chat website. Sign in in Chrome, then retry.');
  const visible = element => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (!document.hidden && !element.getClientRects().length && element.offsetWidth === 0 && element.offsetHeight === 0) return false;
    return true;
  };
  const elements = (selectors, root = document) => {
    for (const selector of selectors) {
      const matches = [...root.querySelectorAll(selector)].filter(visible);
      if (matches.length) return [...new Set(matches)];
    }
    return [];
  };
  const single = selectors => { const matches = elements(selectors); return matches.length >= 1 ? matches[0] : null; };
  const available = element => element && visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const composer = () => {
    for (const selector of adapter.composer) {
      for (const el of elements([selector])) {
        const editable = (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search'].includes(el.type)) || el.isContentEditable);
        if (editable && !el.readOnly && !el.disabled) return el;
        const child = el.querySelector?.('textarea, [contenteditable="true"], [contenteditable="plaintext-only"], input[type="text"]');
        if (child && visible(child) && !child.readOnly && !child.disabled) return child;
      }
    }
    return null;
  };
  const securityCheck = () => !!elements(['iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="recaptcha"][title*="challenge"]', 'iframe[title*="challenge" i]', '#challenge-running', '#challenge-stage', '#challenge-form', '[data-testid="challenge-page"]', '[data-testid="captcha"]']).length || /^(just a moment|verify you are human)/i.test(document.title.trim());
  const challenge = () => securityCheck() || /^access denied/i.test(document.title.trim());
  const siteError = () => challenge() ? `${adapter.name} requires a browser verification or sign-in. Complete it yourself in Chrome and retry.` : `${adapter.name} has no supported chat composer. Sign in in Chrome and open a new chat; if already signed in, the website layout may have changed.`;
  const busy = () => elements(adapter.stop).some(available);
  const jobs = globalThis.__antigravityStudioDOMJobs ??= new Map();
  if (action === 'probe') return { connected: !!composer() && !challenge(), busy: busy(), verificationRequired: securityCheck(), error: composer() && !challenge() ? undefined : siteError() };
  if (action === 'cancel') {
    const job = jobs.get(payload.id);
    if (job) { const button = single(adapter.stop); if (available(button)) button.click(); job.abort(new Error('The application cancelled this browser request.')); }
    return { cancelled: !!job };
  }
  if (action !== 'run' || typeof payload.prompt !== 'string' || typeof payload.id !== 'string' || payload.prompt.length > 120000) throw new Error('Invalid browser task.');
  if (jobs.size) throw new Error('This task tab is already processing a request.');
  const controller = new AbortController(); jobs.set(payload.id, controller);
  const { signal } = controller;
  const timeoutMs = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0 ? Math.min(160000, payload.timeoutMs) : 160000;
  const deadline = Math.min(Date.now() + timeoutMs, Number.isFinite(payload.deadlineAt) ? payload.deadlineAt : Infinity);
  const beforeSubmission = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('The browser request expired before submission. No prompt was submitted. Retry from the app.');
  };
  const sleep = milliseconds => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
  const humanInput = event => { if (event.isTrusted) controller.abort(new Error('You interacted with the task tab, so the connector stopped. Retry from the app when ready.')); };
  const navigated = () => controller.abort(new Error('The task tab navigated away or was closed.'));
  document.addEventListener('pointerdown', humanInput, true); document.addEventListener('keydown', humanInput, true); window.addEventListener('pagehide', navigated, { once: true });
  const normalized = value => String(value).replace(/\s+/g, ' ').trim();
  const renderText = node => {
    const walk = element => {
      if (element.nodeType === Node.TEXT_NODE) return element.textContent;
      if (element.nodeType !== Node.ELEMENT_NODE || element.matches('button,[role="button"],[aria-hidden="true"],script,style,time,.sr-only,.screen-reader-only,.visually-hidden,.ds-think,.ds-think-content,[class*="think-content"],[class*="thinking-content"],details.think,details.reasoning')) return '';
      const style = getComputedStyle(element);
      // Website wrappers can include a screen-reader duplicate of the response
      // and a timestamp. Neither belongs to the assistant's message body.
      if (element.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return '';
      if (['absolute', 'fixed'].includes(style.position) && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1 && (style.clip !== 'auto' || style.clipPath !== 'none' || style.overflow === 'hidden')) return '';
      if (!element.querySelector('pre') && element.parentElement?.querySelector('pre')) {
        const headerText = element.textContent.trim().toLowerCase();
        if (/^[a-z0-9_#-]{1,20}$/i.test(headerText) || element.querySelector('button,[role="button"]')) return '';
      }
      if (element.tagName === 'PRE') { const code = element.querySelector('code') || element; return '\n```\n' + code.textContent + '\n```\n'; }
      if (element.tagName === 'BR') return '\n';
      const text = [...element.childNodes].map(walk).join('');
      return /^(P|DIV|SECTION|ARTICLE|LI|H[1-6]|TR|BLOCKQUOTE)$/.test(element.tagName) ? `\n${text}\n` : text;
    };
    return walk(node).replace(/\n{3,}/g, '\n\n').trim();
  };
  try {
    beforeSubmission();
    let input; const composerDeadline = Math.min(deadline, Date.now() + 20000);
    while (!(input = composer()) && Date.now() < composerDeadline) { if (challenge()) throw new Error(siteError()); await sleep(300); }
    beforeSubmission();
    if (!input || challenge()) throw new Error(siteError());
    if (busy()) throw new Error('This fresh task tab is already generating. Wait for it to finish and retry.');
    const current = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT' ? input.value : input.innerText;
    if (current?.trim()) throw new Error('The website restored an existing draft in this new tab. The connector left it untouched. Clear that draft yourself and retry.');
    const original = new Set(elements(adapter.response));
    const originalUsers = new Set(elements(adapter.user || []));
    if (original.size || originalUsers.size) throw new Error('The website restored an existing conversation in this task tab. The connector left it untouched and did not read or submit its messages. Open a fresh chat and retry.');
    beforeSubmission(); input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, payload.prompt);
    } else {
      const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, payload.prompt)) input.replaceChildren(document.createTextNode(payload.prompt));
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: payload.prompt }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    const inserted = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT' ? input.value : input.innerText;
    if (normalized(inserted) !== normalized(payload.prompt)) throw new Error('The website did not accept the complete prompt. It was not submitted.');
    let send; const submitDeadline = Math.min(deadline, Date.now() + 8000);
    while (!available(send = single(adapter.send)) && Date.now() < submitDeadline) await sleep(200);
    beforeSubmission();
    if (available(send)) send.click();
    else if (adapter.enter && composer() === input) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } else throw new Error('A supported send control was not found. The connector did not click another control.');
    let prior = '', lastChanged = Date.now(), sawBusy = false, submitted = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const isBusy = busy(); sawBusy ||= isBusy;
      const remaining = input.isConnected ? (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT' ? input.value : input.innerText) : '';
      submitted ||= isBusy || (input.isConnected && !remaining?.trim()) || elements(adapter.user || []).some(node => !originalUsers.has(node));
      const candidates = elements(adapter.response).filter(node => !original.has(node) && !node.closest('[data-message-author-role="user"],[data-role="user"],.user-message'));
      const response = candidates.at(-1);
      const text = response ? renderText(response) : '';
      const norm = normalized(text);
      const promptNorm = normalized(payload.prompt);
      if (submitted && text && norm !== promptNorm && !(norm.length > 30 && promptNorm.includes(norm))) {
        if (text.length > 200000) throw new Error('The browser response exceeded the 200,000-character limit.');
        if (text !== prior) { prior = text; lastChanged = Date.now(); }
        const responseScope = response.closest('article,model-response,[data-testid="assistant-message"],[data-message-author-role="assistant"],.ds-message,.chat-message,[class*="message-assistant"]') || response.parentElement?.parentElement || response.parentElement;
        const finishedControl = !!elements(adapter.complete, responseScope || response).length;
        const stable = Date.now() - lastChanged >= 1800;
        const longStable = Date.now() - lastChanged >= 3500;
        if (!isBusy && ((sawBusy || finishedControl) ? stable : (longStable && prior.length > 0))) return { text: prior };
      }
      await sleep(300);
    }
    const stop = single(adapter.stop); if (available(stop)) stop.click();
    throw new Error('The website did not produce a verifiably completed assistant response in time. Partial text was not returned as a completed answer. Check the task tab or use a direct API.');
  } finally {
    jobs.delete(payload.id); document.removeEventListener('pointerdown', humanInput, true); document.removeEventListener('keydown', humanInput, true); window.removeEventListener('pagehide', navigated);
  }
}
