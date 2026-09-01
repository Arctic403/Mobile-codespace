const vscode = require('vscode');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { stat: fsStat } = require('node:fs/promises');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const ignoredNames = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.turbo', '.next']);

let panel;
let currentDir = '';
let shellCwd = '';
let shellProcess;
let codexProcess;
let terminalBytes = 0;
let codexBytes = 0;

function rootFolder() {
  return vscode.workspace.workspaceFolders?.[0];
}

function rootFsPath() {
  const folder = rootFolder();
  return folder?.uri.fsPath || process.cwd();
}

function cleanRel(input = '') {
  const raw = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw new Error('Path is outside the workspace');
  return parts.join('/');
}

function uriFor(rel = '') {
  const folder = rootFolder();
  if (!folder) throw new Error('Open a workspace first');
  const clean = cleanRel(rel);
  return clean ? vscode.Uri.joinPath(folder.uri, ...clean.split('/')) : folder.uri;
}

function relFor(uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

function post(message) {
  if (panel) panel.webview.postMessage(message);
}

function postToast(message, kind = 'info') {
  post({ type: 'toast', message, kind });
}

async function exec(command, ...args) {
  try {
    return await vscode.commands.executeCommand(command, ...args);
  } catch {
    return undefined;
  }
}

async function minimizeNativeChrome() {
  await exec('workbench.action.closePanel');
  await exec('workbench.action.closeSidebar');
  await exec('workbench.action.closeAuxiliaryBar');
  await exec('workbench.action.maximizeEditor');
}

async function listDirectory(rel = currentDir) {
  const clean = cleanRel(rel);
  currentDir = clean;
  const entries = await vscode.workspace.fs.readDirectory(uriFor(clean));
  const mapped = entries
    .filter(([name]) => !ignoredNames.has(name))
    .map(([name, type]) => ({
      name,
      type: type === vscode.FileType.Directory ? 'dir' : type === vscode.FileType.File ? 'file' : 'other',
      path: clean ? `${clean}/${name}` : name
    }))
    .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
  post({ type: 'directory', path: clean, entries: mapped });
}

async function openFile(rel, line = 0) {
  const clean = cleanRel(rel);
  const uri = uriFor(clean);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large for the mobile editor');
  const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
  if (bytes.includes(0)) throw new Error('Binary files are not supported by the mobile editor');
  post({
    type: 'file',
    path: clean,
    name: path.posix.basename(clean),
    content: bytes.toString('utf8'),
    size: stat.size,
    line: Number(line || 0)
  });
}

async function saveFile(rel, content) {
  const clean = cleanRel(rel);
  const bytes = Buffer.from(String(content ?? ''), 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('File is too large for the mobile editor');
  await vscode.workspace.fs.writeFile(uriFor(clean), bytes);
  post({ type: 'saved', path: clean, size: bytes.length });
  postToast('Saved');
  await refreshGit();
}

async function createEntry(kind, parent, name) {
  const safeName = String(name || '').trim();
  if (!safeName || /[\\/]/.test(safeName) || safeName === '.' || safeName === '..') {
    throw new Error('Use a simple file or folder name');
  }
  const base = cleanRel(parent);
  const rel = base ? `${base}/${safeName}` : safeName;
  const uri = uriFor(rel);
  if (kind === 'folder') await vscode.workspace.fs.createDirectory(uri);
  else await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
  await listDirectory(base);
  if (kind !== 'folder') await openFile(rel);
}

async function renameEntry(oldRel, newName) {
  const oldClean = cleanRel(oldRel);
  const safeName = String(newName || '').trim();
  if (!safeName || /[\\/]/.test(safeName) || safeName === '.' || safeName === '..') {
    throw new Error('Use a simple name');
  }
  const parent = path.posix.dirname(oldClean) === '.' ? '' : path.posix.dirname(oldClean);
  const next = parent ? `${parent}/${safeName}` : safeName;
  await vscode.workspace.fs.rename(uriFor(oldClean), uriFor(next), { overwrite: false });
  await listDirectory(parent);
  post({ type: 'renamed', from: oldClean, path: next });
}

async function deleteEntry(rel) {
  const clean = cleanRel(rel);
  if (!clean) throw new Error('Refusing to delete the workspace root');
  const parent = path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean);
  await vscode.workspace.fs.delete(uriFor(clean), { recursive: true, useTrash: true });
  await listDirectory(parent);
  post({ type: 'deleted', path: clean });
  await refreshGit();
}

async function searchWorkspace(query) {
  const pattern = String(query || '').trim();
  if (!pattern) {
    post({ type: 'searchResults', query: '', results: [] });
    return;
  }
  const results = [];
  await vscode.workspace.findTextInFiles(
    { pattern, isRegExp: false, isCaseSensitive: false },
    { maxResults: 120, useIgnoreFiles: true, useGlobalIgnoreFiles: true, followSymlinks: false },
    (result) => {
      if (results.length >= 120) return;
      const range = Array.isArray(result.ranges) ? result.ranges[0] : result.ranges;
      results.push({
        path: relFor(result.uri),
        line: range?.start?.line != null ? range.start.line + 1 : 1,
        preview: String(result.preview?.text || '').trim().slice(0, 240)
      });
    }
  );
  post({ type: 'searchResults', query: pattern, results });
}

function runGit(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: rootFsPath(), timeout, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr || error?.message || '')
      });
    });
  });
}

