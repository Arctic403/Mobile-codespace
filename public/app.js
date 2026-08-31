const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  status: null,
  currentDir: '',
  currentFile: '',
  originalContent: '',
  dirty: false,
  terminalHistory: [],
  terminalHistoryIndex: 0
};

const els = {
  workspaceLabel: $('#workspaceLabel'),
  branchLabel: $('#branchLabel'),
  codexLabel: $('#codexLabel'),
  codexBadge: $('#codexBadge'),
  fileList: $('#fileList'),
  breadcrumbs: $('#breadcrumbs'),
  editor: $('#editor'),
  editorTitle: $('#editorTitle'),
  editorMeta: $('#editorMeta'),
  saveBtn: $('#saveBtn'),
  dirtyLabel: $('#dirtyLabel'),
  terminalOutput: $('#terminalOutput'),
  terminalInput: $('#terminalInput'),
  gitCard: $('#gitCard'),
  gitOutput: $('#gitOutput'),
  commitMessage: $('#commitMessage'),
  codexPrompt: $('#codexPrompt'),
  codexMode: $('#codexMode'),
  codexOutput: $('#codexOutput'),
  codexRun: $('#codexRun'),
  previewPort: $('#previewPort'),
  previewUrl: $('#previewUrl'),
  toast: $('#toast'),
  sheet: $('#sheet')
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function activatePanel(name) {
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
  $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.target === name));
  if (name === 'git') refreshGit();
  if (name === 'preview') updatePreviewUrl();
}

function fmtOutput(result) {
  const parts = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push(result.stderr.trimEnd());
  if (result.timedOut) parts.push('[command timed out]');
  if (result.truncated) parts.push('[output truncated]');
  if (!parts.length) parts.push(`[exit ${result.code ?? 'unknown'}]`);
  return parts.join('\n');
}

async function refreshStatus() {
  try {
    const data = await request('/api/status');
    state.status = data;
    els.workspaceLabel.textContent = data.workspaceName || data.workspace;
    els.branchLabel.textContent = data.git?.branch || '—';
    const codex = data.codex || 'Codex not installed';
    els.codexLabel.textContent = codex;
    els.codexBadge.textContent = data.codex ? 'ready' : 'missing';
    els.codexBadge.style.color = data.codex ? 'var(--good)' : 'var(--warn)';
    updatePreviewUrl();
  } catch (error) {
    els.workspaceLabel.textContent = 'Connection failed';
    showToast(error.message);
  }
}

async function loadDir(dir = '') {
  state.currentDir = dir;
  els.fileList.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await request(`/api/tree?path=${encodeURIComponent(dir)}`);
    renderBreadcrumbs(dir);
    if (!data.entries.length) {
      els.fileList.innerHTML = '<div class="empty">This folder is empty.</div>';
      return;
    }
    els.fileList.innerHTML = '';
    for (const entry of data.entries) {
      const row = document.createElement('button');
      row.className = 'file-row';
      const ext = entry.type === 'dir' ? 'DIR' : (entry.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      row.innerHTML = `<span class="file-icon">${escapeHtml(ext)}</span><span class="file-name">${escapeHtml(entry.name)}</span><span class="chev">${entry.type === 'dir' ? '›' : ''}</span>`;
      row.addEventListener('click', () => entry.type === 'dir' ? loadDir(entry.path) : openFile(entry.path));
      els.fileList.appendChild(row);
    }
  } catch (error) {
    els.fileList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderBreadcrumbs(dir) {
  const parts = dir ? dir.split('/') : [];
  const crumbs = [{ name: state.status?.workspaceName || 'workspace', path: '' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, path: acc });
  }
  els.breadcrumbs.innerHTML = '';
  crumbs.forEach((crumb) => {
    const btn = document.createElement('button');
    btn.className = 'crumb';
    btn.textContent = crumb.name;
    btn.addEventListener('click', () => loadDir(crumb.path));
    els.breadcrumbs.appendChild(btn);
  });
  requestAnimationFrame(() => { els.breadcrumbs.scrollLeft = els.breadcrumbs.scrollWidth; });
}

async function openFile(file) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  try {
    const data = await request(`/api/file?path=${encodeURIComponent(file)}`);
    state.currentFile = file;
    state.originalContent = data.content;
    state.dirty = false;
    els.editor.value = data.content;
    els.editorTitle.textContent = file.split('/').pop();
    els.editorMeta.textContent = file;
    els.saveBtn.disabled = false;
    setDirty(false);
    activatePanel('editor');
    requestAnimationFrame(() => els.editor.scrollTo(0, 0));
  } catch (error) {
    showToast(error.message);
  }
}

