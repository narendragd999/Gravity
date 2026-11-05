export const LOGIN_EVENT_PREFIX = 'GRAVITY_LOGIN_EVENT ';
export const LOGIN_STAGES = Object.freeze(['opening-browser', 'waiting-for-sign-in', 'waiting-for-browser-close', 'releasing-profile', 'opening-profile', 'navigating', 'checking-session', 'saving-session', 'starting-service', 'discovering-models', 'waiting-idle', 'restoring-service', 'complete']);
export const LOGIN_ERRORS = Object.freeze({
  browser_missing: ['Install or choose a supported Chrome or Edge browser.', 'choose-browser'],
  browser_launch_failed: ['The account browser could not open. Close its separate windows and try again.', 'open-account'],
  unsupported_platform: ['Normal account sign-in requires the Windows app.', 'inspect'],
  invalid_profile_directory: ['The saved account folder is linked or unavailable. Restore a regular private profile folder.', 'inspect'],
  profile_busy: ['The browser for this account is already open. Close that separate browser and try again.', 'open-account'],
  browser_closed_early: ['The browser reused an open account window. Close that separate browser and try again.', 'open-account'],
  browser_closed_abnormally: ['The account browser did not close normally. Reopen it and finish the sign-in check.', 'open-account'],
  browser_close_timeout: ['The account browser is still open. Finish signing in and close its separate windows.', 'open-account'],
  sign_in_required: ['The saved browser reopened a sign-in page. Finish signing in to this account.', 'open-account'],
  security_check_required: ['The website needs a security check. Complete it in the normal account browser.', 'open-account'],
  oauth_rejected: ['Google did not accept this sign-in browser. Reopen normal-browser sign-in or use Browser Connector.', 'open-account'],
  new_chat_required: ['The website restored an existing conversation. Open a new, empty chat in its account browser.', 'open-account'],
  draft_present: ['The website restored a draft. Save or clear it in the account browser, then try again.', 'open-account'],
  composer_unavailable: ['The website did not show a ready message box. Reopen the account or check diagnostics.', 'open-account'],
  navigation_failed: ['The saved account page could not load. Check the connection and reopen the account.', 'retry'],
  session_missing: ['No signed-in session was found in this account browser. Finish signing in and try again.', 'open-account'],
  session_invalid: ['This saved session could not be verified. Sign in again to refresh it.', 'open-account'],
  auth_expired: ['This website session expired or lacks access. Sign in again.', 'open-account'],
  setup_save_failed: ['The checked session could not be saved. Check the private data folder and try again.', 'inspect'],
  setup_cancelled: ['Setup cancelled. Your saved website sign-ins are kept.', 'retry'],
  verification_failed: ['The saved sign-in check did not finish. Reopen the account or check diagnostics.', 'open-account'],
  service_stopped: ['Your saved website connection is stopped. Start it to continue.', 'start'],
  port_conflict: ['Another service is using this connection’s port. Check connection details before restarting.', 'inspect'],
  local_auth_conflict: ['The running local service rejected this connection key. Check which service is using its port.', 'inspect'],
  service_reload_required: ['This sign-in is saved, but a separately started service must restart to load it.', 'inspect'],
  model_discovery_failed: ['The service model list could not be read. Check connection details and try again.', 'inspect'],
  active_request: ['An account request is still running. Wait for it to finish before changing the connection.', 'wait'],
});
const sites = new Set(['chatgpt', 'zai', 'qwen', 'deepseek']);

export function loginFailure(code, stage, siteId) {
  const safeCode = Object.hasOwn(LOGIN_ERRORS, code) ? code : 'verification_failed';
  const error = new Error(LOGIN_ERRORS[safeCode][0]);
  error.status = 503; error.code = safeCode;
  error.stage = LOGIN_STAGES.includes(stage) ? stage : 'checking-session';
  error.siteId = sites.has(siteId) ? siteId : undefined;
  error.recoveryAction = LOGIN_ERRORS[safeCode][1];
  return error;
}

// Construct every field; helper text, URLs, cookies and account IDs are never forwarded.
export function normalizeLoginEvent(value) {
  if (!value || value.version !== 1 || !sites.has(value.siteId) || !LOGIN_STAGES.includes(value.stage)
    || !['progress', 'error', 'complete'].includes(value.type) || !Number.isFinite(value.timestamp)) return null;
  if (value.type === 'error' && !Object.hasOwn(LOGIN_ERRORS, value.code)) return null;
  const result = { version: 1, type: value.type, siteId: value.siteId, stage: value.stage, timestamp: value.timestamp };
  if (value.type === 'error') result.code = value.code;
  if (['chrome', 'msedge'].includes(value.browserChannel)) result.browserChannel = value.browserChannel;
  if (/^v?\d+(?:\.\d+){1,4}$/.test(value.runtimeVersion || '')) result.runtimeVersion = value.runtimeVersion;
  if (/^\d+(?:\.\d+){1,4}$/.test(value.browserVersion || '')) result.browserVersion = value.browserVersion;
  return result;
}

export function makeLoginReporter(siteId, { write = line => process.stdout.write(`${line}\n`), browserChannel, now = Date.now } = {}) {
  return (stage, type = 'progress', code, details = {}) => {
    const event = normalizeLoginEvent({ version: 1, type, siteId, stage, code, timestamp: now(), browserChannel, runtimeVersion: process.version, ...details });
    if (event) write(LOGIN_EVENT_PREFIX + JSON.stringify(event));
    return event;
  };
}
