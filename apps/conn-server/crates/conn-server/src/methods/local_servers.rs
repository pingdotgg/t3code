//! `subscribeDiscoveredLocalServers` and `preview.stopLocalServer` (`crate::local_servers`).
use super::Deps;
use crate::local_servers::{LocalServers, terminal_shells};
use crate::table::{Failure, MethodTable};
use conn_contract::{PreviewStopLocalServerInput, SubscribeDiscoveredLocalServersPayload, to_json};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let activity = deps.provider_status.clone();
    let environment = deps.environment.clone();
    let scanner = LocalServers::new(
        terminal_shells(deps.terminals.clone()),
        Arc::new(move || {
            let settings = environment
                .as_ref()
                .map(|e| e.settings.raw())
                .unwrap_or_default();
            activity.opportunistic(&settings)
        }),
    );
    let stopper = scanner.clone();
    table.unary(
        "preview.stopLocalServer",
        move |_, input: PreviewStopLocalServerInput| {
            let scanner = stopper.clone();
            async move {
                scanner.stop(input.pid, input.port).await.map_err(|error| {
                    Failure::Fail(
                        json!({"_tag": "PreviewStopLocalServerError", "reason": error.reason()}),
                    )
                })
            }
        },
    );
    table.stream(
        "subscribeDiscoveredLocalServers",
        move |_, input: SubscribeDiscoveredLocalServersPayload| {
            let scanner = scanner.clone();
            async move {
                let configured: Vec<String> = input
                    .configured_urls
                    .as_ref()
                    .map(to_json)
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                let mut lists = scanner.subscribe(configured).await.map_err(Failure::die)?;
                let (tx, rx) = mpsc::channel(4);
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            () = tx.closed() => break,
                            list = lists.recv() => match list {
                                Some(list) => if tx.send(Ok::<Value, Failure>(list)).await.is_err() { break },
                                None => break,
                            },
                        }
                    }
                });
                Ok(rx)
            }
        },
    );
}