function setDirty(value) {
  state.dirty = value;
  els.dirtyLabel.textContent = value ? 'Unsaved changes' : 'Saved';
  els.dirtyLabel.style.color = value ? 'var(--warn)' : '';
}

async function saveFile() {
  if (!state.currentFile) return;
  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Saving…';
  try {
    await request('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path: state.currentFile, content: els.editor.value })
    });
    state.originalContent = els.editor.value;
    setDirty(false);
    showToast('Saved');
    refreshGit();
  } catch (error) {
    showToast(error.message);
  } finally {
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save';
  }
}

async function runCommand(command) {
  const clean = command.trim();
  if (!clean) return;
  state.terminalHistory.push(clean);
  state.terminalHistoryIndex = state.terminalHistory.length;
  els.terminalInput.value = '';
  const before = els.terminalOutput.textContent.trim() === 'Run a command inside the Codespace.' ? '' : els.terminalOutput.textContent;
  els.terminalOutput.textContent = `${before}${before ? '\n\n' : ''}$ ${clean}\n…`;
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
  try {
    const data = await request('/api/command', {
      method: 'POST',
      body: JSON.stringify({ command: clean, timeoutMs: 180000 })
    });
    els.terminalOutput.textContent = `${before}${before ? '\n\n' : ''}$ ${clean}\n${fmtOutput(data.result)}`;
  } catch (error) {
    els.terminalOutput.textContent = `${before}${before ? '\n\n' : ''}$ ${clean}\n${error.message}`;
  }
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
  refreshStatus();
}

async function refreshGit() {
  try {
    const data = await request('/api/git/status');
    renderGit(data.git);
    els.branchLabel.textContent = data.git.branch || '—';
  } catch (error) {
    els.gitCard.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  }
}

function renderGit(git) {
  const changes = git.changes || [];
  els.gitCard.innerHTML = `
    <div class="git-summary"><strong>${escapeHtml(git.branch || '—')}</strong><span class="muted">${changes.length} change${changes.length === 1 ? '' : 's'}</span></div>
    <div class="muted" style="font-size:11px;overflow-wrap:anywhere">${escapeHtml(git.tracking || git.remote || 'No remote tracking info')}</div>
    <div class="git-changes">${changes.length ? changes.slice(0, 80).map((c) => `<div class="git-change"><span class="git-code">${escapeHtml(c.code)}</span><span>${escapeHtml(c.path)}</span></div>`).join('') : '<div class="muted" style="font-size:12px">Working tree clean.</div>'}</div>`;
}

async function gitAction(action) {
  const message = els.commitMessage.value.trim();
  els.gitOutput.textContent = `Running ${action}…`;
  try {
    const data = await request('/api/git/action', {
      method: 'POST',
      body: JSON.stringify({ action, message })
    });
    els.gitOutput.textContent = fmtOutput(data.result);
    renderGit(data.git);
    if (action === 'commit' && data.result.ok) els.commitMessage.value = '';
    refreshStatus();
  } catch (error) {
    els.gitOutput.textContent = error.message;
  }
}

