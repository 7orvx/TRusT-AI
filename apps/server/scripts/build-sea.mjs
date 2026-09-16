// Builds a standalone Windows executable from the esbuild CJS bundle using
// Node's Single Executable Application (SEA) mechanism:
//
//   1. esbuild produces a self-contained CJS bundle (dist/index.cjs) — run via
//      `npm run bundle:desktop` BEFORE this script.
//   2. `node --experimental-sea-config` turns the bundle into a SEA blob.
//   3. The running node.exe is copied and the blob injected with postject.
//   4. The resulting exe is placed in the Tauri sidecar binaries dir with the
//      target-triple suffix Tauri expects:
//      apps/desktop/src-tauri/binaries/trust-ai-server-x86_64-pc-windows-msvc.exe
//
// The injected exe is a full Node runtime + orchestrator in one file, so end
// users never need Node.js installed. Cross-compiling targets are out of scope
// for the MVP: run this on Windows (or in the windows-latest CI job) to
// produce the Windows binary.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tauri validates that the sidecar file for the build target triple exists at
// compile time. Both Windows triples are staged so the crate checks/builds
// from MSVC (CI / native Windows) and GNU (WSL cross-check) toolchains.
const SIDECAR_TRIPLES = ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const distDir = path.join(serverDir, 'dist');
const bundlePath = path.join(distDir, 'index.cjs');
const blobPath = path.join(distDir, 'sea-prep.blob');
const seaConfigPath = path.join(serverDir, 'sea-config.json');
const sidecarDir = path.resolve(serverDir, '../desktop/src-tauri/binaries');

// Sentinel fuse required by SEA (constant across Node versions).
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(msg) {
  console.error(`[build-sea] ${msg}`);
  process.exit(1);
}

if (!process.platform.startsWith('win')) {
  // The SEA exe embeds the running node.exe (a Windows PE), so a non-Windows
  // host would stage an ELF binary named *.exe — broken sidecar. Fail loudly
  // instead: the desktop pipeline builds this exe on Windows or in CI.
  fail('SEA exe must be built on Windows (or in the windows-latest CI job).');
}

// 1. SEA config
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true
    },
    null,
    2
  )
);

// 2. Generate the SEA blob. Node 23+/24 may use --sea-config; fall back to the
// long-standing --experimental-sea-config flag for older releases.
let seaFlag = '--sea-config';
const tryFlag = (flag) => {
  try {
    execFileSync(process.execPath, [flag, seaConfigPath], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
};
if (!tryFlag(seaFlag)) {
  seaFlag = '--experimental-sea-config';
  if (!tryFlag(seaFlag)) {
    fail(`SEA blob generation failed with both --sea-config and --experimental-sea-config.`);
  }
}
console.log(`[build-sea] SEA blob generated (flag: ${seaFlag}).`);

// 3. Copy the running node executable and inject the blob.
mkdirSync(sidecarDir, { recursive: true });
const sidecarExe = path.join(sidecarDir, `trust-ai-server-${SIDECAR_TRIPLES[0]}.exe`);
copyFileSync(process.execPath, sidecarExe);
console.log(`[build-sea] Copied ${process.execPath} -> ${sidecarExe}`);

// postject injects the blob into the copied node.exe. On Windows it also
// strips any existing Authenticode signature (the copied node.exe is signed by
// Microsoft), so the resulting exe behaves like a normal unsigned binary.
try {
  const { default: postject } = await import('postject');
  await postject.inject(sidecarExe, 'NODE_SEA_BLOB', await import('node:fs/promises').then((m) => m.readFile(blobPath)), {
    sentinelFuse: SEA_FUSE
  });
} catch (err) {
  fail(`postject injection failed: ${err.message}`);
}

// Stage the GNU-triple name too so tauri-build validates the crate from a
// WSL cross-check without re-running the SEA build for each triple.
copyFileSync(sidecarExe, path.join(sidecarDir, `trust-ai-server-${SIDECAR_TRIPLES[1]}.exe`));

// 4. Cleanup transient files.
rmSync(seaConfigPath, { force: true });
rmSync(blobPath, { force: true });

console.log(`[build-sea] Standalone server exe ready: ${sidecarExe}`);