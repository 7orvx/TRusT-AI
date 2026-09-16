import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');

const sourceCandidates = [
  path.join(repoRoot, 'appicon-square.png'),
  path.join(desktopRoot, 'icon-source.png'),
  path.join(repoRoot, 'appicon.png')
];

const source = sourceCandidates.find((p) => existsSync(p));
const dest = path.join(desktopRoot, 'icon-source.png');

if (source) {
  if (source !== dest) {
    copyFileSync(source, dest);
    console.log(`[gen-icon] Copied ${source} -> ${dest}`);
  } else {
    console.log(`[gen-icon] Found icon source at ${dest}`);
  }
} else {
  console.error(`[gen-icon] Error: No icon source image found. Checked: ${sourceCandidates.join(', ')}`);
  process.exit(1);
}