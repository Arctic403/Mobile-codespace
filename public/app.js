const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const KEY = 'mobileCodespace.v5';
const PORT = 4173;
const GH = 'https://api.github.com';
const LAUNCHER = 'https://arctic403.github.io/Mobile-codespace/';
const DIRECT = location.hostname.endsWith('.app.github.dev');

const S = {
  status: null,
  token: '',
  space: null,
  spaces: [],
  connected: false,
  dir: '',
  file: '',
  original: '',
  dirty: false,
  busy: false
};

const E = {
  ws: $('#workspaceLabel'), branch: $('#branchLabel'), codex: $('#codexLabel'), badge: $('#codexBadge'), dot: $('.status-dot'),
  files: $('#fileList'), crumbs: $('#breadcrumbs'), editor: $('#editor'), title: $('#editorTitle'), meta: $('#editorMeta'),
  save: $('#saveBtn'), dirty: $('#dirtyLabel'), term: $('#terminalOutput'), termIn: $('#terminalInput'), git: $('#gitCard'),
  gitOut: $('#gitOutput'), commit: $('#commitMessage'), prompt: $('#codexPrompt'), mode: $('#codexMode'), codexOut: $('#codexOutput'),
  codexRun: $('#codexRun'), port: $('#previewPort'), preview: $('#previewUrl'), toast: $('#toast'), sheet: $('#sheet'),
  screen: $('#connectionScreen'), conn: $('#connectionState'), connText: $('#connectionText'), token: $('#githubToken'),
  auto: $('#autoWake'), connect: $('#connectNow'), start: $('#startCodespace'), stop: $('#stopCodespace'),
  spaceSelect: $('#codespaceSelect'), refreshSpaces: $('#refreshCodespaces'), openGitHub: $('#openCodespaces'),
  forget: $('#forgetConnection'), closeConnection: $('#closeConnection'), connectionBtn: $('#connectionBtn')
};

