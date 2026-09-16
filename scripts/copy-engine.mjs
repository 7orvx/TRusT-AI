// Stages the Windows Rust engine binary as Tauri sidecar(s) with the
// target-triple suffix(es) Tauri expects:
//   apps/desktop/src-tauri/binaries/trust-ai-engine-<triple>.exe
//
// Source selection (in order):
//   1. Native Windows release build: crates/engine/target/release/trust-ai-engine.exe
//   2. WSL cross build:              crates/engine/target/x86_64-pc-windows-gnu/release/trust-ai-engine.exe
//
// Both common Windows triples are staged so the desktop crate checks/builds
// from MSVC (CI / native Windows) and GNU (WSL cross-check) toolchains.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const sourceCandidates = [
  path.join(repoRoot, 'crates/engine/target/release/trust-ai-engine.exe'),
  path.join(repoRoot, 'crates/engine/target/x86_64-pc-windows-gnu/release/trust-ai-engine.exe')
];
const source = sourceCandidates.find((p) => existsSync(p));

if (!source) {
  console.error('[copy-engine] No Windows engine binary found. Build it first:');
  console.error('  Windows: npm run build:engine');
  console.error('  WSL:     npm run build:engine:windows   (needs mingw-w64, see README)');
  process.exit(1);
}

const destDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');
mkdirSync(destDir, { recursive: true });

for (const triple of ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu']) {
  const dest = path.join(destDir, `trust-ai-engine-${triple}.exe`);
  copyFileSync(source, dest);
  console.log(`[copy-engine] staged ${dest}`);
}