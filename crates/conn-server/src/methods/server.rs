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
    auth::{self, AccessChange, iso8601},
    diagnostics,
    environment::Environment,
    table::{Failure, ItemStream, MethodTable},
};

pub fn register(table: &mut MethodTable, deps: &Deps) {
    table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
    // Activity drives background scheduling, which this server does not have.
    table.unary("server.reportClientActivity", |_, _: Value| async {
        Ok(Value::Null)
    });
    // No server browser here; the profiles have no use.
    table.unary("preview.reportProfiles", |_, _: Value| async {
        Ok(Value::Null)
    });

    table.stream("subscribeProjectClones", |_, _: Value| async {
        Ok(open_stream(vec![json!([])]))
    });
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
    // Desktop asks the server to open agent panels; nothing here ever asks.
    table.stream("panels.requests", |_, _: Value| async {
        Ok(open_stream(Vec::new()))
    });
    // The thread panel's Automations card; without it the card shows an error.
    table.stream("scheduledTasks.subscribe", |_, _: Value| async {
        Ok(open_stream(vec![json!({ "tasks": [] })]))
    });

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
    table.unary("server.refreshProviders", move |_, _: Value| {
        let list = current_providers(&providers);
        async move { Ok(json!({ "providers": list })) }
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
    table.stream("subscribeServerConfig", move |_, _: Value| {
        let config = server_config(&env, current_providers(&providers));
        let env = env.clone();
        async move { Ok(config_stream(env, config?)) }
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
    super::provider::server_providers(deps, &iso8601(auth::now_ms()))
}

/// `ServerConfig`, decoded into the contract type: a required field this server does not
/// fill fails here (and in the test below), not in a client. The optional flags come from
/// [`environment::config_flags`], next to the descriptor's capabilities. `providers` comes
/// from `provider::server_providers`.
pub fn server_config(environment: &Environment, providers: Vec<Value>) -> Result<Value, Failure> {
    let state_dir = environment.state_dir.display();
    let keybindings = environment.keybindings.snapshot();
    let mut config: ServerConfig = conn_contract::from_json(json!({
        "environment": environment.descriptor,
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
    config.server_time = Some(iso8601(auth::now_ms()));
    Ok(conn_contract::to_json(&config))
}

/// The config snapshot, then `settingsUpdated` after each settings write and
/// `keybindingsUpdated` after each keybinding write, until the client unsubscribes.
fn config_stream(env: Arc<Environment>, config: Value) -> ItemStream {
    let (tx, rx) = mpsc::channel::<Result<Value, Failure>>(4);
    let mut settings = env.settings.subscribe();
    let mut keybindings = env.keybindings.subscribe();
    settings.mark_unchanged();
    keybindings.mark_unchanged();
    tokio::spawn(async move {
        let snapshot = json!({ "version": 1, "type": "snapshot", "config": config });
        if tx.send(Ok(snapshot)).await.is_err() {
            return;
        }
        loop {
            let event = tokio::select! {
                changed = settings.changed() => {
                    if changed.is_err() { break; }
                    json!({ "version": 1, "type": "settingsUpdated", "payload": { "settings": env.settings.for_client() } })
                }
                changed = keybindings.changed() => {
                    if changed.is_err() { break; }
                    let snapshot = env.keybindings.snapshot();
                    json!({ "version": 1, "type": "keybindingsUpdated", "payload": { "keybindings": snapshot.keybindings, "issues": snapshot.issues } })
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
                "environment": environment.descriptor,
                "cwd": environment.cwd,
                "projectName": project_name,
                "bootstrapStatus": "complete",
            },
        }),
        json!({
            "version": 1,
            "sequence": 1,
            "type": "ready",
            "payload": { "at": iso8601(auth::now_ms()), "environment": environment.descriptor },
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
        let dir = std::env::temp_dir().join(format!("conn-server-cfg-{}", auth::random_hex(6)));
        let env = Environment::load(&dir, Some("Test".into()), dir.clone()).unwrap();
        (Arc::new(env), dir)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_config_stream_follows_settings_and_keybinding_writes() {
        let (env, dir) = environment();
        let config = server_config(&env, Vec::new()).unwrap();
        assert!(config["keybindings"].as_array().unwrap().len() > 10);
        assert_eq!(config["auth"]["policy"], "remote-reachable");
        let before = iso8601(auth::now_ms());
        let server_time = config["serverTime"].as_str().unwrap();
        assert!(
            server_time.len() == 24 && server_time <= before.as_str(),
            "serverTime is the host clock as an ISO time: {server_time}"
        );
        let mut stream = config_stream(env.clone(), config);
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
