//! TRusT-AI Desktop Shell
//!
//! A thin Tauri (WebView2) wrapper that:
//! 1. Spawns the Node/TS orchestrator and the Rust engine as *sidecars*
//!    (standalone exes bundled by the installer — the user never installs
//!    Node.js or Rust).
//! 2. Hosts the built React dashboard in a native window pointed at the
//!    orchestrator's WebSocket/REST gateway (`ws://localhost:3001` /
//!    `http://localhost:3001`), the same contract the browser dev flow uses.
//! 3. Kills both sidecars when the window closes, so no orphan processes hold
//!    port 3001.
//!
//! Security: the orchestrator is spawned with `SERVER_BIND=127.0.0.1` so the
//! packaged app is only reachable from the user's own machine (no LAN exposure
//! — see docs/SECURITY.md). The engine is told where the orchestrator lives
//! via `SERVER_URL`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Child handles for every sidecar we spawn, so we can terminate them on exit.
struct Sidecars(Mutex<Vec<CommandChild>>);

/// Spawns a bundled sidecar executable, sets its env vars, and returns a
/// handle. Output is drained on a background thread (reading the receiver
/// prevents the child from blocking once the pipe fills).
///
/// On failure the resolved sidecar name + the underlying OS error are returned
/// so the shell can tell the user *why* the process did not start (missing
/// binary, locked file, spawn error) instead of silently running without it.
fn spawn_sidecar(app: &tauri::AppHandle, name: &str, envs: &[(&str, &str)]) -> Result<CommandChild, String> {
    let mut command = app
        .shell()
        .sidecar(name)
        .map_err(|e| format!("sidecar '{}' could not be resolved: {}", name, e))?;
    for (key, value) in envs {
        command = command.env(key, value);
    }
    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("sidecar '{}' failed to spawn: {}", name, e))?;

    // Drain stdout/stderr + exit status so the child never blocks on a full
    // pipe and the user sees why a sidecar died. In release builds the app
    // runs with `windows_subsystem = "windows"` (no console), so writes may
    // fail — ignore errors instead of panicking.
    let name_owned = name.to_string();
    std::thread::spawn(move || {
        let mut out = std::io::stdout();
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let _ = writeln!(out, "[sidecar:{name_owned}] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    let _ = writeln!(out, "[sidecar:{name_owned}] terminated: {:?}", payload);
                }
                CommandEvent::Error(err) => {
                    let _ = writeln!(out, "[sidecar:{name_owned}] error: {}", err);
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// True when the orchestrator accepts TCP connections on 127.0.0.1:3001.
fn orchestrator_is_up() -> bool {
    let Ok(addr) = "127.0.0.1:3001".parse::<std::net::SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Spawns the orchestrator with a small retry loop that verifies it actually
/// came up. The engine keeps retrying its own HTTP connection, but the
/// dashboard is silent until the orchestrator accepts the first trigger, so a
/// transient failure (AV scan, locked file, or a leftover process holding port
/// 3001 — the new server then exits with EADDRINUSE right after spawn) should
/// not leave the app dead: retry a few times with the reason printed between
/// attempts, killing the failed child on each round.
fn spawn_server_sidecar(app: &tauri::AppHandle) -> Result<CommandChild, String> {
    let envs = [
        ("SERVER_BIND", "127.0.0.1"),
        ("TRUST_AI_DESKTOP", "1"),
        ("SERVER_PORT", "3001"),
    ];
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempts = 0;
    loop {
        attempts += 1;
        let child = match spawn_sidecar(app, "trust-ai-server", &envs) {
            Ok(child) => child,
            Err(err) if attempts < MAX_ATTEMPTS => {
                let _ = writeln!(
                    std::io::stderr(),
                    "[desktop] orchestrator sidecar attempt {}/{} failed — retrying in 2s: {}",
                    attempts, MAX_ATTEMPTS, err
                );
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            Err(err) => return Err(err),
        };

        // Spawn succeeded — wait for the orchestrator to actually accept
        // connections. If a stale process already holds 127.0.0.1:3001 the new
        // server dies right after startup (EADDRINUSE); kill the child and
        // retry so the dashboard is not left silent by a zombie holder.
        let mut waited = Duration::ZERO;
        while waited < Duration::from_secs(12) {
            if orchestrator_is_up() {
                return Ok(child);
            }
            std::thread::sleep(Duration::from_millis(500));
            waited += Duration::from_millis(500);
        }

        let _ = writeln!(
            std::io::stderr(),
            "[desktop] orchestrator did not come up on 127.0.0.1:3001 (attempt {}/{}) — killing and retrying.",
            attempts, MAX_ATTEMPTS
        );
        let _ = child.kill();
        if attempts >= MAX_ATTEMPTS {
            return Err("orchestrator sidecar never became reachable on 127.0.0.1:3001 — check for a stale process holding the port (taskkill /F /IM trust-ai-server.exe)".into());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn kill_all_children(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Sidecars>() {
        let mut children = state.0.lock().unwrap();
        for child in children.drain(..) {
            let _ = child.kill();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Orchestrator: loopback only, desktop mode. Port stays the default
            // 3001 (same contract the dashboard hardcodes).
            let server = spawn_server_sidecar(&handle);

            // Engine: point it at the local orchestrator. It already falls
            // back to 127.0.0.1, but being explicit avoids any discovery delay.
            let engine = spawn_sidecar(
                &handle,
                "trust-ai-engine",
                &[
                    ("SERVER_URL", "http://127.0.0.1:3001"),
                    ("TRUST_AI_DESKTOP", "1"),
                ],
            );

            if let Err(err) = &server {
                let _ = writeln!(std::io::stderr(), "[desktop] orchestrator sidecar error: {}", err);
            }
            if let Err(err) = &engine {
                let _ = writeln!(std::io::stderr(), "[desktop] engine sidecar error: {}", err);
            }

            app.manage(Sidecars(Mutex::new(
                [server, engine].into_iter().flatten().collect(),
            )));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the TRusT-AI desktop shell")
        .run(|app_handle, event| {
            // Window closed → kill the orchestrator + engine so port 3001 is
            // released and no orphan processes linger.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                kill_all_children(app_handle);
            }
        });
}