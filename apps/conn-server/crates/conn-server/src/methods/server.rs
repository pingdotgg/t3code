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
        let (env, providers) = (env.clone(), providers.clone());
        async move {
            crate::settings::refresh(&env).await;
            server_config(&env, current_providers(&providers))
        }
    });
    let providers = deps.clone();
    table.unary("server.refreshProviders", move |_, input: Value| {
        let deps = providers.clone();
        async move {
            use crate::model_manifest::Window;
            let only = input["instanceId"].as_str();
            // T3 awaits the refresh before it answers. `modelCatalogOnly` (an opened model
            // picker) ignores the other fields; the config stream carries the result.
            if input["modelCatalogOnly"] == true {
                super::provider::refresh_model_catalog(&deps).await;
                return Ok(json!({ "providers": [] }));
            }
            // A workspace (`cwd`, `fresh`) is not scanned and keeps main's behaviour: the
            // instance is probed, nothing else is fetched, and the reply lists every entry.
            if input["cwd"].is_string() {
                super::provider::refresh(&deps, only).await;
                return Ok(json!({ "providers": current_providers(&deps) }));
            }
            let refresh_models = input["refreshModels"] == true;
            if refresh_models && let Some(manifest) = &deps.model_manifest {
                manifest.refresh(Window::Force).await;
            }
            super::provider::refresh(&deps, only).await;
            if refresh_models {
                super::provider::refresh_models(&deps, only).await?;
            }
            let providers = current_providers(&deps);
            Ok(json!({ "providers": refresh_reply(&input, providers) }))
        }
    });

    // T3's `redactServerSettingsForClient`, as `server.getConfig` sends it.
    let env = environment.clone();
    table.unary("server.getSettings", move |_, _: Value| {
        let env = env.clone();
        async move {
            crate::settings::refresh(&env).await;
            Ok(env.settings.for_client())
        }
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
        let env = env.clone();
        let deps = providers.clone();
        // Only clients that ask get `environmentThemesUpdated`; older ones die on it.
        let themes = themes
            .clone()
            .filter(|_| input["environmentThemes"] == Value::Bool(true));
        async move {
            crate::settings::refresh(&env).await;
            let config = server_config(&env, current_providers(&deps))?;
            Ok(config_stream(env, deps, config, descriptor, themes))
        }
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

/// The providers `server.refreshProviders` answers with (T3's `ws.ts`), for a refresh
/// without a workspace: none for `omitProviders`; with `workspaceSnapshotsOnDemand`, every
/// entry without its workspace snapshots, and `usageLimitsCommand` adds `/usage-limits`.
fn refresh_reply(input: &Value, providers: Vec<Value>) -> Vec<Value> {
    if input["omitProviders"] == true {
        return Vec::new();
    }
    if input["workspaceSnapshotsOnDemand"] != true {
        return providers;
    }
    let providers = if input["usageLimitsCommand"] == true {
        with_usage_limits_commands(providers)
    } else {
        providers
    };
    providers
        .into_iter()
        .map(|mut provider| {
            if let Some(entry) = provider.as_object_mut() {
                entry.remove("workspaceSnapshots");
            }
            provider
        })
        .collect()
}

/// `USAGE_LIMITS_COMMAND`.
const USAGE_LIMITS_COMMAND: (&str, &str) = ("usage-limits", "Show this provider's usage limits");

/// `withUsageLimitsCommands` with no usage-limit sources (this server reads none): providers
/// that report limits get `/usage-limits` last, in their snapshots too.
fn with_usage_limits_commands(providers: Vec<Value>) -> Vec<Value> {
    let with_limits: Vec<Value> = providers
        .iter()
        .filter(|p| {
            p["enabled"] == true
                && p["installed"] == true
                && p["availability"] != "unavailable"
                && p.get("usageLimits").is_some_and(|limits| !limits.is_null())
        })
        .map(|p| p["driver"].clone())
        .collect();
    let commands = |items: &Value| {
        let mut commands: Vec<Value> = items
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["name"] != USAGE_LIMITS_COMMAND.0)
            .cloned()
            .collect();
        commands
            .push(json!({"name": USAGE_LIMITS_COMMAND.0, "description": USAGE_LIMITS_COMMAND.1}));
        Value::Array(commands)
    };
    providers
        .into_iter()
        .map(|mut provider| {
            if !with_limits.contains(&provider["driver"]) {
                return provider;
            }
            let machine = commands(&provider["slashCommands"]);
            provider["slashCommands"] = machine;
            if let Some(snapshots) = provider["workspaceSnapshots"].as_array_mut() {
                for snapshot in snapshots {
                    let scoped = commands(&snapshot["slashCommands"]);
                    snapshot["slashCommands"] = scoped;
                }
            }
            provider
        })
        .collect()
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

    /// One unknown enum value on disk still gives clients a config, in the snapshot and the
    /// stream the GPUI model catalog reads, and the file stays as the user wrote it.
    #[tokio::test(flavor = "current_thread")]
    async fn an_undecodable_settings_file_still_gives_a_config() {
        let dir =
            std::env::temp_dir().join(format!("conn-server-cfg-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let broken = "{\"responseStreamingMode\":\"typo\"}";
        std::fs::write(dir.join("settings.json"), broken).unwrap();
        let env = Arc::new(
            Environment::load(&dir, Some("Test".into()), dir.clone(), Default::default()).unwrap(),
        );
        let config = server_config(&env, Vec::new()).unwrap();
        assert_eq!(
            config["settings"]["continueThreadsAfterServerUpdate"],
            false
        );
        let mut stream = config_stream(
            env.clone(),
            Deps::default(),
            config,
            env.subscribe_descriptor(),
            None,
        );
        let snapshot = stream.recv().await.unwrap().unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        conn_contract::from_json::<conn_contract::ServerConfig>(snapshot["config"].clone())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            broken
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A Claude opt-out holds in the advertised config and at launch: T3's legacy map beside an
    /// invalid field (read apart, the file never rewritten), and a modern opt-out beside a
    /// retention written as `30.0`, which T3 reads as the whole number 30.
    #[tokio::test(flavor = "current_thread")]
    async fn a_claude_opt_out_holds_in_config_and_at_launch() {
        struct Admission(Arc<Environment>);
        impl conn_engine::EngineHost for Admission {
            fn provider_instance_enabled(&self, project: Option<&str>, instance: &str) -> bool {
                crate::settings::provider_instance_enabled(
                    &self.0.settings.raw(),
                    project,
                    instance,
                )
            }
        }
        let cases = [
            (
                r#"{"providers":{"claudeAgent":{"enabled":false}},"responseStreamingMode":"typo"}"#,
                true,
            ),
            (
                r#"{"usageHistoryRetentionDays":30.0,"providerInstances":{"claudeAgent":{"driver":"claudeAgent","enabled":false}}}"#,
                false,
            ),
            // T3's schema takes `null` here: the file is valid and its opt-out holds.
            (
                r#"{"defaultThreadEnvMode":null,"providerInstances":{"claudeAgent":{"driver":"claudeAgent","enabled":false}}}"#,
                false,
            ),
        ];
        for (file, untrusted) in cases {
            let dir = std::env::temp_dir()
                .join(format!("conn-server-cfg-{}", crate::auth::random_hex(6)));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("settings.json");
            std::fs::write(&path, file).unwrap();
            let env = Arc::new(
                Environment::load(&dir, Some("Test".into()), dir.clone(), Default::default())
                    .unwrap(),
            );
            let config = server_config(&env, Vec::new()).unwrap();
            assert_eq!(
                config["settings"]["providerInstances"]["claudeAgent"]["enabled"], false,
                "{file}"
            );

            let root = dir.join("project").display().to_string();
            let provider = Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
            let mut engine = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
            engine.projects = vec![conn_engine::ProjectConfig {
                title: "Project".into(),
                workspace_root: root.clone(),
            }];
            engine.providers = vec![provider.clone()];
            engine.host = Some(Arc::new(Admission(env.clone())));
            let engine = conn_engine::SqliteEngine::open(engine).unwrap();
            let model = json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5"});
            let create = json!({
                "type": "thread.create", "commandId": "create", "threadId": "t1",
                "projectId": conn_engine::SqliteEngine::project_id_for(&root), "title": "Claude",
                "modelSelection": model, "runtimeMode": "full-access", "interactionMode": "default",
                "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
            });
            let send = json!({
                "type": "message.dispatch", "commandId": "send", "threadId": "t1",
                "messageId": "message:send", "text": "hello", "attachments": [],
                "dispatchMode": {"type": "start_immediately"}, "createdBy": "user",
                "creationSource": "web",
            });
            let mut refused = false;
            for command in [create, send] {
                refused |= conn_engine::Engine::dispatch(
                    &engine,
                    conn_contract::from_json(command).unwrap(),
                )
                .await
                .is_err();
            }
            assert!(refused, "the Claude launch is refused: {file}");
            assert_eq!(
                provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "no Claude session started: {file}"
            );

            if untrusted {
                let save = env
                    .settings
                    .update(json!({ "defaultAutoPull": true }), None);
                assert_eq!(save.unwrap_err().operation, "read-file");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), file);
                drop(crate::settings::SettingsStore::open(path.clone()));
                assert_eq!(std::fs::read_to_string(&path).unwrap(), file);
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// T3 fails a load whose provider history cannot be read and tries again on the next
    /// read. Claude, disabled in the file's instance map, stays off meanwhile; once the history
    /// reads, the next admission loads again and the legacy migration runs.
    #[tokio::test(flavor = "current_thread")]
    async fn a_history_failure_keeps_claude_off_and_is_retried() {
        struct Admission(Arc<Environment>);
        impl conn_engine::EngineHost for Admission {
            fn refresh_settings(&self) -> conn_engine::BoxFuture<'_, ()> {
                let environment = self.0.clone();
                Box::pin(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        environment.settings.reload_if_failed();
                    })
                    .await;
                })
            }
            fn provider_instance_enabled(&self, project: Option<&str>, instance: &str) -> bool {
                crate::settings::provider_instance_enabled(
                    &self.0.settings.raw(),
                    project,
                    instance,
                )
            }
        }
        let dir =
            std::env::temp_dir().join(format!("conn-server-cfg-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let file = r#"{"providers":{},"providerInstances":{"claudeAgent":{"driver":"claudeAgent","enabled":false}}}"#;
        std::fs::write(&path, file).unwrap();
        // A T3 database whose history cannot be read yet.
        let history = rusqlite::Connection::open(dir.join("statev2.sqlite")).unwrap();
        history.execute_batch("CREATE TABLE other (x)").unwrap();
        let env = Arc::new(
            Environment::load(&dir, Some("Test".into()), dir.clone(), Default::default()).unwrap(),
        );
        let config = server_config(&env, Vec::new()).unwrap();
        assert_eq!(
            config["settings"]["providerInstances"]["claudeAgent"]["enabled"],
            false
        );
        let root = dir.join("project").display().to_string();
        let provider = Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
        let mut engine = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        engine.projects = vec![conn_engine::ProjectConfig {
            title: "Project".into(),
            workspace_root: root.clone(),
        }];
        engine.providers = vec![provider.clone()];
        engine.host = Some(Arc::new(Admission(env.clone())));
        let engine = conn_engine::SqliteEngine::open(engine).unwrap();
        // A thread with a Claude message: the message is what admission checks.
        let refused = |n: u32| {
            let engine = &engine;
            let thread = format!("t{n}");
            let create = json!({
                "type": "thread.create", "commandId": format!("create-{n}"), "threadId": thread,
                "projectId": conn_engine::SqliteEngine::project_id_for(&root), "title": "Claude",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
                "runtimeMode": "full-access", "interactionMode": "default",
                "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
            });
            let send = json!({
                "type": "message.dispatch", "commandId": format!("send-{n}"), "threadId": thread,
                "messageId": format!("message:{n}"), "text": "hello", "attachments": [],
                "dispatchMode": {"type": "start_immediately"}, "createdBy": "user",
                "creationSource": "web",
            });
            async move {
                let _ = conn_engine::Engine::dispatch(
                    engine,
                    conn_contract::from_json(create).unwrap(),
                )
                .await;
                conn_engine::Engine::dispatch(engine, conn_contract::from_json(send).unwrap())
                    .await
                    .is_err()
            }
        };
        assert!(refused(1).await);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            file,
            "kept for a retry"
        );
        history
            .execute_batch(
                "CREATE TABLE projection_thread_sessions (provider_name TEXT, provider_instance_id TEXT);
                 CREATE TABLE provider_session_runtime (provider_name TEXT, provider_instance_id TEXT);",
            )
            .unwrap();
        assert!(refused(2).await);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.get("providers").is_none(), "the repaired load ran");
        assert_eq!(saved["providerInstances"]["claudeAgent"]["enabled"], false);
        assert_eq!(
            provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A history that cannot be read keeps a project's Claude opt-out for clients and at
    /// launch through the real host; every settings read retries the failed load, and once it
    /// succeeds clients get the file's settings, a null `defaultThreadEnvMode` left off.
    #[tokio::test(flavor = "current_thread")]
    async fn a_history_failure_keeps_project_overrides_and_reads_retry() {
        use crate::table::{CallContext, Handler, MethodTable};
        let dir =
            std::env::temp_dir().join(format!("conn-server-cfg-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("project").display().to_string();
        let project = conn_engine::SqliteEngine::project_id_for(&root);
        let path = dir.join("settings.json");
        let file = json!({
            "providers": {},
            "defaultThreadEnvMode": null,
            "projectSettingsOverrides": {
                project.clone(): { "providerInstances": { "claudeAgent": { "enabled": false } } },
            },
        })
        .to_string();
        std::fs::write(&path, &file).unwrap();
        let history = rusqlite::Connection::open(dir.join("statev2.sqlite")).unwrap();
        history.execute_batch("CREATE TABLE other (x)").unwrap();
        let env = Arc::new(
            Environment::load(&dir, Some("Test".into()), dir.clone(), Default::default()).unwrap(),
        );
        let mut table = MethodTable::new();
        register(
            &mut table,
            &Deps {
                environment: Some(env.clone()),
                ..Deps::default()
            },
        );
        let call = |tag: &str| match table.get(tag) {
            Some(Handler::Unary(call)) => call.clone(),
            _ => panic!("{tag}"),
        };
        let view = call("server.getSettings")(CallContext::default(), json!({}))
            .await
            .unwrap();
        assert_eq!(
            view["projectSettingsOverrides"][project.as_str()]["providerInstances"]["claudeAgent"]
                ["enabled"],
            false,
            "{view}"
        );

        let host = Arc::new(crate::host::Host {
            mcp: std::sync::OnceLock::new(),
            files: None,
            vcs: crate::methods::vcs::VcsShared::default(),
            terminals: crate::methods::terminal::manager(Some(&env)),
            environment: env.clone(),
            scheduled_tasks: std::sync::OnceLock::new(),
            devices: std::sync::OnceLock::new(),
            previews: std::sync::OnceLock::new(),
            settle_cleanups: Arc::default(),
            settlement_wake: Arc::default(),
            idle_compaction: std::sync::OnceLock::new(),
            worktree_cleanup: std::sync::OnceLock::new(),
        });
        let provider = Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
        let mut engine = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        engine.projects = vec![conn_engine::ProjectConfig {
            title: "Project".into(),
            workspace_root: root.clone(),
        }];
        engine.providers = vec![provider.clone()];
        engine.host = Some(host);
        let engine = conn_engine::SqliteEngine::open(engine).unwrap();
        let refused = |n: u32| {
            let engine = &engine;
            let thread = format!("t{n}");
            let create = json!({
                "type": "thread.create", "commandId": format!("create-{n}"), "threadId": thread,
                "projectId": project, "title": "Claude",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
                "runtimeMode": "full-access", "interactionMode": "default",
                "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
            });
            let send = json!({
                "type": "message.dispatch", "commandId": format!("send-{n}"), "threadId": thread,
                "messageId": format!("message:{n}"), "text": "hello", "attachments": [],
                "dispatchMode": {"type": "start_immediately"}, "createdBy": "user",
                "creationSource": "web",
            });
            async move {
                let _ = conn_engine::Engine::dispatch(
                    engine,
                    conn_contract::from_json(create).unwrap(),
                )
                .await;
                conn_engine::Engine::dispatch(engine, conn_contract::from_json(send).unwrap())
                    .await
                    .is_err()
            }
        };
        assert!(refused(1).await, "refused while the history fails");

        history
            .execute_batch(
                "CREATE TABLE projection_thread_sessions (provider_name TEXT, provider_instance_id TEXT);
                 CREATE TABLE provider_session_runtime (provider_name TEXT, provider_instance_id TEXT);",
            )
            .unwrap();
        let view = call("server.getSettings")(CallContext::default(), json!({}))
            .await
            .unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            saved.get("providers").is_none(),
            "the read retried the load"
        );
        assert!(view.get("defaultThreadEnvMode").is_none(), "{view}");
        let config = call("server.getConfig")(CallContext::default(), json!({}))
            .await
            .unwrap();
        assert!(config["settings"].get("defaultThreadEnvMode").is_none());
        assert_eq!(
            config["settings"]["projectSettingsOverrides"][project.as_str()]["providerInstances"]["claudeAgent"]
                ["enabled"],
            false
        );
        assert!(refused(2).await, "the project's opt-out holds");
        assert_eq!(
            provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_config_stream_follows_settings_keybindings_and_providers() {
        let (env, dir) = environment();
        let config = server_config(&env, Vec::new()).unwrap();
        assert!(config["keybindings"].as_array().unwrap().len() > 10);
        assert_eq!(config["auth"]["policy"], "remote-reachable");
        // The mobile gates read these from `server.getConfig` as from the descriptor.
        for flag in [
            "freshContext",
            "oneTimeSchedules",
            "scheduledTaskThreadModes",
            "threadPullRequestWatch",
            "issueLinkedThreads",
            "commandOutputStreaming",
        ] {
            assert_eq!(config["environment"]["capabilities"][flag], true, "{flag}");
        }
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

    /// A provider that counts its probes and model refreshes; `fail` makes the refresh fail.
    struct Models {
        id: conn_contract::ProviderInstanceId,
        probes: std::sync::atomic::AtomicUsize,
        refreshes: std::sync::atomic::AtomicUsize,
        fail: bool,
    }

    impl conn_provider::Provider for Models {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "antigravity"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn server_provider_entry(&self, _checked_at: &str) -> Option<Value> {
            Some(json!({
                "instanceId": self.id.as_str(), "enabled": true, "installed": true,
                "models": [{"slug": "m"}], "slashCommands": [{"name": "c"}], "skills": [],
                "workspaceSnapshots": [{"cwd": "/w", "slashCommands": []},
                                       {"cwd": "/other", "slashCommands": []}],
            }))
        }
        fn refresh_status(&self, _instance: Option<Value>) -> conn_provider::BoxFuture<'_, ()> {
            self.probes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async {})
        }
        fn refresh_models(
            &self,
        ) -> Option<conn_provider::BoxFuture<'_, conn_provider::ProviderResult<()>>> {
            self.refreshes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let fail = self.fail;
            Some(Box::pin(async move {
                if fail {
                    Err(conn_provider::ProviderError::Failed {
                        operation: "refresh-models",
                        detail: "no models".into(),
                    })
                } else {
                    Ok(())
                }
            }))
        }
    }

    /// T3's `serverRefreshProviders`: `modelCatalogOnly` answers no providers and probes them
    /// only when an on-demand manifest fetch changed the manifest; `refreshModels` runs each
    /// targeted provider's model refresh after the probe, and a failure answers
    /// `ProviderSetupError` with operation `refresh-models`.
    #[tokio::test(flavor = "current_thread")]
    async fn refresh_providers_follows_model_catalog_only_and_refresh_models() {
        use crate::model_manifest::{ModelManifest, Source, tests as manifest};
        use crate::table::{CallContext, Handler};
        use std::sync::atomic::Ordering::Relaxed;
        let (env, dir) = environment();
        let model = |id: &str, fail: bool| {
            Arc::new(Models {
                id: id.into(),
                probes: Default::default(),
                refreshes: Default::default(),
                fail,
            })
        };
        let (good, bad) = (model("good", false), model("bad", true));
        let (url, server) = manifest::serve_once(manifest::manifest("2999-01-01T00:00:00.000Z"), 1);
        let deps = Deps {
            environment: Some(env.clone()),
            providers: vec![
                good.clone() as Arc<dyn conn_provider::Provider>,
                bad.clone() as Arc<dyn conn_provider::Provider>,
            ]
            .into(),
            model_manifest: Some(ModelManifest::with_source(
                Source::Url(url),
                dir.clone(),
                env.clone(),
                Default::default(),
            )),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let Some(Handler::Unary(call)) = table.get("server.refreshProviders") else {
            panic!("server.refreshProviders is not registered");
        };
        let call = |input: Value| call(CallContext::default(), input);

        // A newer manifest: no providers in the reply, every provider probed once.
        let reply = call(json!({"modelCatalogOnly": true, "refreshModels": true})).await;
        assert_eq!(reply, Ok(json!({"providers": []})));
        assert_eq!(server.join().unwrap(), 1);
        assert_eq!(good.probes.load(Relaxed), 1);
        assert_eq!(bad.probes.load(Relaxed), 1);
        assert_eq!(
            good.refreshes.load(Relaxed),
            0,
            "the other fields are ignored"
        );
        // Fetched within 5 minutes: nothing changes, nothing is probed.
        call(json!({"modelCatalogOnly": true})).await.unwrap();
        assert_eq!(good.probes.load(Relaxed), 1);

        // Without `refreshModels` no model refresh runs.
        let reply = call(json!({"instanceId": "good"})).await.unwrap();
        assert_eq!(reply["providers"].as_array().unwrap().len(), 2);
        assert_eq!(good.refreshes.load(Relaxed), 0);
        assert_eq!(good.probes.load(Relaxed), 2);
        // With it: the targeted instance only, probed again after its refresh.
        call(json!({"instanceId": "good", "refreshModels": true}))
            .await
            .unwrap();
        assert_eq!(good.refreshes.load(Relaxed), 1);
        assert_eq!(good.probes.load(Relaxed), 4);
        assert_eq!(bad.refreshes.load(Relaxed), 0);
        let mut changes = deps.provider_status.subscribe();
        let seen = *changes.borrow_and_update();
        let failure = call(json!({"instanceId": "bad", "refreshModels": true}))
            .await
            .err();
        // The probe and the failed refresh each told the config streams.
        assert_eq!(changes.borrow().wrapping_sub(seen), 2);
        assert_eq!(
            failure,
            Some(Failure::Fail(json!({
                "_tag": "ProviderSetupError",
                "instanceId": "bad",
                "operation": "refresh-models",
                "detail": "no models",
            })))
        );

        // `omitProviders` without a workspace: the refresh runs, the reply lists nothing.
        let reply = call(json!({"refreshModels": true, "omitProviders": true}))
            .await
            .unwrap_err();
        assert!(matches!(reply, Failure::Fail(_)), "`bad` still fails");
        let reply =
            call(json!({"instanceId": "good", "refreshModels": true, "omitProviders": true})).await;
        assert_eq!(reply, Ok(json!({"providers": []})));
        assert_eq!(good.refreshes.load(Relaxed), 3);
        // A workspace is not scanned: the instance is probed, and the reply lists every
        // entry as it is, as before workspace snapshots.
        let probes = good.probes.load(Relaxed);
        let reply = call(
            json!({"instanceId": "good", "cwd": "/w", "fresh": true, "omitProviders": true,
            "workspaceSnapshotsOnDemand": true}),
        )
        .await
        .unwrap();
        assert_eq!(good.probes.load(Relaxed), probes + 1);
        assert_eq!(reply["providers"], json!(current_providers(&deps)));
        // A workspace refresh keeps main's behaviour even with `refreshModels`: one probe,
        // no manifest fetch or model refresh, every entry in the reply.
        let refreshes = good.refreshes.load(Relaxed);
        let reply = call(json!({"instanceId": "good", "cwd": "/w", "refreshModels": true}))
            .await
            .unwrap();
        assert_eq!(good.probes.load(Relaxed), probes + 2);
        assert_eq!(good.refreshes.load(Relaxed), refreshes);
        assert_eq!(reply["providers"], json!(current_providers(&deps)));
        // On demand without a workspace: every entry, without its snapshots.
        let reply = call(json!({"workspaceSnapshotsOnDemand": true}))
            .await
            .unwrap();
        let providers = reply["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2);
        assert!(
            providers
                .iter()
                .all(|p| p.get("workspaceSnapshots").is_none())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A provider whose probe waits until the test releases it.
    struct Blocked {
        id: conn_contract::ProviderInstanceId,
        probes: std::sync::atomic::AtomicUsize,
        started: tokio::sync::Notify,
        release: tokio::sync::Semaphore,
    }

    impl conn_provider::Provider for Blocked {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "codex"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn server_provider_entry(&self, _checked_at: &str) -> Option<Value> {
            Some(json!({"instanceId": self.id.as_str()}))
        }
        fn refresh_status(&self, _instance: Option<Value>) -> conn_provider::BoxFuture<'_, ()> {
            Box::pin(async move {
                self.probes
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.started.notify_one();
                let _ = self.release.acquire().await;
            })
        }
    }

    /// T3's shared `refreshAll` (`ProviderRegistry.test.ts`, "keeps a shared refresh running
    /// after its first caller is interrupted"): a second opened picker joins the pass in
    /// flight instead of answering early, and cancelling the first caller does not lose it.
    #[tokio::test(flavor = "current_thread")]
    async fn model_catalog_refreshes_share_one_pass_that_outlives_its_first_caller() {
        use crate::model_manifest::{ModelManifest, Source, tests as manifest};
        use crate::table::{CallContext, Handler};
        use std::sync::atomic::Ordering::Relaxed;
        let (env, dir) = environment();
        let blocked = Arc::new(Blocked {
            id: "codex".into(),
            probes: Default::default(),
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        });
        let (url, server) = manifest::serve_once(manifest::manifest("2999-01-01T00:00:00.000Z"), 1);
        let deps = Deps {
            environment: Some(env.clone()),
            providers: vec![blocked.clone() as Arc<dyn conn_provider::Provider>].into(),
            model_manifest: Some(ModelManifest::with_source(
                Source::Url(url),
                dir.clone(),
                env.clone(),
                Default::default(),
            )),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let Some(Handler::Unary(call)) = table.get("server.refreshProviders") else {
            panic!("server.refreshProviders is not registered");
        };
        let picker = || call(CallContext::default(), json!({"modelCatalogOnly": true}));

        let first = tokio::spawn(picker());
        blocked.started.notified().await;
        assert_eq!(server.join().unwrap(), 1);
        let second = tokio::spawn(picker());
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        assert!(
            !second.is_finished(),
            "the second caller waits for the pass"
        );
        first.abort();
        let _ = first.await;
        blocked.release.add_permits(1);
        assert_eq!(second.await.unwrap(), Ok(json!({"providers": []})));
        assert_eq!(blocked.probes.load(Relaxed), 1, "one shared pass");
        // The pass recorded the manifest it probed with: the next picker probes nothing.
        assert_eq!(picker().await, Ok(json!({"providers": []})));
        assert_eq!(blocked.probes.load(Relaxed), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A provider that classifies two models with Codex's catalog code on each probe, as
    /// `CodexDriver` applies `ModelCatalog.current` to its probe result.
    struct CatalogProbe {
        id: conn_contract::ProviderInstanceId,
        manifest: conn_provider::LiveManifest,
        entry: std::sync::Mutex<Value>,
    }

    impl conn_provider::Provider for CatalogProbe {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "codex"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn server_provider_entry(&self, _checked_at: &str) -> Option<Value> {
            Some(self.entry.lock().unwrap().clone())
        }
        fn refresh_status(&self, _instance: Option<Value>) -> conn_provider::BoxFuture<'_, ()> {
            use conn_provider_codex::{CodexConfig, status};
            let config = CodexConfig {
                model_manifest: self.manifest.clone(),
                ..CodexConfig::default()
            };
            let settings = status::StatusSettings {
                enabled: true,
                ..status::StatusSettings::default()
            };
            let checked_at = "2026-11-23T00:00:00.000Z";
            let mut entry = status::pending_entry("codex", &config, &settings, &[], checked_at);
            let no_options = json!({"optionDescriptors": []});
            entry["models"] = json!([
                {"slug": "gpt-6-astra", "name": "A", "isCustom": false, "isDefault": true,
                 "aliases": ["default"], "capabilities": no_options},
                {"slug": "gpt-x", "name": "X", "isCustom": false, "capabilities": no_options}
            ]);
            status::apply_model_catalog(&mut entry, &self.manifest, 0);
            *self.entry.lock().unwrap() = entry;
            Box::pin(async {})
        }
    }

    /// T3 applies the current manifest to the probe result: once an opened picker fetched a
    /// manifest with a new Codex default, `server.getConfig` shows it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_fetched_manifest_reaches_the_codex_entry_in_the_config() {
        use crate::model_manifest::{ModelManifest, Source, tests as manifest};
        use crate::table::{CallContext, Handler};
        let (env, dir) = environment();
        let live = conn_provider::LiveManifest::default();
        let codex = Arc::new(CatalogProbe {
            id: "codex".into(),
            manifest: live.clone(),
            entry: std::sync::Mutex::new(Value::Null),
        });
        let (url, server) = manifest::serve_once(manifest::manifest("2999-01-01T00:00:00.000Z"), 1);
        let deps = Deps {
            environment: Some(env.clone()),
            providers: vec![codex.clone() as Arc<dyn conn_provider::Provider>].into(),
            model_manifest: Some(ModelManifest::with_source(
                Source::Url(url),
                dir.clone(),
                env.clone(),
                live,
            )),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let unary = |method: &str| match table.get(method) {
            Some(Handler::Unary(call)) => call.clone(),
            _ => panic!("{method} is not registered"),
        };
        let default_model = |config: Value| {
            config["providers"][0]["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["isDefault"] == true)
                .map(|m| m["slug"].clone())
        };
        conn_provider::Provider::refresh_status(&*codex, None).await;
        let config = unary("server.getConfig")(CallContext::default(), json!({}));
        assert_eq!(
            default_model(config.await.unwrap()),
            Some(json!("gpt-6-astra"))
        );

        let picker = unary("server.refreshProviders");
        let reply = picker(CallContext::default(), json!({"modelCatalogOnly": true})).await;
        assert_eq!(reply, Ok(json!({"providers": []})));
        assert_eq!(server.join().unwrap(), 1);
        let config = unary("server.getConfig")(CallContext::default(), json!({}));
        assert_eq!(default_model(config.await.unwrap()), Some(json!("gpt-x")));
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

    /// `withUsageLimitsCommands`: providers that report limits get `/usage-limits` last.
    #[test]
    fn the_usage_limits_command_follows_t3() {
        let with = json!({"driver": "codex", "enabled": true, "installed": true,
            "usageLimits": {}, "slashCommands": [{"name": "usage-limits"}, {"name": "goal"}],
            "workspaceSnapshots": [{"cwd": "/w", "slashCommands": []}]});
        let without = json!({"driver": "claudeAgent", "enabled": true, "installed": true,
            "slashCommands": []});
        let out = with_usage_limits_commands(vec![with, without.clone()]);
        let command =
            json!({"name": "usage-limits", "description": "Show this provider's usage limits"});
        assert_eq!(out[0]["slashCommands"], json!([{"name": "goal"}, command]));
        assert_eq!(
            out[0]["workspaceSnapshots"][0]["slashCommands"],
            json!([command])
        );
        assert_eq!(out[1], without);
    }

    /// A provider whose probe ends abnormally on its first run.
    struct Crashes {
        id: conn_contract::ProviderInstanceId,
        probes: std::sync::atomic::AtomicUsize,
    }

    impl conn_provider::Provider for Crashes {
        fn instance_id(&self) -> &conn_contract::ProviderInstanceId {
            &self.id
        }
        fn driver(&self) -> &str {
            "codex"
        }
        fn capabilities(
            &self,
        ) -> conn_provider::BoxFuture<
            '_,
            conn_provider::ProviderResult<conn_contract::ProviderCapabilities>,
        > {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "capabilities",
                })
            })
        }
        fn open_session(
            &self,
            _input: conn_provider::OpenSessionInput,
        ) -> conn_provider::BoxFuture<'_, conn_provider::ProviderResult<conn_provider::OpenedSession>>
        {
            Box::pin(async {
                Err(conn_provider::ProviderError::Unsupported {
                    operation: "open_session",
                })
            })
        }
        fn refresh_status(&self, _instance: Option<Value>) -> conn_provider::BoxFuture<'_, ()> {
            let first = self
                .probes
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                == 0;
            Box::pin(async move {
                assert!(!first, "the first probe ends abnormally");
            })
        }
    }

    /// T3 records the probed manifest only when the pass completes: a probe that ended
    /// abnormally leaves it unprobed, so the next opened picker runs the pass again.
    #[tokio::test(flavor = "current_thread")]
    async fn an_abnormal_probe_leaves_the_manifest_unprobed() {
        use crate::model_manifest::{ModelManifest, Source, tests as manifest};
        use crate::table::{CallContext, Handler};
        use std::sync::atomic::Ordering::Relaxed;
        let (env, dir) = environment();
        let crashes = Arc::new(Crashes {
            id: "codex".into(),
            probes: Default::default(),
        });
        let (url, server) = manifest::serve_once(manifest::manifest("2999-01-01T00:00:00.000Z"), 1);
        let deps = Deps {
            environment: Some(env.clone()),
            providers: vec![crashes.clone() as Arc<dyn conn_provider::Provider>].into(),
            model_manifest: Some(ModelManifest::with_source(
                Source::Url(url),
                dir.clone(),
                env.clone(),
                Default::default(),
            )),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let Some(Handler::Unary(call)) = table.get("server.refreshProviders") else {
            panic!("server.refreshProviders is not registered");
        };
        let picker = || call(CallContext::default(), json!({"modelCatalogOnly": true}));
        assert_eq!(picker().await, Ok(json!({"providers": []})));
        assert_eq!(server.join().unwrap(), 1);
        // The first pass ended abnormally, so a second pass ran in the same call.
        assert_eq!(crashes.probes.load(Relaxed), 2);
        // That one completed: the manifest counts as probed.
        assert_eq!(picker().await, Ok(json!({"providers": []})));
        assert_eq!(crashes.probes.load(Relaxed), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