async function gitSnapshot() {
  const [status, branch, remote] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-b']),
    runGit(['branch', '--show-current']),
    runGit(['remote', 'get-url', 'origin'])
  ]);
  const lines = status.stdout.trimEnd().split('\n').filter(Boolean);
  const header = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  return {
    branch: branch.stdout.trim() || header.split('...')[0] || '—',
    tracking: header,
    remote: remote.stdout.trim(),
    changes: lines.map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
  };
}

async function refreshGit() {
  post({ type: 'gitStatus', git: await gitSnapshot() });
}

async function gitAction(action, value = '') {
  const allowed = {
    stageAll: ['add', '-A'],
    unstageAll: ['reset'],
    pull: ['pull', '--ff-only'],
    push: ['push'],
    fetch: ['fetch', '--prune']
  };
  let args = allowed[action];
  if (action === 'commit') {
    const message = String(value || '').trim();
    if (!message) throw new Error('Commit message is required');
    args = ['commit', '-m', message];
  }
  if (!args) throw new Error('Unsupported Git action');
  const result = await runGit(args, action === 'pull' || action === 'push' ? 180000 : 120000);
  post({ type: 'gitResult', action, result });
  await refreshGit();
}

function appendProcessChunk(target, chunk) {
  const text = chunk.toString();
  if (target === 'terminal') {
    terminalBytes += Buffer.byteLength(text);
    if (terminalBytes <= MAX_OUTPUT_BYTES) post({ type: 'terminalChunk', text });
  } else {
    codexBytes += Buffer.byteLength(text);
    if (codexBytes <= MAX_OUTPUT_BYTES) post({ type: 'codexChunk', text });
  }
}

