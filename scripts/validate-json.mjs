import { readFile } from 'node:fs/promises';

const paths = [
  'package.json',
  '.devcontainer/devcontainer.json',
  '.vscode/settings.json',
  '.vscode/extensions.json',
  'extension/package.json'
];

for (const path of paths) {
  const raw = await readFile(path, 'utf8');
  JSON.parse(raw);
  console.log(`ok ${path}`);
}
