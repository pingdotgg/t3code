//! `server.*` and connection-level methods. Owner: track (a), wire and pairing.
//!
//! These are what Conn web and desktop call when they connect, before and while they show
//! the thread list (read from `packages/client-runtime/src/rpc/session.ts`,
//! `state/server.ts` and `apps/web/src/appInit.tsx`). Each answer is honest for a server
//! that has no terminals, devices, clones or panels: empty, and streams stay open, because
//! Conn resubscribes or reconnects when one of these streams ends.

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::Deps;
use crate::{
    auth::{self, iso8601},
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

    table.stream("subscribeTerminalMetadata", |_, _: Value| async {
        Ok(open_stream(vec![
            json!({ "type": "snapshot", "terminals": [] }),
        ]))
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

    let Some(environment) = deps.environment.clone() else {
        return;
    };
    let env = environment.clone();
    let deps = deps.clone();
    table.stream("subscribeServerConfig", move |_, _: Value| {
        let providers = super::provider::server_providers(&deps, &iso8601(auth::now_ms()));
        let config = server_config(&env, providers);
        async move {
            Ok(open_stream(vec![
                json!({ "version": 1, "type": "snapshot", "config": config }),
            ]))
        }
    });
    table.stream("subscribeServerLifecycle", move |_, _: Value| {
        let events = lifecycle_events(&environment);
        async move { Ok(open_stream(events)) }
    });
}

/// `ServerConfig` with every optional field left out. `settings: {}` decodes to the
/// defaults. `providers` comes from `provider::server_providers`.
pub fn server_config(environment: &Environment, providers: Vec<Value>) -> Value {
    let state_dir = environment.state_dir.display();
    json!({
        "environment": environment.descriptor,
        "auth": auth::descriptor(),
        "cwd": environment.cwd,
        "keybindingsConfigPath": format!("{state_dir}/keybindings.json"),
        "keybindings": [],
        "issues": [],
        "providers": providers,
        "availableEditors": [],
        "observability": {
            "logsDirectoryPath": format!("{state_dir}/logs"),
            "localTracingEnabled": false,
            "otlpTracesEnabled": false,
            "otlpMetricsEnabled": false,
        },
        "settings": {},
    })
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