function withinWorkspace(candidate) {
  const root = path.resolve(rootFsPath());
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function changeDirectory(arg) {
  const input = String(arg || '').trim();
  const next = input ? path.resolve(shellCwd || rootFsPath(), input) : rootFsPath();
  if (!withinWorkspace(next)) throw new Error('Mobile terminal stays inside this workspace');
  const info = await fsStat(next);
  if (!info.isDirectory()) throw new Error('Not a directory');
  shellCwd = next;
}

async function runTerminal(command) {
  const text = String(command || '').trim();
  if (!text) return;
  if (shellProcess) {
    shellProcess.stdin?.write(text + '\n');
    return;
  }
  if (text === 'clear') {
    terminalBytes = 0;
    post({ type: 'terminalClear' });
    return;
  }
  if (text === 'cd' || text.startsWith('cd ')) {
    await changeDirectory(text.slice(2).trim());
    post({ type: 'terminalState', running: false, cwd: path.relative(rootFsPath(), shellCwd) || '.' });
    return;
  }

  terminalBytes = 0;
  post({ type: 'terminalChunk', text: `$ ${text}\n` });
  post({ type: 'terminalState', running: true, cwd: path.relative(rootFsPath(), shellCwd || rootFsPath()) || '.' });

  shellProcess = spawn('bash', ['-lc', text], {
    cwd: shellCwd || rootFsPath(),
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  shellProcess.stdout.on('data', (chunk) => appendProcessChunk('terminal', chunk));
  shellProcess.stderr.on('data', (chunk) => appendProcessChunk('terminal', chunk));
  shellProcess.on('error', (error) => post({ type: 'terminalChunk', text: `\n${error.message}\n` }));
  shellProcess.on('close', async (code) => {
    shellProcess = undefined;
    post({ type: 'terminalChunk', text: `\n[exit ${code ?? 0}]\n` });
    post({ type: 'terminalState', running: false, cwd: path.relative(rootFsPath(), shellCwd || rootFsPath()) || '.' });
    await refreshGit();
    await listDirectory(currentDir).catch(() => {});
  });
}

function stopTerminal() {
  if (shellProcess) {
    shellProcess.kill('SIGINT');
    setTimeout(() => shellProcess?.kill('SIGTERM'), 1500).unref();
  }
}

function runCodex(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  if (codexProcess) {
    postToast('Codex is already running', 'warn');
    return;
  }

  codexBytes = 0;
  post({ type: 'codexChunk', text: `\n› ${text}\n\n` });
  post({ type: 'codexState', running: true });

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '--ask-for-approval', 'never',
    '--color', 'never',
    text
  ];
  codexProcess = spawn('codex', args, {
    cwd: rootFsPath(),
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  codexProcess.stdout.on('data', (chunk) => appendProcessChunk('codex', chunk));
  codexProcess.stderr.on('data', (chunk) => appendProcessChunk('codex', chunk));
  codexProcess.on('error', (error) => post({ type: 'codexChunk', text: `\n${error.message}\n` }));
  codexProcess.on('close', async (code) => {
    codexProcess = undefined;
    post({ type: 'codexChunk', text: `\n[Codex exit ${code ?? 0}]\n` });
    post({ type: 'codexState', running: false });
    await refreshGit();
    await listDirectory(currentDir).catch(() => {});
  });
}

function stopCodex() {
  if (codexProcess) {
    codexProcess.kill('SIGINT');
    setTimeout(() => codexProcess?.kill('SIGTERM'), 1500).unref();
  }
}

async function sendBootstrap() {
  const folder = rootFolder();
  shellCwd = shellCwd || rootFsPath();
  post({
    type: 'bootstrap',
    workspaceName: folder?.name || path.basename(rootFsPath()),
    root: rootFsPath(),
    cwd: path.relative(rootFsPath(), shellCwd) || '.'
  });
  await Promise.all([listDirectory(''), refreshGit()]);
}

async function openNative(rel) {
  const doc = await vscode.workspace.openTextDocument(uriFor(rel));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function handleMessage(message) {
  try {
    switch (message?.type) {
      case 'ready':
        await sendBootstrap();
        break;
      case 'list':
        await listDirectory(message.path || '');
        break;
      case 'open':
        await openFile(message.path, message.line);
        break;
      case 'save':
        await saveFile(message.path, message.content);
        break;
      case 'create':
        await createEntry(message.kind, message.parent || '', message.name);
        break;
      case 'rename':
        await renameEntry(message.path, message.name);
        break;
      case 'delete':
        await deleteEntry(message.path);
        break;
      case 'search':
        await searchWorkspace(message.query);
        break;
      case 'gitRefresh':
        await refreshGit();
        break;
      case 'gitAction':
        await gitAction(message.action, message.value);
        break;
      case 'terminalRun':
        await runTerminal(message.command);
        break;
      case 'terminalStop':
        stopTerminal();
        break;
      case 'terminalClear':
        terminalBytes = 0;
        post({ type: 'terminalClear' });
        break;
      case 'codexRun':
        runCodex(message.prompt);
        break;
      case 'codexStop':
        stopCodex();
        break;
      case 'native':
        await openNative(message.path);
        break;
      case 'command':
        await exec(message.command);
        break;
      case 'closeShell':
        panel?.dispose();
        break;
      default:
        break;
    }
  } catch (error) {
    postToast(error?.message || String(error), 'error');
  }
}

async function showShell() {
  await minimizeNativeChrome();
  if (panel) {
    panel.reveal(vscode.ViewColumn.One, false);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'mobileCodespaceShell',
    'Mobile Workspace',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  panel.webview.html = shellHtml(panel.webview);
  panel.webview.onDidReceiveMessage(handleMessage);
  panel.onDidDispose(() => {
    panel = undefined;
  });
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function shellHtml(webview) {
  const nonce = getNonce();
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root{color-scheme:dark light}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,textarea{font:inherit}
button{touch-action:manipulation}
#app{height:100vh;height:100dvh;display:grid;grid-template-rows:auto 1fr auto;background:var(--vscode-editor-background)}
.topbar{min-height:58px;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;display:flex;align-items:flex-end;gap:10px;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-titleBar-activeBackground)}
.brand{min-width:0;flex:1}.brand small{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground)}.brand strong{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iconbtn,.ghost,.primary,.danger{border:1px solid var(--vscode-widget-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:10px;min-height:40px;padding:8px 12px}
.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}.danger{background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-foreground)}
.main{position:relative;min-height:0;overflow:hidden}.screen{display:none;height:100%;overflow:auto;padding:14px 12px 22px}.screen.active{display:block}
.hero{padding:8px 2px 14px}.hero .eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--vscode-descriptionForeground);font-weight:700}.hero h1{font-size:27px;line-height:1.05;margin:5px 0}.hero p{color:var(--vscode-descriptionForeground);margin:0;line-height:1.4}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{min-height:94px;border:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background);color:var(--vscode-foreground);border-radius:15px;padding:13px;text-align:left;display:flex;flex-direction:column;justify-content:space-between}.card strong{font-size:16px}.card span{font-size:11px;color:var(--vscode-descriptionForeground)}.card:active{transform:scale(.985)}
.section-title{display:flex;align-items:center;gap:8px;margin:4px 0 10px}.section-title h2{font-size:15px;margin:0;flex:1}.muted{color:var(--vscode-descriptionForeground);font-size:11px}
.toolbar{display:flex;gap:7px;align-items:center;margin-bottom:10px}.toolbar input{flex:1;min-width:0}
input,textarea{width:100%;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:10px;padding:10px 11px;outline:none}input:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
.pathbar{display:flex;align-items:center;gap:7px;margin-bottom:9px}.pathbar .path{flex:1;min-width:0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-descriptionForeground)}
.list{border:1px solid var(--vscode-widget-border);border-radius:13px;overflow:hidden}.row{width:100%;border:0;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background);color:var(--vscode-foreground);min-height:49px;padding:9px 11px;display:flex;align-items:center;gap:10px;text-align:left}.row:last-child{border-bottom:0}.row .badge{min-width:34px;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--vscode-descriptionForeground)}.row .name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .sub{font-size:10px;color:var(--vscode-descriptionForeground)}
.empty{border:1px dashed var(--vscode-widget-border);border-radius:12px;padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
.editor-wrap{height:100%;display:grid;grid-template-rows:auto 1fr auto;gap:9px}.editor-head{display:flex;gap:8px;align-items:center}.editor-head .file-title{flex:1;min-width:0}.editor-head strong,.editor-head small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.editor-head small{font-size:10px;color:var(--vscode-descriptionForeground)}
#editor{height:100%;resize:none;border-radius:12px;padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2;white-space:pre;overflow:auto;overflow-wrap:normal;spellcheck:false}
.editor-actions{display:flex;gap:7px}.editor-actions button{flex:1}
.search-result{padding:10px 11px;border-bottom:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background)}.search-result:last-child{border-bottom:0}.search-result button{width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:0}.search-result strong{display:block;font-size:12px}.search-result span{display:block;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--vscode-descriptionForeground);margin-top:4px;white-space:pre-wrap}
.git-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.pill{border:1px solid var(--vscode-widget-border);border-radius:11px;padding:10px;background:var(--vscode-sideBar-background)}.pill small{display:block;color:var(--vscode-descriptionForeground);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.pill strong{display:block;margin-top:3px;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:10px 0}.actions button{min-height:44px}
.console{height:calc(100% - 102px);min-height:220px;overflow:auto;border:1px solid var(--vscode-widget-border);border-radius:12px;background:var(--vscode-terminal-background,var(--vscode-editor-background));padding:11px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.commandbar{display:grid;grid-template-columns:1fr auto;gap:7px;margin-top:8px}.commandbar input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.command-tools{display:flex;gap:7px;margin-top:7px}.command-tools button{flex:1}
.codex-box{height:calc(100% - 154px);min-height:210px}.codex-input{margin-top:8px;height:84px;resize:none}
.bottom{padding:6px 6px calc(6px + env(safe-area-inset-bottom));border-top:1px solid var(--vscode-widget-border);background:var(--vscode-statusBar-background);display:grid;grid-template-columns:repeat(6,1fr);gap:3px}.nav{border:0;background:transparent;color:var(--vscode-statusBar-foreground);min-height:49px;border-radius:10px;padding:4px 1px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;opacity:.65}.nav.active{background:color-mix(in srgb,var(--vscode-statusBar-foreground) 13%,transparent);opacity:1}.nav b{font-size:15px;line-height:1}.nav span{font-size:9px}
.sheet-backdrop{display:none;position:absolute;inset:0;background:rgba(0,0,0,.48);z-index:20}.sheet-backdrop.show{display:block}.sheet{position:absolute;left:8px;right:8px;bottom:8px;padding:10px;border:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background);border-radius:16px;box-shadow:0 12px 45px rgba(0,0,0,.35)}.sheet-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sheet button{min-height:46px}
.toast{position:absolute;z-index:40;left:50%;bottom:76px;transform:translate(-50%,15px);opacity:0;pointer-events:none;max-width:88%;padding:9px 12px;border-radius:999px;background:var(--vscode-notifications-background);border:1px solid var(--vscode-widget-border);box-shadow:0 7px 28px rgba(0,0,0,.3);font-size:11px;transition:.18s}.toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:420px){.screen{padding-left:9px;padding-right:9px}.topbar{padding-left:9px;padding-right:9px}.cards{gap:8px}.card{min-height:86px;padding:11px}.nav span{font-size:8px}}
</style>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="brand"><small id="screenLabel">Mobile Codespace</small><strong id="workspaceName">Workspace</strong></div>
    <button class="iconbtn" id="moreBtn" aria-label="More">•••</button>
  </header>
  <main class="main">
    <section class="screen active" data-screen="home">
      <div class="hero"><div class="eyebrow">Codespaces underneath · mobile shell on top</div><h1>Workspace</h1><p>Files, editing, Git, terminal and Codex stay inside this phone-first surface.</p></div>
      <div class="cards">
        <button class="card" data-go="files"><strong>Files</strong><span>Browse + edit</span></button>
        <button class="card" data-go="search"><strong>Search</strong><span>Whole workspace</span></button>
        <button class="card" data-go="git"><strong>Git</strong><span id="homeGit">Source control</span></button>
        <button class="card" data-go="terminal"><strong>Terminal</strong><span>Codespace shell</span></button>
        <button class="card" data-go="codex"><strong>Codex</strong><span>AI coding agent</span></button>
        <button class="card" id="lastFileCard"><strong>Editor</strong><span id="lastFileLabel">Open a file</span></button>
      </div>
    </section>

    <section class="screen" data-screen="files">
      <div class="section-title"><h2>Files</h2><span class="muted" id="fileCount"></span></div>
      <div class="pathbar"><button class="ghost" id="upBtn">‹</button><div class="path" id="currentPath">/</div><button class="ghost" id="newFileBtn">+ File</button><button class="ghost" id="newFolderBtn">+ Folder</button></div>
      <div class="list" id="fileList"></div>
    </section>

    <section class="screen" data-screen="editor">
      <div class="editor-wrap">
        <div class="editor-head">
          <button class="ghost" id="editorBack">‹ Files</button>
          <div class="file-title"><strong id="editorName">File</strong><small id="editorPath"></small></div>
          <button class="primary" id="saveBtn">Save</button>
        </div>
        <textarea id="editor" wrap="off" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
        <div class="editor-actions"><button class="ghost" id="nativeBtn">Native editor</button><button class="ghost" id="renameBtn">Rename</button><button class="danger" id="deleteBtn">Delete</button></div>
      </div>
    </section>

    <section class="screen" data-screen="search">
      <div class="section-title"><h2>Search</h2><span class="muted" id="searchCount"></span></div>
      <div class="toolbar"><input id="searchInput" placeholder="Search workspace"><button class="primary" id="searchBtn">Search</button></div>
      <div class="list" id="searchResults"><div class="empty">Search every text file in this workspace.</div></div>
    </section>

    <section class="screen" data-screen="git">
      <div class="section-title"><h2>Git</h2><button class="ghost" id="gitRefresh">Refresh</button></div>
      <div class="git-meta"><div class="pill"><small>Branch</small><strong id="gitBranch">—</strong></div><div class="pill"><small>Tracking</small><strong id="gitTracking">—</strong></div></div>
      <div class="actions"><button class="ghost" data-git="stageAll">Stage all</button><button class="ghost" data-git="unstageAll">Unstage</button><button class="ghost" data-git="fetch">Fetch</button><button class="ghost" data-git="pull">Pull</button><button class="ghost" data-git="push">Push</button><button class="ghost" id="commitBtn">Commit</button></div>
      <input id="commitMessage" placeholder="Commit message">
      <div class="section-title" style="margin-top:14px"><h2>Changes</h2><span class="muted" id="changeCount"></span></div>
      <div class="list" id="gitChanges"></div>
      <pre class="console" id="gitOutput" style="height:auto;min-height:90px;margin-top:10px"></pre>
    </section>

    <section class="screen" data-screen="terminal">
      <div class="section-title"><h2>Terminal</h2><span class="muted" id="terminalCwd">.</span></div>
      <pre class="console" id="terminalOutput">Mobile terminal ready.\n</pre>
      <div class="commandbar"><input id="terminalInput" placeholder="command" autocapitalize="off" autocomplete="off" autocorrect="off"><button class="primary" id="terminalRun">Run</button></div>
      <div class="command-tools"><button class="ghost" id="terminalStop">Ctrl+C</button><button class="ghost" id="terminalClear">Clear</button></div>
    </section>

    <section class="screen" data-screen="codex">
      <div class="section-title"><h2>Codex</h2><span class="muted" id="codexState">ready</span></div>
      <pre class="console codex-box" id="codexOutput">Codex is installed inside this Codespace.\n</pre>
      <textarea class="codex-input" id="codexPrompt" placeholder="Tell Codex what to inspect, build or change…"></textarea>
      <div class="command-tools"><button class="primary" id="codexRun">Run Codex</button><button class="ghost" id="codexStop">Stop</button></div>
    </section>

    <div class="sheet-backdrop" id="sheetBackdrop"><div class="sheet">
      <div class="section-title"><h2>More</h2><button class="ghost" id="sheetClose">Done</button></div>
      <div class="sheet-grid">
        <button class="ghost" data-command="workbench.action.toggleFullScreen">Full screen</button>
        <button class="ghost" data-command="workbench.action.zoomIn">Zoom +</button>
        <button class="ghost" data-command="workbench.action.zoomOut">Zoom −</button>
        <button class="ghost" data-command="workbench.action.zoomReset">Reset zoom</button>
        <button class="ghost" data-command="workbench.action.openSettings">VS Code settings</button>
        <button class="ghost" data-command="workbench.action.reloadWindow">Reload window</button>
        <button class="ghost" id="closeShellBtn">Exit mobile shell</button>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  </main>

  <nav class="bottom">
    <button class="nav active" data-go="home"><b>⌂</b><span>Home</span></button>
    <button class="nav" data-go="files"><b>≡</b><span>Files</span></button>
    <button class="nav" data-go="search"><b>⌕</b><span>Search</span></button>
    <button class="nav" data-go="git"><b>⑂</b><span>Git</span></button>
    <button class="nav" data-go="terminal"><b>&gt;_</b><span>Terminal</span></button>
    <button class="nav" data-go="codex"><b>AI</b><span>Codex</span></button>
  </nav>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const state = {
  screen: 'home', workspace: '', dir: '', entries: [], file: null, dirty: false,
  git: null, terminalRunning: false, codexRunning: false
};
const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];
const send = (message) => vscode.postMessage(message);
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800)}
function go(name){
  state.screen=name;
  $$('.screen').forEach(x=>x.classList.toggle('active',x.dataset.screen===name));
  $$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.go===name));
  $('#screenLabel').textContent = name === 'home' ? 'Mobile Codespace' : name[0].toUpperCase()+name.slice(1);
  if(name==='files') send({type:'list',path:state.dir});
  if(name==='git') send({type:'gitRefresh'});
  requestAnimationFrame(()=>{ if(name==='terminal') $('#terminalInput').focus(); if(name==='search') $('#searchInput').focus(); });
}
function renderFiles(){
  $('#currentPath').textContent='/'+state.dir;
  $('#fileCount').textContent=state.entries.length+' items';
  $('#upBtn').disabled=!state.dir;
  const list=$('#fileList');
  list.innerHTML=state.entries.length?'':'<div class="empty">This folder is empty.</div>';
  state.entries.forEach(item=>{
    const b=document.createElement('button');b.className='row';
    b.innerHTML='<span class="badge">'+(item.type==='dir'?'DIR':esc((item.name.split('.').pop()||'FILE').slice(0,4).toUpperCase()))+'</span><span class="name">'+esc(item.name)+'</span><span class="sub">'+(item.type==='dir'?'›':'')+'</span>';
    b.onclick=()=> item.type==='dir' ? send({type:'list',path:item.path}) : send({type:'open',path:item.path});
    list.appendChild(b);
  });
}
function openEditor(data){
  state.file={path:data.path,name:data.name,content:data.content};
  state.dirty=false;
  $('#editorName').textContent=data.name;
  $('#editorPath').textContent=data.path;
  $('#editor').value=data.content;
  $('#saveBtn').textContent='Save';
  $('#lastFileLabel').textContent=data.path;
  go('editor');
  if(data.line>0){
    const lines=data.content.split('\\n');let pos=0;for(let i=0;i<Math.min(data.line-1,lines.length);i++)pos+=lines[i].length+1;
    requestAnimationFrame(()=>{$('#editor').focus();$('#editor').setSelectionRange(pos,pos);const lh=19.5;$('#editor').scrollTop=Math.max(0,(data.line-4)*lh)});
  }
}
function renderSearch(results){
  $('#searchCount').textContent=results.length+' results';
  const list=$('#searchResults');list.innerHTML=results.length?'':'<div class="empty">No matches.</div>';
  results.forEach(r=>{
    const div=document.createElement('div');div.className='search-result';
    div.innerHTML='<button><strong>'+esc(r.path)+':'+r.line+'</strong><span>'+esc(r.preview)+'</span></button>';
    div.querySelector('button').onclick=()=>send({type:'open',path:r.path,line:r.line});
    list.appendChild(div);
  });
}
function renderGit(git){
  state.git=git;
  $('#gitBranch').textContent=git.branch||'—';$('#gitTracking').textContent=git.tracking||'—';
  $('#changeCount').textContent=(git.changes?.length||0)+' changes';
  $('#homeGit').textContent=(git.changes?.length||0)+' changes · '+(git.branch||'—');
  const list=$('#gitChanges');list.innerHTML=git.changes?.length?'':'<div class="empty">Working tree clean.</div>';
  (git.changes||[]).forEach(ch=>{const b=document.createElement('button');b.className='row';b.innerHTML='<span class="badge">'+esc(ch.code)+'</span><span class="name">'+esc(ch.path)+'</span>';b.onclick=()=>send({type:'open',path:ch.path.replace(/^.* -> /,'')});list.appendChild(b)});
}
function append(id,text){const el=$(id);el.textContent+=text; if(el.textContent.length>200000)el.textContent=el.textContent.slice(-200000);el.scrollTop=el.scrollHeight}
document.addEventListener('click',(e)=>{
  const goBtn=e.target.closest('[data-go]');if(goBtn){go(goBtn.dataset.go);return}
  const gitBtn=e.target.closest('[data-git]');if(gitBtn){send({type:'gitAction',action:gitBtn.dataset.git});return}
  const cmd=e.target.closest('[data-command]');if(cmd){send({type:'command',command:cmd.dataset.command});return}
});
$('#moreBtn').onclick=()=>$('#sheetBackdrop').classList.add('show');$('#sheetClose').onclick=()=>$('#sheetBackdrop').classList.remove('show');$('#sheetBackdrop').onclick=e=>{if(e.target===$('#sheetBackdrop'))$('#sheetBackdrop').classList.remove('show')};
$('#upBtn').onclick=()=>{const p=state.dir.split('/').filter(Boolean);p.pop();send({type:'list',path:p.join('/')})};
$('#newFileBtn').onclick=()=>{const name=prompt('New file name');if(name)send({type:'create',kind:'file',parent:state.dir,name})};
$('#newFolderBtn').onclick=()=>{const name=prompt('New folder name');if(name)send({type:'create',kind:'folder',parent:state.dir,name})};
$('#editorBack').onclick=()=>go('files');
$('#editor').addEventListener('input',()=>{state.dirty=true;$('#saveBtn').textContent='Save •'});
$('#saveBtn').onclick=()=>{if(state.file)send({type:'save',path:state.file.path,content:$('#editor').value})};
$('#nativeBtn').onclick=()=>{if(state.file)send({type:'native',path:state.file.path})};
$('#renameBtn').onclick=()=>{if(!state.file)return;const name=prompt('Rename to',state.file.name);if(name)send({type:'rename',path:state.file.path,name})};
$('#deleteBtn').onclick=()=>{if(state.file&&confirm('Delete '+state.file.path+'?'))send({type:'delete',path:state.file.path})};
$('#lastFileCard').onclick=()=>{if(state.file)go('editor');else go('files')};
$('#searchBtn').onclick=()=>send({type:'search',query:$('#searchInput').value});$('#searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('#searchBtn').click()});
$('#gitRefresh').onclick=()=>send({type:'gitRefresh'});$('#commitBtn').onclick=()=>send({type:'gitAction',action:'commit',value:$('#commitMessage').value});
$('#terminalRun').onclick=()=>{const input=$('#terminalInput');if(input.value.trim()){send({type:'terminalRun',command:input.value});input.value=''}};$('#terminalInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#terminalRun').click()}});
$('#terminalStop').onclick=()=>send({type:'terminalStop'});$('#terminalClear').onclick=()=>send({type:'terminalClear'});
$('#codexRun').onclick=()=>{const p=$('#codexPrompt');if(p.value.trim()){send({type:'codexRun',prompt:p.value});p.value=''}};$('#codexStop').onclick=()=>send({type:'codexStop'});
$('#closeShellBtn').onclick=()=>send({type:'closeShell'});
window.addEventListener('message',(event)=>{
  const m=event.data||{};
  if(m.type==='navigate'&&m.screen)go(m.screen);
  if(m.type==='bootstrap'){state.workspace=m.workspaceName;$('#workspaceName').textContent=m.workspaceName;$('#terminalCwd').textContent=m.cwd||'.'}
  if(m.type==='directory'){state.dir=m.path||'';state.entries=m.entries||[];renderFiles()}
  if(m.type==='file')openEditor(m);
  if(m.type==='saved'){state.dirty=false;if(state.file){state.file.content=$('#editor').value;$('#saveBtn').textContent='Save'}}
  if(m.type==='renamed'&&state.file&&state.file.path===m.from){state.file.path=m.path;state.file.name=m.path.split('/').pop();$('#editorName').textContent=state.file.name;$('#editorPath').textContent=m.path;$('#lastFileLabel').textContent=m.path;toast('Renamed')}
  if(m.type==='deleted'){if(state.file&&state.file.path===m.path)state.file=null;go('files');toast('Deleted')}
  if(m.type==='searchResults')renderSearch(m.results||[]);
  if(m.type==='gitStatus')renderGit(m.git||{changes:[]});
  if(m.type==='gitResult'){const text=(m.result?.stdout||'')+(m.result?.stderr||'');$('#gitOutput').textContent=text||((m.action||'Git')+' complete');$('#gitOutput').scrollTop=$('#gitOutput').scrollHeight}
  if(m.type==='terminalChunk')append('#terminalOutput',m.text||'');
  if(m.type==='terminalClear')$('#terminalOutput').textContent='';
  if(m.type==='terminalState'){state.terminalRunning=!!m.running;$('#terminalCwd').textContent=m.cwd||'.';$('#terminalRun').textContent=m.running?'Send':'Run'}
  if(m.type==='codexChunk')append('#codexOutput',m.text||'');
  if(m.type==='codexState'){state.codexRunning=!!m.running;$('#codexState').textContent=m.running?'working…':'ready';$('#codexRun').disabled=!!m.running}
  if(m.type==='toast')toast(m.message||'');
});
send({type:'ready'});
</script>
</body>
</html>`;
}

function activate(context) {
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  register('mobileCodespace.open', showShell);
  register('mobileCodespace.home', async () => { await showShell(); post({ type: 'navigate', screen: 'home' }); });
  register('mobileCodespace.files', async () => { await showShell(); post({ type: 'navigate', screen: 'files' }); });
  register('mobileCodespace.search', async () => { await showShell(); post({ type: 'navigate', screen: 'search' }); });
  register('mobileCodespace.git', async () => { await showShell(); post({ type: 'navigate', screen: 'git' }); });
  register('mobileCodespace.terminal', async () => { await showShell(); post({ type: 'navigate', screen: 'terminal' }); });
  register('mobileCodespace.codex', async () => { await showShell(); post({ type: 'navigate', screen: 'codex' }); });

  context.subscriptions.push({
    dispose() {
      stopTerminal();
      stopCodex();
    }
  });

  setTimeout(() => {
    showShell().catch((error) => vscode.window.showErrorMessage(`Mobile Codespace: ${error.message}`));
  }, 700);
}

function deactivate() {
  stopTerminal();
  stopCodex();
}

module.exports = { activate, deactivate };
