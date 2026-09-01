const vscode = require('vscode');

let homePanel;
let activeMode = 'home';
const navItems = new Map();

async function exec(command, ...args) {
  try {
    return await vscode.commands.executeCommand(command, ...args);
  } catch {
    return undefined;
  }
}

async function run(...commands) {
  for (const command of commands) await exec(command);
}

function setMode(mode) {
  activeMode = mode;
  const icons = {
    home: '$(home)',
    files: '$(files)',
    search: '$(search)',
    git: '$(source-control)',
    terminal: '$(terminal)',
    codex: '$(sparkle)'
  };
  for (const [name, item] of navItems) {
    item.text = name === activeMode ? `[${icons[name]}]` : icons[name];
  }
}

async function closeChrome() {
  await run('workbench.action.closePanel', 'workbench.action.closeSidebar');
}

async function showHome() {
  setMode('home');
  await closeChrome();
  if (homePanel) {
    homePanel.reveal(vscode.ViewColumn.One, true);
    return;
  }

  homePanel = vscode.window.createWebviewPanel(
    'mobileCodespaceHome',
    'Mobile',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  homePanel.webview.html = homeHtml(homePanel.webview);
  homePanel.onDidDispose(() => { homePanel = undefined; });
  homePanel.webview.onDidReceiveMessage(async (message) => {
    const routes = {
      home: 'mobileCodespace.home',
      files: 'mobileCodespace.files',
      search: 'mobileCodespace.search',
      git: 'mobileCodespace.git',
      terminal: 'mobileCodespace.terminal',
      codex: 'mobileCodespace.codex',
      editor: 'mobileCodespace.editor',
      zen: 'mobileCodespace.zen',
      fullscreen: 'mobileCodespace.fullscreen',
      zoomIn: 'workbench.action.zoomIn',
      zoomOut: 'workbench.action.zoomOut',
      zoomReset: 'workbench.action.zoomReset'
    };
    const command = routes[message?.action];
    if (command) await exec(command);
  });
}

async function showFiles() {
  setMode('files');
  await run('workbench.action.closePanel', 'workbench.view.explorer');
}

async function showSearch() {
  setMode('search');
  await run('workbench.action.closePanel', 'workbench.view.search');
}

async function showGit() {
  setMode('git');
  await run('workbench.action.closePanel', 'workbench.view.scm');
}

async function showTerminal() {
  setMode('terminal');
  await exec('workbench.action.closeSidebar');
  let terminal = vscode.window.activeTerminal || vscode.window.terminals.find((item) => item.name === 'Terminal');
  if (!terminal) terminal = vscode.window.createTerminal({ name: 'Terminal' });
  terminal.show(false);
}

async function showCodex() {
  setMode('codex');
  await exec('workbench.action.closeSidebar');
  let terminal = vscode.window.terminals.find((item) => item.name === 'Codex');
  const created = !terminal;
  if (!terminal) terminal = vscode.window.createTerminal({ name: 'Codex' });
  terminal.show(false);
  if (created) terminal.sendText('codex');
}

async function editorOnly() {
  activeMode = 'editor';
  await closeChrome();
  await exec('workbench.action.focusActiveEditorGroup');
  for (const [name, item] of navItems) item.text = ({home:'$(home)',files:'$(files)',search:'$(search)',git:'$(source-control)',terminal:'$(terminal)',codex:'$(sparkle)'})[name];
}

async function moreControls() {
  const picks = [
    { label: '$(home) Home', command: 'mobileCodespace.home' },
    { label: '$(edit) Editor focus', command: 'mobileCodespace.editor' },
    { label: '$(screen-full) Zen mode', command: 'mobileCodespace.zen' },
    { label: '$(device-mobile) Full screen', command: 'mobileCodespace.fullscreen' },
    { label: '$(zoom-in) Zoom in', command: 'workbench.action.zoomIn' },
    { label: '$(zoom-out) Zoom out', command: 'workbench.action.zoomOut' },
    { label: '$(discard) Reset zoom', command: 'workbench.action.zoomReset' },
    { label: '$(settings-gear) Settings', command: 'workbench.action.openSettings' },
    { label: '$(extensions) Extensions', command: 'workbench.view.extensions' }
  ];
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Mobile controls' });
  if (pick) await exec(pick.command);
}

function addNav(context, name, icon, command, tooltip, priority) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.name = `Mobile ${name}`;
  item.text = icon;
  item.tooltip = tooltip;
  item.command = command;
  item.show();
  navItems.set(name, item);
  context.subscriptions.push(item);
}

