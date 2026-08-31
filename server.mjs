import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const root = path.resolve(process.env.MOBILE_WORKSPACE_ROOT || process.env.CODESPACE_VSCODE_FOLDER || process.cwd());
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const ignoredNames = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.turbo', '.vite']);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safePath(input = '') {
  const clean = String(input).replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path is outside the workspace');
  }
  return resolved;
}

function relativeFromRoot(absPath) {
  const rel = path.relative(root, absPath);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

function cwdFromInput(input = '') {
  return safePath(input || '');
}

async function runProcess(command, args = [], options = {}) {
  const cwd = cwdFromInput(options.cwd || '');
  const timeoutMs = options.timeoutMs ?? 120000;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const append = (target, chunk) => {
      const str = chunk.toString();
      if (target.length + str.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return (target + str).slice(-MAX_OUTPUT_BYTES);
      }
      return target + str;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => resolve({ ok: false, code: null, stdout, stderr: stderr + error.message, truncated, timedOut }));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, timeoutMs);

    if (options.stdin) child.stdin.write(options.stdin);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, truncated, timedOut });
    });
  });
}

async function runShell(command, cwd = '', timeoutMs = 120000) {
  return runProcess('bash', ['-lc', command], { cwd, timeoutMs });
}

async function getGitStatus() {
  const branchResult = await runShell('git branch --show-current 2>/dev/null || true');
  const statusResult = await runShell('git status --porcelain=v1 -b 2>/dev/null || true');
  const remoteResult = await runShell('git remote get-url origin 2>/dev/null || true');
  const lines = statusResult.stdout.trimEnd().split('\n').filter(Boolean);
  const header = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  return {
    branch: branchResult.stdout.trim() || header.split('...')[0] || '—',
    tracking: header,
    remote: remoteResult.stdout.trim(),
    changes: lines.map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
  };
}

async function listDirectory(rel = '') {
  const dir = safePath(rel);
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error('Not a directory');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const filtered = entries
    .filter((entry) => !ignoredNames.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  return filtered.map((entry) => ({
    name: entry.name,
    path: relativeFromRoot(path.join(dir, entry.name)),
    type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'
  }));
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const abs = path.resolve(publicDir, requested);
  if (!abs.startsWith(publicDir + path.sep) && abs !== publicDir) return false;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, {
      'content-type': types[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function api(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/status') {
    const [git, node, codex] = await Promise.all([
      getGitStatus(),
      runProcess('node', ['--version']),
      runShell('command -v codex >/dev/null 2>&1 && codex --version || true')
    ]);
    return json(res, 200, {
      ok: true,
      workspace: root,
      workspaceName: path.basename(root),
      codespace: process.env.CODESPACE_NAME || '',
      forwardingDomain: process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev',
      node: node.stdout.trim(),
      codex: codex.stdout.trim() || null,
      git
    });
  }

  if (req.method === 'GET' && pathname === '/api/tree') {
    const rel = url.searchParams.get('path') || '';
    return json(res, 200, { ok: true, path: rel, entries: await listDirectory(rel) });
  }

  if (req.method === 'GET' && pathname === '/api/file') {
    const rel = url.searchParams.get('path') || '';
    const abs = safePath(rel);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error('Not a file');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large for the mobile editor');
    const content = await fs.readFile(abs, 'utf8');
    return json(res, 200, { ok: true, path: relativeFromRoot(abs), content, size: stat.size });
  }

  if (req.method === 'PUT' && pathname === '/api/file') {
    const body = await readJson(req);
    const abs = safePath(body.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(body.content ?? ''), 'utf8');
    return json(res, 200, { ok: true, path: relativeFromRoot(abs) });
  }

  if (req.method === 'POST' && pathname === '/api/mkdir') {
    const body = await readJson(req);
    const abs = safePath(body.path);
    await fs.mkdir(abs, { recursive: true });
    return json(res, 200, { ok: true, path: relativeFromRoot(abs) });
  }

  if (req.method === 'DELETE' && pathname === '/api/path') {
    const rel = url.searchParams.get('path') || '';
    if (!rel) throw new Error('Refusing to delete workspace root');
    const abs = safePath(rel);
    await fs.rm(abs, { recursive: true, force: false });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await readJson(req);
    const command = String(body.command || '').trim();
    if (!command) throw new Error('Command is required');
    const result = await runShell(command, body.cwd || '', Math.min(Number(body.timeoutMs || 120000), 600000));
    return json(res, 200, { ok: true, result });
  }

  if (req.method === 'GET' && pathname === '/api/git/status') {
    return json(res, 200, { ok: true, git: await getGitStatus() });
  }

  if (req.method === 'POST' && pathname === '/api/git/action') {
    const body = await readJson(req);
    const action = body.action;
    const allowed = {
      stageAll: 'git add -A',
      unstageAll: 'git reset',
      pull: 'git pull --ff-only',
      push: 'git push',
      fetch: 'git fetch --prune'
    };
    let command = allowed[action];
    if (action === 'commit') {
      const message = String(body.message || '').trim();
      if (!message) throw new Error('Commit message is required');
      command = `git commit -m ${JSON.stringify(message)}`;
    }
    if (!command) throw new Error('Unsupported Git action');
    const result = await runShell(command, '', 180000);
    return json(res, 200, { ok: true, result, git: await getGitStatus() });
  }

  if (req.method === 'POST' && pathname === '/api/codex') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('Prompt is required');
    const mode = body.mode === 'read-only' ? 'read-only' : 'workspace-write';
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', mode,
      '--ask-for-approval', 'never',
      '--color', 'never',
      prompt
    ];
    const result = await runProcess('codex', args, { cwd: body.cwd || '', timeoutMs: 600000 });
    return json(res, 200, { ok: true, result });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return json(res, 404, { ok: false, error: 'API route not found' });
    }

    if (await serveStatic(req, res, url.pathname)) return;
    if (req.method === 'GET') {
      const index = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
      return text(res, 200, index, 'text/html; charset=utf-8');
    }
    return text(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return json(res, 400, { ok: false, error: error?.message || 'Unknown error' });
  }
});

server.listen(port, host, () => {
  console.log(`Mobile Codespace listening on http://${host}:${port}`);
  console.log(`Workspace root: ${root}`);
});