function cfg() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function saveCfg(patch) {
  const next = { ...cfg(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backendFor = (name) => name ? `https://${name}-${PORT}.app.github.dev` : '';

function toast(message) {
  E.toast.textContent = message;
  E.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => E.toast.classList.remove('show'), 1800);
}

function conn(kind, text) {
  S.connected = kind === 'online';
  E.conn?.classList.toggle('online', S.connected);
  E.conn?.classList.toggle('error', kind === 'error');
  if (E.connText) E.connText.textContent = text;
  E.dot?.classList.toggle('offline', ['offline', 'error'].includes(kind));
  E.dot?.classList.toggle('connecting', kind === 'connecting');
  if (S.connected) E.dot?.classList.remove('offline', 'connecting');
}

const showConn = () => { if (E.screen) E.screen.hidden = false; };
const hideConn = () => { if (E.screen) E.screen.hidden = true; };
function busy(value) {
  S.busy = value;
  [E.connect, E.start, E.stop, E.refreshSpaces].forEach((el) => { if (el) el.disabled = value; });
}

async function gh(path, options = {}) {
  if (!S.token) throw new Error('GitHub token required');
  const response = await fetch(GH + path, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${S.token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `GitHub request failed (${response.status})`);
  return data;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function selectedSpace() {
  const name = E.spaceSelect?.value || cfg().codespaceName || '';
  return S.spaces.find((x) => x.name === name) || S.space || null;
}

function renderSpaces(preferred = '') {
  if (!E.spaceSelect) return;
  const current = preferred || E.spaceSelect.value || cfg().codespaceName || '';
  E.spaceSelect.innerHTML = '';
  if (!S.spaces.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No Codespaces found';
    E.spaceSelect.appendChild(opt);
    return;
  }
  for (const space of S.spaces) {
    const opt = document.createElement('option');
    opt.value = space.name;
    const repo = space.repository?.full_name || space.repository?.name || 'Unknown repo';
    opt.textContent = `${repo} — ${space.state || 'Unknown'}`;
    E.spaceSelect.appendChild(opt);
  }
  E.spaceSelect.value = S.spaces.some((x) => x.name === current) ? current : S.spaces[0].name;
}

async function refreshSpaceList({ quiet = false } = {}) {
  if (DIRECT) return [];
  S.token = E.token.value.trim();
  if (!S.token) throw new Error('Paste your fine-grained GitHub token first');
  if (!quiet) conn('connecting', 'Loading your Codespaces…');
  const data = await gh('/user/codespaces?per_page=100');
  S.spaces = (data.codespaces || []).sort((a, b) => String(b.last_used_at || b.created_at).localeCompare(String(a.last_used_at || a.created_at)));
  renderSpaces();
  const chosen = selectedSpace();
  if (chosen) {
    S.space = chosen;
    saveCfg({ token: S.token, codespaceName: chosen.name, auto: E.auto.checked });
    if (!quiet) conn('offline', `${chosen.repository?.full_name || chosen.name} is ${chosen.state || 'ready'}`);
  } else if (!quiet) conn('error', 'No Codespaces are visible to this token');
  return S.spaces;
}

async function getSpace(name) {
  return gh(`/user/codespaces/${encodeURIComponent(name)}`);
}

async function waitSpace(name) {
  for (let i = 0; i < 45; i++) {
    const x = await getSpace(name);
    S.space = x;
    conn('connecting', `${x.repository?.full_name || x.name}: ${x.state || 'starting'}…`);
    if (x.state === 'Available') return x;
    if (['Failed', 'Unavailable'].includes(x.state)) throw new Error(`Codespace is ${x.state}`);
    await sleep(3000);
  }
  throw new Error('Codespace did not become ready in time');
}

async function chooseFreshSpace() {
  await refreshSpaceList({ quiet: true });
  const x = selectedSpace();
  if (!x) throw new Error('Choose a Codespace first');
  S.space = x;
  saveCfg({ codespaceName: x.name });
  return x;
}

function enterPrivateWorkspace(space) {
  const url = backendFor(space.name);
  conn('connecting', 'Opening the private Mobile Bridge…');
  location.href = url;
}

async function wake() {
  if (DIRECT || S.busy) return;
  busy(true);
  try {
    S.token = E.token.value.trim();
    if (!S.token) throw new Error('Paste your fine-grained GitHub token first');
    saveCfg({ token: S.token, auto: E.auto.checked });
    let x = await chooseFreshSpace();
    if (x.state !== 'Available') {
      conn('connecting', `Starting ${x.repository?.full_name || x.name}…`);
      await gh(`/user/codespaces/${encodeURIComponent(x.name)}/start`, { method: 'POST' });
      x = await waitSpace(x.name);
    }
    saveCfg({ codespaceName: x.name });
    enterPrivateWorkspace(x);
  } catch (error) {
    conn('error', error.message);
    busy(false);
  }
}

async function connectOnly() {
  if (DIRECT || S.busy) return;
  busy(true);
  try {
    S.token = E.token.value.trim();
    if (!S.token) throw new Error('GitHub token required');
    const x = await chooseFreshSpace();
    if (x.state !== 'Available') throw new Error('That Codespace is asleep. Use Wake & open.');
    enterPrivateWorkspace(x);
  } catch (error) {
    conn('error', error.message);
    busy(false);
  }
}

async function stopCodespace() {
  if (DIRECT) {
    location.href = LAUNCHER;
    return;
  }
  if (S.busy) return;
  busy(true);
  try {
    S.token = E.token.value.trim() || S.token;
    const x = await chooseFreshSpace();
    conn('connecting', `Stopping ${x.repository?.full_name || x.name}…`);
    await gh(`/user/codespaces/${encodeURIComponent(x.name)}/stop`, { method: 'POST' });
    conn('offline', `${x.repository?.full_name || x.name} stopped.`);
    await refreshSpaceList({ quiet: true });
  } catch (error) {
    conn('error', error.message);
  } finally {
    busy(false);
  }
}

async function backendConnect(retries = 20) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const data = await api('/api/status');
      S.status = data;
      S.connected = true;
      E.ws.textContent = data.workspaceName || data.workspace;
      E.branch.textContent = data.git?.branch || '—';
      E.codex.textContent = data.codex || 'Codex missing';
      E.badge.textContent = data.codex ? 'ready' : 'missing';
      conn('online', `Connected to ${data.workspaceName || data.codespace}`);
      previewUrl();
      await loadDir(S.dir);
      hideConn();
      return data;
    } catch (error) {
      last = error;
      conn('connecting', 'Mobile Bridge is starting…');
      await sleep(1800);
    }
  }
  throw last || new Error('Mobile Bridge is not responding');
}

async function bootstrap() {
  if (DIRECT) {
    document.documentElement.dataset.mode = 'workspace';
    if (E.connectionBtn) E.connectionBtn.title = 'Back to Codespace launcher';
    conn('connecting', 'Connecting to private Mobile Bridge…');
    try {
      await backendConnect(25);
    } catch (error) {
      conn('error', `${error.message}. Pull/rebuild the target repo if this is the first run.`);
      showConn();
    }
    return;
  }

  document.documentElement.dataset.mode = 'launcher';
  const c = cfg();
  S.token = c.token || '';
  E.token.value = S.token;
  E.auto.checked = c.auto !== false;
  showConn();
  if (!S.token) {
    conn('offline', 'Paste your GitHub token, then load your Codespaces');
    return;
  }
  try {
    await refreshSpaceList({ quiet: true });
    if (c.codespaceName && S.spaces.some((x) => x.name === c.codespaceName)) E.spaceSelect.value = c.codespaceName;
    const x = selectedSpace();
    if (!x) return conn('offline', 'Choose a Codespace');
    S.space = x;
    if (c.auto !== false) return wake();
    conn('offline', `Ready: ${x.repository?.full_name || x.name}`);
  } catch (error) {
    conn('error', error.message);
  }
}

function panel(name) {
  $$('.panel').forEach((x) => x.classList.toggle('active', x.dataset.panel === name));
  $$('.nav-btn').forEach((x) => x.classList.toggle('active', x.dataset.target === name));
  if (name === 'git' && S.connected) refreshGit();
  if (name === 'preview') previewUrl();
}

const esc = (x) => String(x ?? '').replace(/[&<>'\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

async function loadDir(dir = '') {
  if (!S.connected) return;
  S.dir = dir;
  E.files.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
    renderCrumbs(dir);
    E.files.innerHTML = data.entries.length ? '' : '<div class="empty">This folder is empty.</div>';
    for (const x of data.entries) {
      const b = document.createElement('button');
      b.className = 'file-row';
      const ext = x.type === 'dir' ? 'DIR' : (x.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      b.innerHTML = `<span class="file-icon">${esc(ext)}</span><span class="file-name">${esc(x.name)}</span><span class="chev">${x.type === 'dir' ? '›' : ''}</span>`;
      b.onclick = () => x.type === 'dir' ? loadDir(x.path) : openFile(x.path);
      E.files.appendChild(b);
    }
  } catch (error) {
    E.files.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderCrumbs(dir) {
  const items = [{ name: S.status?.workspaceName || 'workspace', path: '' }];
  let cur = '';
  for (const name of (dir ? dir.split('/') : [])) {
    cur = cur ? `${cur}/${name}` : name;
    items.push({ name, path: cur });
  }
  E.crumbs.innerHTML = '';
  for (const c of items) {
    const b = document.createElement('button');
    b.className = 'crumb';
    b.textContent = c.name;
    b.onclick = () => loadDir(c.path);
    E.crumbs.appendChild(b);
  }
  requestAnimationFrame(() => { E.crumbs.scrollLeft = E.crumbs.scrollWidth; });
}

async function openFile(file) {
  if (S.dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(file)}`);
    S.file = file;
    S.original = data.content;
    S.dirty = false;
    E.editor.value = data.content;
    E.title.textContent = file.split('/').pop();
    E.meta.textContent = file;
    E.save.disabled = false;
    setDirty(false);
    panel('editor');
  } catch (error) { toast(error.message); }
}

function setDirty(value) {
  S.dirty = value;
  E.dirty.textContent = value ? 'Unsaved changes' : 'Saved';
  E.dirty.style.color = value ? 'var(--warn)' : '';
}

async function saveFile() {
  if (!S.file) return;
  E.save.disabled = true;
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: S.file, content: E.editor.value }) });
    S.original = E.editor.value;
    setDirty(false);
    toast('Saved');
    refreshGit();
  } catch (error) { toast(error.message); }
  finally { E.save.disabled = false; }
}

const fmt = (r) => [r.stdout?.trimEnd(), r.stderr?.trimEnd(), r.timedOut ? '[command timed out]' : '', r.truncated ? '[output truncated]' : ''].filter(Boolean).join('\n') || `[exit ${r.code ?? 'unknown'}]`;

async function cmd(command) {
  command = command.trim();
  if (!command || !S.connected) return;
  E.termIn.value = '';
  E.term.textContent = `$ ${command}\n…`;
  try {
    const data = await api('/api/command', { method: 'POST', body: JSON.stringify({ command, timeoutMs: 180000 }) });
    E.term.textContent = `$ ${command}\n${fmt(data.result)}`;
  } catch (error) { E.term.textContent = `$ ${command}\n${error.message}`; }
}

async function refreshGit() {
  if (!S.connected) return;
  try {
    const data = await api('/api/git/status');
    const g = data.git, changes = g.changes || [];
    E.branch.textContent = g.branch || '—';
    E.git.innerHTML = `<div class="git-summary"><strong>${esc(g.branch || '—')}</strong><span class="muted">${changes.length} change${changes.length === 1 ? '' : 's'}</span></div><div class="git-changes">${changes.length ? changes.slice(0, 80).map((c) => `<div class="git-change"><span class="git-code">${esc(c.code)}</span><span>${esc(c.path)}</span></div>`).join('') : '<div class="muted">Working tree clean.</div>'}</div>`;
  } catch (error) { E.git.innerHTML = `<div class="muted">${esc(error.message)}</div>`; }
}

async function gitAction(action) {
  if (!S.connected) return;
  E.gitOut.textContent = `Running ${action}…`;
  try {
    const data = await api('/api/git/action', { method: 'POST', body: JSON.stringify({ action, message: E.commit.value.trim() }) });
    E.gitOut.textContent = fmt(data.result);
    if (action === 'commit' && data.result.ok) E.commit.value = '';
    await refreshGit();
  } catch (error) { E.gitOut.textContent = error.message; }
}

async function runCodex() {
  if (!S.connected) return toast('Connect to a Codespace first');
  const prompt = E.prompt.value.trim();
  if (!prompt) return toast('Enter a Codex task');
  E.codexRun.disabled = true;
  E.codexOut.textContent = 'Codex is working…';
  try {
    const data = await api('/api/codex', { method: 'POST', body: JSON.stringify({ prompt, mode: E.mode.value }) });
    E.codexOut.textContent = fmt(data.result);
    await Promise.all([refreshGit(), loadDir(S.dir)]);
  } catch (error) { E.codexOut.textContent = error.message; }
  finally { E.codexRun.disabled = false; }
}

function previewUrl() {
  const p = Math.max(1, Math.min(65535, Number(E.port.value || 3000)));
  const name = S.status?.codespace || S.space?.name;
  const domain = S.status?.forwardingDomain || 'app.github.dev';
  const url = name ? `https://${name}-${p}.${domain}` : '';
  E.preview.textContent = url || 'Connect a Codespace first.';
  E.preview.dataset.url = url;
}

async function createEntry(kind) {
  if (!S.connected) return;
  E.sheet.hidden = true;
  const name = prompt(kind === 'folder' ? 'Folder name' : 'File name');
  if (!name) return;
  const p = S.dir ? `${S.dir}/${name}` : name;
  try {
    if (kind === 'folder') await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ path: p }) });
    else await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: p, content: '' }) });
    await loadDir(S.dir);
    if (kind === 'file') openFile(p);
  } catch (error) { toast(error.message); }
}