function homeHtml(webview) {
  const nonce = getNonce();
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);min-height:100vh}
  .shell{max-width:720px;margin:0 auto;padding:18px 14px 40px}
  .hero{padding:10px 4px 18px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--vscode-descriptionForeground);font-weight:700}.hero h1{font-size:28px;line-height:1.05;margin:6px 0}.hero p{margin:0;color:var(--vscode-descriptionForeground);line-height:1.45}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{min-height:92px;border:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background);color:var(--vscode-foreground);border-radius:14px;padding:14px;text-align:left;font:inherit;display:flex;flex-direction:column;justify-content:space-between;touch-action:manipulation}.card:active{transform:scale(.985);background:var(--vscode-list-activeSelectionBackground)}.card strong{font-size:16px}.card span{font-size:11px;color:var(--vscode-descriptionForeground)}
  .wide{grid-column:1/-1;min-height:72px}.section{margin-top:22px}.section h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground)}.tools{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.tool{min-height:48px;border:1px solid var(--vscode-widget-border);background:var(--vscode-input-background);color:var(--vscode-foreground);border-radius:12px;font:inherit;font-size:12px;touch-action:manipulation}
  .foot{margin-top:22px;padding:12px;border:1px solid var(--vscode-widget-border);border-radius:12px;color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.5}
</style>
</head>
<body>
<div class="shell">
  <div class="hero"><div class="eyebrow">Native Codespaces</div><h1>Mobile workspace</h1><p>Pick a screen. Everything underneath is still real VS Code.</p></div>
  <div class="grid">
    <button class="card" data-action="files"><strong>Files</strong><span>Explorer + editor</span></button>
    <button class="card" data-action="search"><strong>Search</strong><span>Workspace search</span></button>
    <button class="card" data-action="git"><strong>Git</strong><span>Source control</span></button>
    <button class="card" data-action="terminal"><strong>Terminal</strong><span>Maximized shell</span></button>
    <button class="card" data-action="codex"><strong>Codex</strong><span>Dedicated Codex terminal</span></button>
    <button class="card" data-action="editor"><strong>Editor</strong><span>Code only</span></button>
    <button class="card wide" data-action="zen"><strong>Focus mode</strong><span>Use native Zen mode when you want every spare pixel.</span></button>
  </div>
  <div class="section"><h2>Display</h2><div class="tools"><button class="tool" data-action="zoomOut">Zoom −</button><button class="tool" data-action="zoomReset">Reset</button><button class="tool" data-action="zoomIn">Zoom +</button><button class="tool" data-action="fullscreen">Full screen</button></div></div>
  <div class="foot">The six icons in the bottom status bar are persistent navigation: Home · Files · Search · Git · Terminal · Codex.</div>
</div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)vscode.postMessage({action:b.dataset.action})});</script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function activate(context) {
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  register('mobileCodespace.home', showHome);
  register('mobileCodespace.files', showFiles);
  register('mobileCodespace.search', showSearch);
  register('mobileCodespace.git', showGit);
  register('mobileCodespace.terminal', showTerminal);
  register('mobileCodespace.codex', showCodex);
  register('mobileCodespace.editor', editorOnly);
  register('mobileCodespace.more', moreControls);
  register('mobileCodespace.zen', () => exec('workbench.action.toggleZenMode'));
  register('mobileCodespace.fullscreen', () => exec('workbench.action.toggleFullScreen'));

  addNav(context, 'home', '$(home)', 'mobileCodespace.home', 'Mobile Home', 20006);
  addNav(context, 'files', '$(files)', 'mobileCodespace.files', 'Files', 20005);
  addNav(context, 'search', '$(search)', 'mobileCodespace.search', 'Search', 20004);
  addNav(context, 'git', '$(source-control)', 'mobileCodespace.git', 'Git', 20003);
  addNav(context, 'terminal', '$(terminal)', 'mobileCodespace.terminal', 'Terminal', 20002);
  addNav(context, 'codex', '$(sparkle)', 'mobileCodespace.codex', 'Codex', 20001);
  setMode('home');

  setTimeout(() => {
    if (!vscode.window.activeTextEditor) showHome();
  }, 900);
}

function deactivate() {}

module.exports = { activate, deactivate };
