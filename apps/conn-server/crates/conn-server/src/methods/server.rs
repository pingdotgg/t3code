//! `server.*`, the config and access streams, and connection-level methods. Owner: the
//! server track (config, auth and CLI).
//!
//! What Conn web and desktop call when they connect, before and while they show the thread
//! list (read from `packages/client-runtime/src/rpc/session.ts`, `state/server.ts` and
//! `apps/web/src/appInit.tsx`), and what Settings calls. Each answer is honest for a server
//! that has no terminals, devices, clones or panels: empty, and streams stay open, because
//! Conn resubscribes or reconnects when one of these streams ends.
//!
//! Scopes: `scopes.rs`.

use std::sync::Arc;

use conn_contract::{ServerConfig, ServerProcessSignal, ServerSignalProcessInput};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use super::Deps;
use crate::{
    auth::AccessChange,
    diagnostics,
    environment::Environment,
    table::{Failure, ItemStream, MethodTable},
};

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let restart = deps
        .environment
        .as_ref()
        .map(|e| e.restart.clone())
        .unwrap_or_default();
    table.unary("server.restart", move |_, _: Value| {
        let result = restart.request().map_err(|error| Failure::fail(&error));
        async { result }
    });
    table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
    // Activity leases gate the periodic provider probe (`BackgroundPolicy`).
    let status = deps.provider_status.clone();
    table.unary("server.reportClientActivity", move |_, input: Value| {
        status.report_activity(&input);
        async { Ok(Value::Null) }
    });
    if deps.preview.is_none() {
        table.unary("preview.reportProfiles", |_, _: Value| async {
            Ok(Value::Null)
        });
    }

    table.stream("subscribeProjectClones", |_, _: Value| async {
        Ok(open_stream(vec![json!([])]))
    });
    if deps.devices.is_none() {
        table.stream("subscribeDeviceState", |_, _: Value| async {
            Ok(open_stream(vec![json!({
            "hostStatus": "disabled",
            "hostStatuses": {},
            "hosts": [],
            "devices": [],
            "sessions": [],
            "onboardingCompleted": false,
            "agentAccessEnabled": false,
                "hubBasePath": "",
                "revision": 0,
            })]))
        });
    }

    // File reads, and on macOS two subprocesses: off the event loop.
    table.unary("server.getHostResources", |_, _: Value| async move {
        blocking(diagnostics::host_resources).await
    });
    table.unary("server.getProcessDiagnostics", |_, _: Value| async move {
        blocking(diagnostics::process_diagnostics).await
    });
    // The contract's signal type: an unknown signal fails at decode, as in the T3 server.
    table.unary(
        "server.signalProcess",
        |_, input: ServerSignalProcessInput| async move {
            let signal = match input.signal {
                ServerProcessSignal::SIGINT => "SIGINT",
                ServerProcessSignal::SIGKILL => "SIGKILL",
            };
            blocking(move || diagnostics::signal_process(input.pid, input.start_time_ms, signal))
                .await
        },
    );

    let Some(environment) = deps.environment.clone() else {
        return;
    };

    let (env, providers) = (environment.clone(), deps.clone());
    table.unary("server.getConfig", move |_, _: Value| {
        let config = server_config(&env, current_providers(&providers));
        async move { config }
    });
    let providers = deps.clone();
    table.unary("server.refreshProviders", move |_, input: Value| {
        let deps = providers.clone();
        async move {
            // T3 awaits the refresh before it answers. `modelCatalogOnly` answers no providers.
            if input["modelCatalogOnly"] == true {
                return Ok(json!({ "providers": [] }));
            }
            super::provider::refresh(&deps, input["instanceId"].as_str()).await;
            Ok(json!({ "providers": current_providers(&deps) }))
        }
    });

    // T3's `redactServerSettingsForClient`, as `server.getConfig` sends it.
    let env = environment.clone();
    table.unary("server.getSettings", move |_, _: Value| {
        let settings = env.settings.for_client();
        async move { Ok(settings) }
    });
    // T3 reads `<state>/logs/server.trace.ndjson` and its rotations. This server writes no
    // trace, but its state folder may hold an earlier T3 server's: read them as T3 does.
    let env = environment.clone();
    table.unary("server.getTraceDiagnostics", move |_, _: Value| {
        let state_dir = env.state_dir.clone();
        async move {
            let read_at = conn_support::time::now_iso();
            blocking(move || crate::trace_diagnostics::read(&state_dir, &read_at)).await
        }
    });
    // T3 publishes a status only when its offline `t3 doctor` repairs this database, and
    // `null` otherwise. This server has no such command, so the status stays `null` and the
    // client shows no database notice.
    table.stream("server.getDatabaseStorage", |_, _: Value| async {
        Ok(open_stream(vec![Value::Null]))
    });
    table.unary("server.reclaimDatabaseSpace", |_, _: Value| async {
        Err::<Value, _>(Failure::fail(&json!({
            "_tag": "DatabaseReclaimError",
            "reason": "This server cannot reclaim database space.",
        })))
    });

    let env = environment.clone();
    table.unary("server.updateSettings", move |_, input: UpdateSettings| {
        let env = env.clone();
        async move {
            blocking(move || {
                env.settings
                    .update(input.patch, input.provider_instance_mutation)
                    .map_err(|e| Failure::Fail(e.to_contract()))
            })
            .await?
        }
    });
    let env = environment.clone();
    table.unary("server.upsertKeybinding", move |_, input: Value| {
        let env = env.clone();
        async move {
            blocking(move || {
                env.keybindings
                    .upsert(input)
                    .map(|s| s.to_json())
                    .map_err(Failure::Fail)
            })
            .await?
        }
    });
    let env = environment.clone();
    table.unary("server.removeKeybinding", move |_, input: Value| {
        let env = env.clone();
        async move {
            blocking(move || {
                env.keybindings
                    .remove(input)
                    .map(|s| s.to_json())
                    .map_err(Failure::Fail)
            })
            .await?
        }
    });

    let (env, providers) = (environment.clone(), deps.clone());
    let themes = deps.files.as_ref().map(|files| files.themes.clone());
    table.stream("subscribeServerConfig", move |_, input: Value| {
        // Subscribed before the snapshot is built: a reload in between sends a new one.
        let descriptor = env.subscribe_descriptor();
        let config = server_config(&env, current_providers(&providers));
        let env = env.clone();
        let deps = providers.clone();
        // Only clients that ask get `environmentThemesUpdated`; older ones die on it.
        let themes = themes
            .clone()
            .filter(|_| input["environmentThemes"] == Value::Bool(true));
        async move { Ok(config_stream(env, deps, config?, descriptor, themes)) }
    });
    let env = environment.clone();
    table.stream("subscribeAuthAccess", move |ctx, _: Value| {
        let env = env.clone();
        async move {
            let current = ctx.principal.as_ref().map(|p| p.session_id.clone());
            Ok(access_stream(env, current))
        }
    });
    table.stream("subscribeServerLifecycle", move |_, _: Value| {
        let events = lifecycle_events(&environment);
        async move { Ok(open_stream(events)) }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettings {
    patch: Value,
    #[serde(default)]
    provider_instance_mutation: Option<Value>,
}

/// Runs file or process work off the event loop.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Failure> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| Failure::die(e.to_string()))
}

fn current_providers(deps: &Deps) -> Vec<Value> {
    super::provider::server_providers(
        deps,
        &conn_support::time::iso_from_ms(conn_support::time::now_ms()),
    )
}

/// `ServerConfig`, decoded into the contract type: a required field this server does not
/// fill fails here (and in the test below), not in a client. The optional flags come from
/// [`environment::config_flags`], next to the descriptor's capabilities. `providers` comes
/// from `provider::server_providers`.
pub fn server_config(environment: &Environment, providers: Vec<Value>) -> Result<Value, Failure> {
    let state_dir = environment.state_dir.display();
    let keybindings = environment.keybindings.snapshot();
    let mut config: ServerConfig = conn_contract::from_json(json!({
        "environment": environment.descriptor(),
        "auth": environment.auth.descriptor(),
        "cwd": environment.cwd,
        "keybindingsConfigPath": environment.keybindings.path(),
        "keybindings": keybindings.keybindings,
        "issues": keybindings.issues,
        "providers": providers,
        "availableEditors": [],
        "observability": {
            "logsDirectoryPath": format!("{state_dir}/logs"),
            "localTracingEnabled": false,
            "otlpTracesEnabled": false,
            "otlpMetricsEnabled": false,
        },
        "settings": environment.settings.for_client(),
    }))
    .map_err(|e| Failure::die(format!("ServerConfig does not decode: {e}")))?;
    // The engine's managed folders (`EngineConfig::home` is the state folder).
    config.new_projects_root = Some(environment.state_dir.join("projects").display().to_string());
    config.scratch_workspace_root =
        Some(environment.state_dir.join("scratch").display().to_string());
    crate::environment::config_flags(&mut config);
    // The host's clock when the config is built, so clients count live times against it
    // (T3 `ws.ts`, 2d80cb6bc7). Only a subscription's first snapshot is fresh, as in T3.
    config.server_time = Some(conn_support::time::iso_from_ms(conn_support::time::now_ms()));
    Ok(conn_contract::to_json(&config))
}

/// How often a theme subscription looks at the themes folder.
const THEME_POLL: std::time::Duration = std::time::Duration::from_secs(1);

fn themes_event(snapshot: &conn_files::themes::Snapshot) -> Value {
    json!({ "version": 1, "type": "environmentThemesUpdated", "payload": { "themes": *snapshot.themes } })
}

/// `PROVIDER_STATUS_DEBOUNCE_MS`.
const PROVIDER_STATUS_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(200);

/// The config snapshot, then `settingsUpdated` after each settings write and
/// `keybindingsUpdated` after each keybinding write, until the client unsubscribes. A new
/// descriptor (`crate::reload`) sends a whole new `snapshot`: the contract has no event for
/// the environment alone, and clients replace their config with each snapshot.
fn config_stream(
    env: Arc<Environment>,
    deps: Deps,
    config: Value,
    mut descriptor: tokio::sync::watch::Receiver<Value>,
    themes: Option<conn_files::themes::Themes>,
) -> ItemStream {
    let (tx, rx) = mpsc::channel::<Result<Value, Failure>>(4);
    let mut theme_changes = themes.as_ref().map(conn_files::themes::Themes::subscribe);
    let mut theme_poll = tokio::time::interval(THEME_POLL);
    theme_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut settings = env.settings.subscribe();
    let mut keybindings = env.keybindings.subscribe();
    let mut providers = deps.provider_status.subscribe();
    settings.mark_unchanged();
    keybindings.mark_unchanged();
    providers.mark_unchanged();
    // T3 de-dupes the provider list against the last one seen, then debounces 200 ms
    // (`PROVIDER_STATUS_DEBOUNCE_MS`): only the last list of a burst goes out.
    let mut seen_providers = config["providers"].clone();
    let mut pending_providers: Option<Value> = None;
    let debounce = tokio::time::sleep(PROVIDER_STATUS_DEBOUNCE);
    tokio::spawn(async move {
        tokio::pin!(debounce);
        let snapshot = json!({ "version": 1, "type": "snapshot", "config": config });
        if tx.send(Ok(snapshot)).await.is_err() {
            return;
        }
        // The theme stream sends the current set first, then each change after it.
        let mut themes_seen = None;
        if let Some(themes) = &themes {
            // Marked before the read: a publish after it fires `changed` and is sent next.
            if let Some(changes) = &mut theme_changes {
                changes.mark_unchanged();
            }
            let reader = themes.clone();
            let Ok(current) = tokio::task::spawn_blocking(move || reader.refresh()).await else {
                return;
            };
            themes_seen = Some(current.seq);
            if tx.send(Ok(themes_event(&current))).await.is_err() {
                return;
            }
        }
        loop {
            let event = tokio::select! {
                changed = async { theme_changes.as_mut()?.changed().await.ok() }, if theme_changes.is_some() => {
                    let (Some(()), Some(themes)) = (changed, &themes) else { break };
                    let current = themes.current();
                    if themes_seen.is_some_and(|seen| current.seq <= seen) { continue; }
                    themes_seen = Some(current.seq);
                    themes_event(&current)
                }
                _ = theme_poll.tick(), if themes.is_some() => {
                    // T3 watches the folder; this re-reads it when its listing changed.
                    if let Some(themes) = themes.clone() {
                        let _ = tokio::task::spawn_blocking(move || themes.refresh()).await;
                    }
                    continue;
                }
                changed = descriptor.changed() => {
                    if changed.is_err() { break; }
                    let Ok(config) = server_config(&env, current_providers(&deps)) else { continue };
                    seen_providers = config["providers"].clone();
                    pending_providers = None;
                    json!({ "version": 1, "type": "snapshot", "config": config })
                }
                changed = settings.changed() => {
                    if changed.is_err() { break; }
                    json!({ "version": 1, "type": "settingsUpdated", "payload": { "settings": env.settings.for_client() } })
                }
                changed = keybindings.changed() => {
                    if changed.is_err() { break; }
                    let snapshot = env.keybindings.snapshot();
                    json!({ "version": 1, "type": "keybindingsUpdated", "payload": { "keybindings": snapshot.keybindings, "issues": snapshot.issues } })
                }
                changed = providers.changed() => {
                    if changed.is_err() { break; }
                    let list = Value::Array(current_providers(&deps));
                    if list == seen_providers { continue; }
                    seen_providers = list.clone();
                    pending_providers = Some(list);
                    debounce.as_mut().reset(tokio::time::Instant::now() + PROVIDER_STATUS_DEBOUNCE);
                    continue;
                }
                () = &mut debounce, if pending_providers.is_some() => {
                    let Some(list) = pending_providers.take() else { continue };
                    json!({ "version": 1, "type": "providerStatuses", "payload": { "providers": list } })
                }
                _ = tx.closed() => break,
            };
            if tx.send(Ok(event)).await.is_err() {
                break;
            }
        }
    });
    rx
}

/// `subscribeAuthAccess`: a snapshot of pairing links and client sessions, then one event per
/// change, each with the next revision.
fn access_stream(env: Arc<Environment>, current: Option<String>) -> ItemStream {
    let (tx, rx) = mpsc::channel::<Result<Value, Failure>>(8);
    let mut changes = env.auth.subscribe();
    tokio::spawn(async move {
        let auth = &env.auth;
        let current = current.as_deref();
        let snapshot = |revision: u64| {
            json!({
                "version": 1,
                "revision": revision,
                "type": "snapshot",
                "payload": {
                    "pairingLinks": auth.pairing_links(),
                    "clientSessions": auth.client_sessions(current),
                },
            })
        };
        let mut revision = 1;
        if tx.send(Ok(snapshot(revision))).await.is_err() {
            return;
        }
        loop {
            let change = tokio::select! {
                change = changes.recv() => change,
                _ = tx.closed() => break,
            };
            revision += 1;
            let event = match change {
                Ok(AccessChange::PairingLinkUpserted(id)) => match auth.pairing_link(&id) {
                    Some(link) => event(revision, "pairingLinkUpserted", json!(link)),
                    None => continue,
                },
                Ok(AccessChange::PairingLinkRemoved(id)) => {
                    event(revision, "pairingLinkRemoved", json!({ "id": id }))
                }
                Ok(AccessChange::ClientUpserted(id)) => match auth.client_session(&id, current) {
                    Some(session) => event(revision, "clientUpserted", json!(session)),
                    None => continue,
                },
                Ok(AccessChange::ClientRemoved(id)) => {
                    event(revision, "clientRemoved", json!({ "sessionId": id }))
                }
                Err(broadcast::error::RecvError::Lagged(_)) => snapshot(revision),
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if tx.send(Ok(event)).await.is_err() {
                break;
            }
        }
    });
    rx
}

fn event(revision: u64, kind: &str, payload: Value) -> Value {
    json!({ "version": 1, "revision": revision, "type": kind, "payload": payload })
}

/// The retained `welcome` and `ready` events every lifecycle subscriber receives first.
/// `FirstRunGate` renders nothing until it has a welcome that is not pending.
fn lifecycle_events(environment: &Environment) -> Vec<Value> {
    let project_name = environment
        .cwd
        .file_name()
        .map_or_else(|| "conn".into(), |n| n.to_string_lossy().into_owned());
    vec![
        json!({
            "version": 1,
            "sequence": 0,
            "type": "welcome",
            "payload": {
                "environment": environment.descriptor(),
                "cwd": environment.cwd,
                "projectName": project_name,
                "bootstrapStatus": "complete",
            },
        }),
        json!({
            "version": 1,
            "sequence": 1,
            "type": "ready",
            "payload": { "at": conn_support::time::iso_from_ms(conn_support::time::now_ms()), "environment": environment.descriptor() },
        }),
    ]
}

/// A stream that sends `first` and then stays open until the client unsubscribes.
fn open_stream(first: Vec<Value>) -> ItemStream {
    let (tx, rx) = mpsc::channel::<Result<Value, Failure>>(first.len().max(1));
    for value in first {
        tx.try_send(Ok(value))
            .expect("the channel holds every first value");
    }
    tokio::spawn(async move { tx.closed().await });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{ClientInfo, PAIRING_CODE_TTL_MS};

    fn environment() -> (Arc<Environment>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("conn-server-cfg-{}", crate::auth::random_hex(6)));
        let env =
            Environment::load(&dir, Some("Test".into()), dir.clone(), Default::default()).unwrap();
        (Arc::new(env), dir)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_config_stream_follows_settings_keybindings_and_providers() {
        let (env, dir) = environment();
        let config = server_config(&env, Vec::new()).unwrap();
        assert!(config["keybindings"].as_array().unwrap().len() > 10);
        assert_eq!(config["auth"]["policy"], "remote-reachable");
        let before = conn_support::time::iso_from_ms(conn_support::time::now_ms());
        let server_time = config["serverTime"].as_str().unwrap();
        assert!(
            server_time.len() == 24 && server_time <= before.as_str(),
            "serverTime is the host clock as an ISO time: {server_time}"
        );
        let deps = Deps {
            providers: vec![
                std::sync::Arc::new(conn_provider_acp::AcpProvider::with_settings(
                    "grok".into(),
                    &conn_provider_acp::GROK,
                    conn_provider_acp::AcpConfig::default(),
                    conn_provider_acp::GrokSettings::default(),
                )) as std::sync::Arc<dyn conn_provider::Provider>,
            ]
            .into(),
            ..Deps::default()
        };
        let mut stream = config_stream(
            env.clone(),
            deps.clone(),
            config,
            env.subscribe_descriptor(),
            None,
        );
        assert_eq!(stream.recv().await.unwrap().unwrap()["type"], "snapshot");
        env.settings
            .update(json!({ "enableAgentBrowserAccess": false }), None)
            .unwrap();
        let event = stream.recv().await.unwrap().unwrap();
        assert_eq!(event["type"], "settingsUpdated");
        assert_eq!(
            event["payload"]["settings"]["enableAgentBrowserAccess"],
            false
        );
        env.keybindings
            .upsert(json!({ "key": "mod+shift+u", "command": "sidebar.toggle" }))
            .unwrap();
        assert_eq!(
            stream.recv().await.unwrap().unwrap()["type"],
            "keybindingsUpdated"
        );
        // A provider refresh sends the new list (`providerStatuses`).
        super::super::provider::refresh(&deps, None).await;
        let event = stream.recv().await.unwrap().unwrap();
        assert_eq!(event["type"], "providerStatuses");
        assert_eq!(event["payload"]["providers"][0]["instanceId"], "grok");
        // A burst of refreshes sends one list, the last, after T3's 200 ms debounce.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        super::super::provider::refresh(&deps, None).await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        super::super::provider::refresh(&deps, None).await;
        let started = std::time::Instant::now();
        let event = stream.recv().await.unwrap().unwrap();
        assert_eq!(event["type"], "providerStatuses");
        assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        let more = tokio::time::timeout(std::time::Duration::from_millis(400), stream.recv()).await;
        assert!(more.is_err(), "one list per burst");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_access_stream_shows_links_and_clients_as_they_change() {
        let (env, dir) = environment();
        let mut stream = access_stream(env.clone(), Some("nobody".into()));
        let snapshot = stream.recv().await.unwrap().unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["revision"], 1);
        let code = env
            .auth
            .issue_pairing_code(Some("Phone".into()), PAIRING_CODE_TTL_MS)
            .unwrap();
        let upserted = stream.recv().await.unwrap().unwrap();
        assert_eq!(upserted["type"], "pairingLinkUpserted");
        assert_eq!(upserted["payload"]["label"], "Phone");
        let session = env
            .auth
            .exchange(&code.code, None, ClientInfo::default())
            .unwrap();
        let kinds: Vec<Value> = [
            stream.recv().await.unwrap().unwrap(),
            stream.recv().await.unwrap().unwrap(),
        ]
        .iter()
        .map(|e| e["type"].clone())
        .collect();
        assert_eq!(
            kinds,
            vec![json!("pairingLinkRemoved"), json!("clientUpserted")]
        );
        env.auth
            .revoke_session(None, &session.principal.session_id)
            .unwrap()
            .unwrap();
        let removed = stream.recv().await.unwrap().unwrap();
        assert_eq!(removed["type"], "clientRemoved");
        assert_eq!(removed["revision"], 5);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