async function runCodex() {
  const prompt = els.codexPrompt.value.trim();
  if (!prompt) return showToast('Enter a Codex task');
  els.codexRun.disabled = true;
  els.codexRun.textContent = 'Running…';
  els.codexOutput.textContent = 'Codex is working inside the Codespace…';
  try {
    const data = await request('/api/codex', {
      method: 'POST',
      body: JSON.stringify({ prompt, mode: els.codexMode.value })
    });
    els.codexOutput.textContent = fmtOutput(data.result);
    if (!data.result.ok) els.codexOutput.textContent += `\n\nIf this is an auth error, run "codex login" in Terminal first.`;
    await Promise.all([refreshGit(), refreshStatus(), loadDir(state.currentDir)]);
  } catch (error) {
    els.codexOutput.textContent = error.message;
  } finally {
    els.codexRun.disabled = false;
    els.codexRun.textContent = 'Run Codex';
  }
}

function updatePreviewUrl() {
  if (!state.status) return;
  const p = Math.max(1, Math.min(65535, Number(els.previewPort.value || 3000)));
  if (state.status.codespace) {
    const url = `https://${state.status.codespace}-${p}.${state.status.forwardingDomain || 'app.github.dev'}`;
    els.previewUrl.textContent = url;
    els.previewUrl.dataset.url = url;
  } else {
    const url = `${location.protocol}//${location.hostname}:${p}`;
    els.previewUrl.textContent = url;
    els.previewUrl.dataset.url = url;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function openCreateSheet() { els.sheet.hidden = false; }
function closeCreateSheet() { els.sheet.hidden = true; }

async function createEntry(kind) {
  closeCreateSheet();
  const name = prompt(kind === 'folder' ? 'Folder name' : 'File name');
  if (!name) return;
  const rel = state.currentDir ? `${state.currentDir}/${name}` : name;
  try {
    if (kind === 'folder') {
      await request('/api/mkdir', { method: 'POST', body: JSON.stringify({ path: rel }) });
      await loadDir(state.currentDir);
    } else {
      await request('/api/file', { method: 'PUT', body: JSON.stringify({ path: rel, content: '' }) });
      await loadDir(state.currentDir);
      await openFile(rel);
    }
  } catch (error) {
    showToast(error.message);
  }
}

$$('.nav-btn').forEach((button) => button.addEventListener('click', () => activatePanel(button.dataset.target)));
$('#refreshBtn').addEventListener('click', () => Promise.all([refreshStatus(), loadDir(state.currentDir)]));
$('#newBtn').addEventListener('click', openCreateSheet);
$('#sheetCancel').addEventListener('click', closeCreateSheet);
$('#newFile').addEventListener('click', () => createEntry('file'));
$('#newFolder').addEventListener('click', () => createEntry('folder'));
els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) closeCreateSheet(); });
$('#editorBack').addEventListener('click', () => activatePanel('files'));
els.saveBtn.addEventListener('click', saveFile);
els.editor.addEventListener('input', () => setDirty(els.editor.value !== state.originalContent));
els.editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    els.editor.setRangeText('  ', start, end, 'end');
    els.editor.dispatchEvent(new Event('input'));
  }
});
$('#copyBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.editor.value);
  showToast('Copied');
});
$('#terminalForm').addEventListener('submit', (e) => { e.preventDefault(); runCommand(els.terminalInput.value); });
$$('[data-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.command)));
$('#clearTerminal').addEventListener('click', () => { els.terminalOutput.textContent = ''; });
els.terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && state.terminalHistory.length) {
    e.preventDefault();
    state.terminalHistoryIndex = Math.max(0, state.terminalHistoryIndex - 1);
    els.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || '';
  }
  if (e.key === 'ArrowDown' && state.terminalHistory.length) {
    e.preventDefault();
    state.terminalHistoryIndex = Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1);
    els.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || '';
  }
});
$('#gitRefresh').addEventListener('click', refreshGit);
$$('[data-git]').forEach((button) => button.addEventListener('click', () => gitAction(button.dataset.git)));
els.codexRun.addEventListener('click', runCodex);
els.previewPort.addEventListener('input', updatePreviewUrl);
$('#openPreview').addEventListener('click', () => {
  updatePreviewUrl();
  const url = els.previewUrl.dataset.url;
  if (url) window.open(url, '_blank', 'noopener');
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

await refreshStatus();
await loadDir('');
