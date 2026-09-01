const vscode = require('vscode');

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

async function showFiles() {
  await run('workbench.action.closePanel', 'workbench.view.explorer');
}

async function editorOnly() {
  await run('workbench.action.closePanel', 'workbench.action.closeSidebar', 'workbench.action.focusActiveEditorGroup');
}

async function showTerminal() {
  let terminal = vscode.window.activeTerminal || vscode.window.terminals[0];
  if (!terminal) terminal = vscode.window.createTerminal({ name: 'Terminal' });
  terminal.show();
}

async function showGit() {
  await run('workbench.action.closePanel', 'workbench.view.scm');
}

async function showSearch() {
  await run('workbench.action.closePanel', 'workbench.view.search');
}

async function showCodex() {
  let terminal = vscode.window.terminals.find((item) => item.name === 'Codex');
  const created = !terminal;
  if (!terminal) terminal = vscode.window.createTerminal({ name: 'Codex' });
  terminal.show();
  if (created) terminal.sendText('codex');
}

async function openMenu() {
  const picks = [
    { label: '$(files) Files + Editor', detail: 'Explorer with the editor beside it', command: 'mobileCodespace.files' },
    { label: '$(edit) Editor Only', detail: 'Hide sidebar and panel', command: 'mobileCodespace.editor' },
    { label: '$(terminal) Terminal', detail: 'Focus the integrated terminal', command: 'mobileCodespace.terminal' },
    { label: '$(source-control) Source Control', detail: 'Open native Git source control', command: 'mobileCodespace.git' },
    { label: '$(search) Search', detail: 'Open workspace search', command: 'mobileCodespace.search' },
    { label: '$(sparkle) Codex CLI', detail: 'Open a dedicated terminal and start Codex', command: 'mobileCodespace.codex' },
    { label: '$(screen-full) Zen Mode', detail: 'Toggle distraction-free native VS Code mode', command: 'mobileCodespace.zen' },
    { label: '$(device-mobile) Full Screen', detail: 'Toggle VS Code full screen', command: 'mobileCodespace.fullscreen' },
    { label: '$(zoom-in) Zoom In', command: 'workbench.action.zoomIn' },
    { label: '$(zoom-out) Zoom Out', command: 'workbench.action.zoomOut' },
    { label: '$(discard) Reset Zoom', command: 'workbench.action.zoomReset' }
  ];

  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Mobile Codespace',
    matchOnDetail: true
  });

  if (pick) await exec(pick.command);
}

function activate(context) {
  const register = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

  register('mobileCodespace.menu', openMenu);
  register('mobileCodespace.files', showFiles);
  register('mobileCodespace.editor', editorOnly);
  register('mobileCodespace.terminal', showTerminal);
  register('mobileCodespace.git', showGit);
  register('mobileCodespace.search', showSearch);
  register('mobileCodespace.codex', showCodex);
  register('mobileCodespace.zen', () => exec('workbench.action.toggleZenMode'));
  register('mobileCodespace.fullscreen', () => exec('workbench.action.toggleFullScreen'));

  const mobile = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
  mobile.name = 'Mobile Codespace';
  mobile.text = '$(device-mobile) Mobile';
  mobile.tooltip = 'Open mobile layout controls';
  mobile.command = 'mobileCodespace.menu';
  mobile.show();
  context.subscriptions.push(mobile);
}

function deactivate() {}

module.exports = { activate, deactivate };
