//! SurgeCode for Windows — the Tauri shell.
//!
//! This crate is the Windows counterpart of the macOS app's *native* half:
//! it supervises the Node server sidecar, owns the window chrome, and stores
//! secrets. Everything above the transport — connection supervision, state
//! projection, and the entire UI — lives in `src/` and runs in the webview,
//! reusing `@t3tools/client-runtime` rather than hand-porting the wire
//! protocol a third time (macOS hand-ported it into `T3Kit`).
//!
//! See `apps/windows/ARCHITECTURE.md`.

pub mod preferences;
pub mod secrets;
pub mod sidecar;
pub mod window;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _, RunEvent, State};
use tokio::sync::RwLock;

use preferences::LaunchPreferences;
use sidecar::config::{bundled_entry_path, bundled_node_path, default_base_dir, dev_entry_path};
use sidecar::{generate_bootstrap_token, ProcessJob, ServerProcess, SidecarConfig, SidecarState};
use window::Backdrop;

/// Event name the renderer listens on for sidecar lifecycle transitions.
pub const SIDECAR_STATE_EVENT: &str = "sidecar://state";
/// Event name carrying the endpoint once the sidecar has been configured.
pub const SIDECAR_ENDPOINT_EVENT: &str = "sidecar://endpoint";

/// Everything the renderer needs to open its own authenticated connection:
/// the loopback URLs plus the one-time bootstrap token it exchanges for a
/// session/bearer token through the local HTTP auth API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEndpoint {
    pub http_base_url: String,
    pub ws_base_url: String,
    pub bootstrap_token: String,
    pub port: u16,
    pub host: String,
    pub base_dir: String,
    pub log_directory: String,
}

struct RunningSidecar {
    process: ServerProcess,
    endpoint: SidecarEndpoint,
}

pub struct AppState {
    job: Arc<ProcessJob>,
    running: Arc<RwLock<Option<RunningSidecar>>>,
    base_dir: PathBuf,
    resource_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingEndpoint {
    /// `http://<lan-ip>:<port>` — the origin half of the pairing URL the
    /// mobile scanner parses (`http://<lan-ip>:<port>/pair#token=<code>`).
    pub origin: String,
    pub address: String,
    pub port: u16,
}

#[tauri::command]
async fn sidecar_endpoint(state: State<'_, AppState>) -> Result<Option<SidecarEndpoint>, String> {
    Ok(state
        .running
        .read()
        .await
        .as_ref()
        .map(|running| running.endpoint.clone()))
}

#[tauri::command]
async fn sidecar_snapshot(state: State<'_, AppState>) -> Result<SidecarState, String> {
    Ok(state
        .running
        .read()
        .await
        .as_ref()
        .map_or(SidecarState::Idle, |running| running.process.snapshot()))
}

#[tauri::command]
async fn sidecar_restart(state: State<'_, AppState>) -> Result<(), String> {
    let running = state.running.read().await;
    let Some(running) = running.as_ref() else {
        return Err("the sidecar has not been configured yet".to_owned());
    };
    running.process.stop().await;
    running.process.start().await;
    Ok(())
}

#[tauri::command]
async fn launch_preferences(state: State<'_, AppState>) -> Result<LaunchPreferences, String> {
    Ok(LaunchPreferences::load(&state.base_dir))
}

/// Persists the launch preferences. `allowLanAccess` and
/// `tailscaleServeEnabled` are fixed per sidecar process, so they only take
/// effect on the next launch — the renderer surfaces that in Settings, the
/// same way the macOS app does.
#[tauri::command]
async fn set_launch_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    preferences: LaunchPreferences,
) -> Result<(), String> {
    preferences
        .save(&state.base_dir)
        .map_err(|error| format!("could not save preferences: {error}"))?;
    if let Some(main) = app.get_webview_window("main") {
        window::apply_window_chrome(&main, preferences.backdrop)?;
    }
    Ok(())
}

#[tauri::command]
fn set_backdrop(app: AppHandle, backdrop: Backdrop) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is not available".to_owned())?;
    window::apply_window_chrome(&main, backdrop)
}

