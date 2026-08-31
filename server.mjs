import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const root = path.resolve(process.env.MOBILE_WORKSPACE_ROOT || process.env.CODESPACE_VSCODE_FOLDER || process.cwd());
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const codespaceName = process.env.CODESPACE_NAME || '';
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
const uiBase = process.env.MOBILE_UI_BASE || 'https://arctic403.github.io/Mobile-codespace/';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const authCache = new Map();
const ignoredNames = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.turbo', '.vite']);
const uiFiles = new Set(['index.html', 'app.js', 'styles.css', 'connection.css', 'mode.css', 'manifest.json', 'sw.js']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function forwardedHost() {
  return codespaceName ? `${codespaceName}-${port}.${forwardingDomain}`.toLowerCase() : '';
}

function isTrustedPrivateOrigin(req) {
  const expectedHost = forwardedHost();
  if (!expectedHost) return false;
  const requestHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (requestHost !== expectedHost) return false;
  const origin = String(req.headers.origin || '');
  if (origin && origin !== `https://${expectedHost}`) return false;
  const site = String(req.headers['sec-fetch-site'] || '');
  return !site || site === 'same-origin' || site === 'none';
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  const expected = forwardedHost();
  if (origin && expected && origin === `https://${expected}`) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function safePath(input = '') {
  const clean = String(input).replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new HttpError(400, 'Path is outside the workspace');
  return resolved;
}

function relativeFromRoot(absPath) {
  const rel = path.relative(root, absPath);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

async function authorize(req) {
  if (isTrustedPrivateOrigin(req)) return;

  const value = String(req.headers.authorization || '');
  if (!value.startsWith('Bearer ')) throw new HttpError(401, 'Open Mobile Codespace through the private Codespaces port');
  const token = value.slice(7).trim();
  if (!token) throw new HttpError(401, 'GitHub token required');

  if (!codespaceName) {
    const devToken = process.env.MOBILE_DEV_TOKEN || '';
    if (devToken && token === devToken) return;
    throw new HttpError(503, 'Codespace identity is unavailable');
  }

  const digest = createHash('sha256').update(token).digest('hex');
  if ((authCache.get(digest) || 0) > Date.now()) return;

  let response;
  try {
    response = await fetch(`https://api.github.com/user/codespaces/${encodeURIComponent(codespaceName)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mobile-codespace'
      }
    });
  } catch {
    throw new HttpError(503, 'Could not verify GitHub access');
  }
  if (!response.ok) throw new HttpError(401, 'Token cannot access this Codespace');
  const info = await response.json();
  if (info?.name !== codespaceName) throw new HttpError(403, 'Codespace identity mismatch');
  authCache.set(digest, Date.now() + 5 * 60 * 1000);
}

async function runProcess(command, args = [], options = {}) {
  const cwd = safePath(options.cwd || '');
  const timeoutMs = options.timeoutMs ?? 120000;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    let truncated = false, timedOut = false;
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
  const [branchResult, statusResult, remoteResult] = await Promise.all([
    runShell('git branch --show-current 2>/dev/null || true'),
    runShell('git status --porcelain=v1 -b 2>/dev/null || true'),
    runShell('git remote get-url origin 2>/dev/null || true')
  ]);
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
  if (!stat.isDirectory()) throw new HttpError(400, 'Not a directory');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => !ignoredNames.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      path: relativeFromRoot(path.join(dir, entry.name)),
      type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'
    }));
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

async function serveLocalStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const abs = path.resolve(publicDir, requested);
  if (!abs.startsWith(publicDir + path.sep) && abs !== publicDir) return false;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('cache-control', ext === '.html' ? 'no-store' : 'public, max-age=60');
    createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function serveRemoteUi(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!uiFiles.has(requested)) return false;
  try {
    const response = await fetch(new URL(requested, uiBase), { headers: { 'user-agent': 'mobile-codespace-bridge' } });
    if (!response.ok) return false;
    const body = Buffer.from(await response.arrayBuffer());
    const ext = path.extname(requested).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', response.headers.get('content-type') || contentTypes[ext] || 'application/octet-stream');
    res.setHeader('cache-control', requested === 'index.html' ? 'no-store' : 'public, max-age=60');
    res.setHeader('content-length', body.length);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function api(req, res, url) {
  const pathname = url.pathname;
  await authorize(req);

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
      codespace: codespaceName,
      forwardingDomain,
      backendPort: port,
      privateForwarding: true,
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
    if (!stat.isFile()) throw new HttpError(400, 'Not a file');
    if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, 'File is too large for the mobile editor');
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
    if (!rel) throw new HttpError(400, 'Refusing to delete workspace root');
    await fs.rm(safePath(rel), { recursive: true, force: false });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await readJson(req);
    const command = String(body.command || '').trim();
    if (!command) throw new HttpError(400, 'Command is required');
    const result = await runShell(command, body.cwd || '', Math.min(Number(body.timeoutMs || 120000), 600000));
    return json(res, 200, { ok: true, result });
  }

  if (req.method === 'GET' && pathname === '/api/git/status') return json(res, 200, { ok: true, git: await getGitStatus() });

  if (req.method === 'POST' && pathname === '/api/git/action') {
    const body = await readJson(req);
    const allowed = { stageAll: 'git add -A', unstageAll: 'git reset', pull: 'git pull --ff-only', push: 'git push', fetch: 'git fetch --prune' };
    let command = allowed[body.action];
    if (body.action === 'commit') {
      const message = String(body.message || '').trim();
      if (!message) throw new HttpError(400, 'Commit message is required');
      command = `git commit -m ${JSON.stringify(message)}`;
    }
    if (!command) throw new HttpError(400, 'Unsupported Git action');
    const result = await runShell(command, '', 180000);
    return json(res, 200, { ok: true, result, git: await getGitStatus() });
  }

  if (req.method === 'POST' && pathname === '/api/codex') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, 'Prompt is required');
    const mode = body.mode === 'read-only' ? 'read-only' : 'workspace-write';
    const args = ['exec', '--skip-git-repo-check', '--sandbox', mode, '--ask-for-approval', 'never', '--color', 'never', prompt];
    const result = await runProcess('codex', args, { cwd: body.cwd || '', timeoutMs: 600000 });
    return json(res, 200, { ok: true, result });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return json(res, 404, { ok: false, error: 'API route not found' });
    }
    if (await serveLocalStatic(res, url.pathname)) return;
    if (await serveRemoteUi(res, url.pathname)) return;
    if (req.method === 'GET') {
      const fallback = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#111;color:#fff;padding:24px"><h2>Mobile Codespace bridge is running</h2><p>The UI could not be loaded from GitHub Pages. Refresh in a moment.</p></body>`;
      return text(res, 200, fallback, 'text/html; charset=utf-8');
    }
    return text(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return json(res, Number(error?.status || 400), { ok: false, error: error?.message || 'Unknown error' });
  }
});

server.listen(port, host, () => {
  console.log(`Mobile Codespace bridge listening on http://${host}:${port}`);
  console.log(`Workspace root: ${root}`);
  console.log(codespaceName ? `Private Codespaces URL: https://${forwardedHost()}` : 'Running outside GitHub Codespaces');
});
