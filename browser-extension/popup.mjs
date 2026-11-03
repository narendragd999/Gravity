const byId = id => document.getElementById(id);
let busy = false;
const labels = { disconnected: 'Not connected', connecting: 'Connecting to app…', approval: 'Approve in Antigravity Studio', connected: 'Connected to desktop app', offline: 'Desktop app is unavailable' };
function show(state) {
  byId('status').textContent = labels[state.connection] || state.connection;
  byId('dot').className = `dot ${state.connection}`;
  byId('detail').textContent = state.pairing ? 'A pairing request is waiting in the desktop app. Review and approve this Chrome extension there.' : state.activeJobs ? `${state.activeJobs} browser request${state.activeJobs === 1 ? '' : 's'} running in new task tabs.` : 'Open and sign in to a service, then choose its web alias in the app.';
  byId('connect').disabled = busy || state.paired || state.pairing || !!state.activeJobs;
  byId('connect').textContent = state.paired ? 'Connected' : 'Connect to app';
  byId('disconnect').hidden = !state.paired && !state.pairing;
  byId('error').hidden = !state.error; byId('error').textContent = state.error || '';
  const container = byId('sites'); container.replaceChildren();
  for (const site of state.sites || []) {
    const row = document.createElement('section'); row.className = 'site';
    const symbol = document.createElement('div'); symbol.className = 'site-symbol'; symbol.textContent = site.name.slice(0, 1);
    const copy = document.createElement('div'); copy.className = 'site-copy';
    const title = document.createElement('strong'); title.textContent = site.name;
    const status = document.createElement('small'); status.className = site.connected ? 'ready' : ''; status.textContent = site.busy ? 'Busy · loading or waiting' : site.connected ? `Tab detected · ${site.model}` : 'Open and sign in'; status.title = site.error || 'A detected chat input does not verify a completed reply. Use Test response in the desktop app.';
    const open = document.createElement('button'); open.textContent = 'Open / sign in'; open.addEventListener('click', () => act('open-site', { siteId: site.id }));
    copy.append(title, status); row.append(symbol, copy, open); container.append(row);
  }
}
async function act(type, extra = {}) {
  if (busy && type !== 'status') return;
  if (type !== 'status') busy = true;
  try {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Extension background service is unavailable.');
    show(result.data);
  } catch (error) { byId('error').hidden = false; byId('error').textContent = error.message; }
  finally { busy = false; }
}
byId('connect').addEventListener('click', () => act('connect'));
byId('disconnect').addEventListener('click', () => act('disconnect'));
byId('refresh').addEventListener('click', () => act('refresh'));
void act('status'); const timer = setInterval(() => { if (!busy) void act('status'); }, 1500);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