$$('.nav-btn').forEach((b) => { b.onclick = () => panel(b.dataset.target); });
$('#refreshBtn').onclick = () => DIRECT && S.connected ? Promise.all([backendConnect(1), loadDir(S.dir)]) : (DIRECT ? backendConnect(8).catch((e) => conn('error', e.message)) : refreshSpaceList().catch((e) => conn('error', e.message)));
if (E.connectionBtn) E.connectionBtn.onclick = () => DIRECT ? (location.href = LAUNCHER) : showConn();
$('#newBtn').onclick = () => { if (S.connected) E.sheet.hidden = false; else showConn(); };
$('#sheetCancel').onclick = () => { E.sheet.hidden = true; };
$('#newFile').onclick = () => createEntry('file');
$('#newFolder').onclick = () => createEntry('folder');
$('#editorBack').onclick = () => panel('files');
E.save.onclick = saveFile;
E.editor.oninput = () => setDirty(E.editor.value !== S.original);
E.editor.onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = E.editor.selectionStart, end = E.editor.selectionEnd;
    E.editor.setRangeText('  ', start, end, 'end');
    E.editor.dispatchEvent(new Event('input'));
  }
};
$('#copyBtn').onclick = async () => { await navigator.clipboard.writeText(E.editor.value); toast('Copied'); };
$('#terminalForm').onsubmit = (e) => { e.preventDefault(); cmd(E.termIn.value); };
$$('[data-command]').forEach((b) => { b.onclick = () => cmd(b.dataset.command); });
$('#clearTerminal').onclick = () => { E.term.textContent = ''; };
$('#gitRefresh').onclick = refreshGit;
$$('[data-git]').forEach((b) => { b.onclick = () => gitAction(b.dataset.git); });
E.codexRun.onclick = runCodex;
E.port.oninput = previewUrl;
$('#openPreview').onclick = () => { previewUrl(); if (E.preview.dataset.url) open(E.preview.dataset.url, '_blank', 'noopener'); };
if (E.connect) E.connect.onclick = connectOnly;
if (E.start) E.start.onclick = wake;
if (E.stop) E.stop.onclick = stopCodespace;
if (E.refreshSpaces) E.refreshSpaces.onclick = async () => {
  if (S.busy || DIRECT) return;
  busy(true);
  try { await refreshSpaceList(); } catch (error) { conn('error', error.message); } finally { busy(false); }
};
if (E.spaceSelect) E.spaceSelect.onchange = () => {
  const x = selectedSpace();
  if (!x) return;
  S.space = x;
  saveCfg({ codespaceName: x.name });
  conn('offline', `${x.repository?.full_name || x.name} selected — ${x.state || 'ready'}`);
};
if (E.closeConnection) E.closeConnection.onclick = () => DIRECT && S.connected ? hideConn() : (DIRECT ? (location.href = LAUNCHER) : hideConn());
if (E.openGitHub) E.openGitHub.onclick = () => open('https://github.com/codespaces', '_blank', 'noopener');
if (E.forget) E.forget.onclick = () => {
  if (DIRECT) { location.href = LAUNCHER; return; }
  localStorage.removeItem(KEY);
  S.token = '';
  S.spaces = [];
  E.token.value = '';
  renderSpaces();
  conn('offline', 'Saved connection removed from this device');
};

addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
if (!DIRECT) document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.token && cfg().auto !== false && cfg().codespaceName) wake();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('./sw.js', import.meta.url)).catch(() => {});

await bootstrap();
