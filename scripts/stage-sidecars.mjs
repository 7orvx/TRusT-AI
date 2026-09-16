// Stages the two desktop sidecar binaries where the Tauri shell plugin looks
// for them in DEV mode, so `npm run dev:desktop` works without manual copies.
//
// In dev, the shell resolves sidecars relative to the RUNNING desktop binary:
//   <active Cargo target dir>/debug/<sidecar-name>.exe   (plain name, no triple)
// e.g. E:\rust_target\debug\trust-ai-server.exe
// (tauri-plugin-shell's `relative_command_path` joins the current exe dir with
// the program name and appends `.exe` on Windows — see the shell plugin source.)
//
// The existing build scripts only stage the triple-suffixed names under
// apps/desktop/src-tauri/binaries/ (used by `tauri build` / release bundling).
// This script rebuilds both sidecars AND drops plain-named copies into the
// active Cargo target dir so `tauri dev` finds them. The engine "worked by
// accident" before because `cargo run` had built trust-ai-engine.exe there;
// the orchestrator had to be copied by hand and silently went stale.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  console.log(`[stage-sidecars] ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function fail(msg) {
  console.error(`[stage-sidecars] ${msg}`);
  process.exit(1);
}

// Windows keeps an exe locked while a process created from it is running. The
// most common reason staging fails is a still-running desktop session (its
// sidecars execute exactly the files we are about to overwrite).
const LOCK_HINT =
  '\n[stage-sidecars] The sidecar exe is locked by a running process. Close the TRusT-AI desktop app' +
  '\n[stage-sidecars] (stop `npm run dev:desktop`, or close the window / Ctrl+C the terminal) and retry.' +
  '\n[stage-sidecars] If a zombie `trust-ai-server.exe` or `trust-ai-engine.exe` survives, kill it with:' +
  '\n[stage-sidecars]   taskkill /F /IM trust-ai-server.exe  &&  taskkill /F /IM trust-ai-engine.exe';

function stageFile(source, dest, label) {
  try {
    copyFileSync(source, dest);
    console.log(`[stage-sidecars] staged ${label} -> ${dest}`);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
      console.error(LOCK_HINT);
    }
    throw err;
  }
}

// 1. Resolve the active Cargo target dir (where the desktop shell binary runs
//    from in dev). CARGO_TARGET_DIR wins; otherwise the desktop crate's own
//    target dir (the crate opts out of the root workspace).
const targetRoot = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, 'apps/desktop/src-tauri/target');
const debugDir = path.join(targetRoot, 'debug');
mkdirSync(debugDir, { recursive: true });
console.log(`[stage-sidecars] active Cargo target dir: ${targetRoot}`);

// 2. Rebuild the orchestrator SEA exe (esbuild bundle -> SEA blob -> node.exe
//    copy with injected blob). Output lands in
//    apps/desktop/src-tauri/binaries/trust-ai-server-x86_64-pc-windows-msvc.exe.
//    Must run on Windows (the SEA exe embeds the running node.exe).
if (!process.platform.startsWith('win')) {
  fail('sidecar staging must run on Windows (the SEA server exe embeds node.exe).');
}
// npm is a .cmd batch file on Windows — Node cannot execFileSync a .cmd
// without a shell, and shell:true triggers the DEP0190 deprecation warning.
// Run it through cmd.exe /c instead (static args only, no shell quoting).
const npmCmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
// WEB BUILD FIRST (critical): the orchestrator serves the dashboard from
// apps/web/dist (express.static). Without this step `dev:desktop` ships a
// STALE web build — UI fixes never reach the desktop app no matter how many
// times the source is edited (the exact "I already fixed this" trap).
// Windows: cmd.exe /c npm ... (without /c the cmd opens INTERACTIVELY and
// hangs the staging script — seen as the "Microsoft Windows [version]" prompt).
run(
  npmCmd,
  process.platform === 'win32' ? ['/c', 'npm', 'run', 'build:web'] : ['run', 'build:web'],
  { cwd: repoRoot }
);
const npmArgs = process.platform === 'win32'
  ? ['/c', 'npm', 'run', 'build:desktop']
  : ['run', 'build:desktop'];
run(npmCmd, npmArgs, { cwd: path.join(repoRoot, 'apps/server') });
const serverSource = path.join(
  repoRoot,
  'apps/desktop/src-tauri/binaries/trust-ai-server-x86_64-pc-windows-msvc.exe'
);
if (!existsSync(serverSource)) {
  fail(`server SEA exe not found after build: ${serverSource}`);
}
stageFile(serverSource, path.join(debugDir, 'trust-ai-server.exe'), 'orchestrator');

// The SEA orchestrator loads .env from its own exe dir (see apps/server/src/
// index.ts), so stage a fresh copy of the monorepo root .env next to it.
// NETWORK_NAME / UNISWAP_V4_ROUTER / LLM_PROVIDER / SERVER_PORT etc. then stay
// in sync with the repo config inside the desktop app (previously the desktop
// server ran with process.cwd() = the target dir and silently used defaults).
const envSource = path.join(repoRoot, '.env');
if (existsSync(envSource)) {
  stageFile(envSource, path.join(debugDir, '.env'), 'env');
} else {
  console.log('[stage-sidecars] no root .env found — desktop server will use built-in defaults.');
}

// 3. Build the engine (debug) and make sure a plain-named copy exists in the
//    same target dir the shell resolves sidecars from. When CARGO_TARGET_DIR
//    is set, cargo already places the exe at $CARGO_TARGET_DIR/debug; without
//    it the engine builds into crates/engine/target/debug and we copy over.
try {
  run('cargo', ['build'], { cwd: path.join(repoRoot, 'crates/engine') });
} catch (err) {
  if (/os error 5|Acesso negado|Permission denied/i.test(String(err))) {
    console.error(LOCK_HINT);
  }
  throw err;
}
const engineCandidates = [
  path.join(debugDir, 'trust-ai-engine.exe'), // CARGO_TARGET_DIR set: already placed here
  path.join(repoRoot, 'crates/engine/target/debug/trust-ai-engine.exe') // default target
];
const engineSource = engineCandidates.find((p) => existsSync(p));
if (!engineSource) {
  fail('engine binary not found after cargo build (checked: ' + engineCandidates.join(', ') + ')');
}
stageFile(engineSource, path.join(debugDir, 'trust-ai-engine.exe'), 'engine');

console.log('[stage-sidecars] done. Run `npm run dev:desktop` to start the Tauri shell.');