/// The LAN origin the pairing QR encodes. Uses the outbound-interface address
/// rather than enumerating every adapter: a machine with Hyper-V, WSL and a
/// VPN has several private ranges, and only the default-route one is
/// reachable from a phone on the same Wi-Fi. Connecting a UDP socket sends no
/// packets — it just asks the routing table which source address would be
/// used.
#[tauri::command]
async fn pairing_endpoint(state: State<'_, AppState>) -> Result<Option<PairingEndpoint>, String> {
    let running = state.running.read().await;
    let Some(running) = running.as_ref() else {
        return Ok(None);
    };
    if running.endpoint.host != "0.0.0.0" {
        // Loopback bind: nothing off-machine can reach this server, so there
        // is no pairing URL to show.
        return Ok(None);
    }
    let Some(address) = outbound_address() else {
        return Ok(None);
    };
    Ok(Some(PairingEndpoint {
        origin: format!("http://{address}:{}", running.endpoint.port),
        address,
        port: running.endpoint.port,
    }))
}

fn outbound_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

#[tauri::command]
fn secret_read(device_id: String) -> Result<Option<String>, String> {
    secrets::read(&device_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_write(device_id: String, token: String) -> Result<(), String> {
    secrets::write(&device_id, &token).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_delete(device_id: String) -> Result<(), String> {
    secrets::delete(&device_id).map_err(|error| error.to_string())
}

/// Resolves the server entry, preferring an installed payload and falling back
/// to a dev checkout, mirroring `SidecarEntryPathResolver`.
fn resolve_entry_path(resource_dir: Option<&PathBuf>) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("SERGECODE_SERVER_ENTRY") {
        let candidate = PathBuf::from(explicit);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(bundled) = bundled_entry_path(resource_dir.map(PathBuf::as_path)) {
        return Some(bundled);
    }
    let start = std::env::current_dir().ok()?;
    dev_entry_path(&start)
}

async fn boot_sidecar(app: AppHandle, state_handle: Arc<RwLock<Option<RunningSidecar>>>) {
    // Scoped so the managed-state borrow ends before the first `await`; the
    // rest of this function only needs owned copies.
    let (base_dir, resource_dir, job) = {
        let app_state = app.state::<AppState>();
        (
            app_state.base_dir.clone(),
            app_state.resource_dir.clone(),
            Arc::clone(&app_state.job),
        )
    };

    let preferences = LaunchPreferences::load(&base_dir);

    let fail = |reason: String| {
        let _ = app.emit(
            SIDECAR_STATE_EVENT,
            SidecarState::Crashed {
                reason,
                restart_attempt: 0,
            },
        );
    };

    let Some(entry_path) = resolve_entry_path(resource_dir.as_ref()) else {
        fail(
            "Could not find the SergeCode server bundle. Reinstall the app, or set \
             SERGECODE_SERVER_ENTRY to a built apps/server/dist/bin.mjs."
                .to_owned(),
        );
        return;
    };

    // A packaged install embeds a version-pinned runtime, so skip the PATH
    // scan and version probe entirely when it is present.
    let node_path = match bundled_node_path(resource_dir.as_deref()) {
        Some(path) => path,
        None => match sidecar::node::locate(None).await {
            Ok(located) => located.path,
            Err(error) => {
                fail(format!(
                    "Could not locate a compatible Node.js runtime: {error}"
                ));
                return;
            }
        },
    };

    let config = match SidecarConfig::new(
        node_path,
        entry_path,
        preferences.bind_host().to_owned(),
        Some(base_dir),
        preferences.tailscale_serve_enabled,
    ) {
        Ok(config) => config,
        Err(error) => {
            fail(format!("Could not configure the server sidecar: {error}"));
            return;
        }
    };

    let token = generate_bootstrap_token();
    let endpoint = SidecarEndpoint {
        http_base_url: config.http_base_url(),
        ws_base_url: config.ws_base_url(),
        bootstrap_token: token.clone(),
        port: config.port,
        host: config.host.clone(),
        base_dir: config.base_dir.to_string_lossy().into_owned(),
        log_directory: config.log_directory.to_string_lossy().into_owned(),
    };

    let process = ServerProcess::spawn(config, token, job);
    let mut states = process.states();

    {
        let mut guard = state_handle.write().await;
        *guard = Some(RunningSidecar {
            process: process.clone(),
            endpoint: endpoint.clone(),
        });
    }
    let _ = app.emit(SIDECAR_ENDPOINT_EVENT, endpoint);

    // Forward every transition to the renderer, starting with the current
    // value so a listener attached after boot is never left blank.
    let forwarding = app.clone();
    tokio::spawn(async move {
        let _ = forwarding.emit(SIDECAR_STATE_EVENT, states.borrow_and_update().clone());
        while states.changed().await.is_ok() {
            let state = states.borrow_and_update().clone();
            let _ = forwarding.emit(SIDECAR_STATE_EVENT, state);
        }
    });

    process.start().await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init());

    // A second launch must focus the existing window instead of spawning a
    // second sidecar against the same SQLite base dir.
    #[cfg(windows)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            sidecar_endpoint,
            sidecar_snapshot,
            sidecar_restart,
            launch_preferences,
            set_launch_preferences,
            set_backdrop,
            pairing_endpoint,
            secret_read,
            secret_write,
            secret_delete,
        ])
        .setup(|app| {
            let base_dir = default_base_dir()
                .map_err(|error| format!("could not resolve the data directory: {error}"))?;
            let resource_dir = app.path().resource_dir().ok();
            let preferences = LaunchPreferences::load(&base_dir);

            let job = Arc::new(ProcessJob::create()?);
            let running = Arc::new(RwLock::new(None));
            app.manage(AppState {
                job,
                running: Arc::clone(&running),
                base_dir,
                resource_dir,
            });

            if let Some(main) = app.get_webview_window("main") {
                // Errors here are cosmetic (no Mica, light title bar); never
                // fail launch over them.
                if let Err(error) = window::apply_window_chrome(&main, preferences.backdrop) {
                    eprintln!("window: {error}");
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(boot_sidecar(handle, running));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the SurgeCode application");

    app.run(|app_handle, event| {
        // Ask the sidecar to shut down cleanly on the way out. The job object
        // is the guarantee (it kills the tree even on a hard crash); this is
        // the polite path that lets SQLite flush first.
        if matches!(event, RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            let running = Arc::clone(&state.running);
            tauri::async_runtime::block_on(async move {
                if let Some(sidecar) = running.read().await.as_ref() {
                    sidecar.process.stop().await;
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_serializes_with_camel_case_keys() {
        let endpoint = SidecarEndpoint {
            http_base_url: "http://127.0.0.1:3773".to_owned(),
            ws_base_url: "ws://127.0.0.1:3773".to_owned(),
            bootstrap_token: "tok".to_owned(),
            port: 3773,
            host: "127.0.0.1".to_owned(),
            base_dir: "C:\\base".to_owned(),
            log_directory: "C:\\base\\logs\\sidecar".to_owned(),
        };
        let value = serde_json::to_value(&endpoint).expect("serializes");
        assert_eq!(value["httpBaseUrl"], "http://127.0.0.1:3773");
        assert_eq!(value["wsBaseUrl"], "ws://127.0.0.1:3773");
        assert_eq!(value["bootstrapToken"], "tok");
        assert_eq!(value["logDirectory"], "C:\\base\\logs\\sidecar");
    }

    #[test]
    fn an_explicit_server_entry_override_wins_when_it_exists() {
        // Point the override at a file that certainly exists so the resolver
        // has to prefer it over any bundled/dev candidate.
        let this_file = PathBuf::from(file!());
        if this_file.is_file() {
            // SAFETY: single-threaded test process; no other thread reads the
            // environment concurrently.
            unsafe { std::env::set_var("SERGECODE_SERVER_ENTRY", &this_file) };
            assert_eq!(resolve_entry_path(None), Some(this_file));
            unsafe { std::env::remove_var("SERGECODE_SERVER_ENTRY") };
        }
    }
}
