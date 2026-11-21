//! The real router, auth and `server.*` methods, plus one stream for
//! `tools/effect-client.mjs`: `subscribeServerConfig` sends the real snapshot
//! [`SNAPSHOTS`] times, more than the ack window, then stays open. It prints
//! `stream dropped` on stderr when the client interrupts it.

#![expect(
    clippy::unwrap_used,
    reason = "a test fixture server: a failure should stop it"
)]

use std::sync::Arc;

use conn_server::{
    AppState,
    auth::{self, AuthStore},
    environment::Environment,
    methods::{Deps, server},
    router,
    table::{Failure, MethodTable},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const SNAPSHOTS: usize = 40;

fn main() {
    let state_dir = std::env::args()
        .nth(1)
        .expect("usage: effect_fixture <state-dir>");
    let environment = Arc::new(
        Environment::load(
            state_dir.as_ref(),
            Some("Fixture".into()),
            std::env::current_dir().unwrap(),
            Default::default(),
        )
        .unwrap(),
    );
    let mut table = MethodTable::new();
    server::register(&mut table, &Deps::default());
    let env = environment.clone();
    table.stream("subscribeServerConfig", move |_, _: Value| {
        let config = server::server_config(&env, Vec::new());
        async move {
            let config = config?;
            let (tx, rx) = mpsc::channel::<Result<Value, Failure>>(1);
            tokio::spawn(async move {
                for _ in 0..SNAPSHOTS {
                    let event = json!({ "version": 1, "type": "snapshot", "config": config });
                    if tx.send(Ok(event)).await.is_err() {
                        break;
                    }
                }
                tx.closed().await;
                eprintln!("stream dropped");
            });
            Ok(rx)
        }
    });
    let broker = conn_features::panels::PanelBroker::default();
    table.stream("panels.requests", move |_, _: conn_contract::AgentPanelSubscribeInput| {
        let broker = broker.clone();
        async move {
            let mut requests = broker.subscribe().unwrap();
            let (tx, rx) = mpsc::channel(1);
            tokio::spawn(async move {
                let request = conn_contract::from_json(json!({
                    "requestId":"pending", "threadId":"fixture", "panel":"files", "focusWindow":false
                })).unwrap();
                let (shown, ()) = tokio::join!(broker.show(request, std::time::Duration::from_secs(5)), async {
                    let request = requests.recv().await.unwrap();
                    broker.respond(conn_contract::from_json(json!({"requestId":request.request_id,"ok":true})).unwrap());
                    let _ = tx.send(Ok(conn_contract::to_json(&request))).await;
                });
                assert!(shown.is_ok(), "the fixture desktop accepted the panel");
            });
            Ok(rx)
        }
    });
    table.stream("subscribePreviewEvents", |_, _: Value| async {
        let (tx,rx)=mpsc::channel(1);
        tx.send(Ok(json!({"type":"closed","threadId":"fixture","tabId":"tab_1_fixture","createdAt":"2026-11-16T00:00:00.000Z","serverEpoch":"fixture","revision":1}))).await.unwrap();
        Ok(rx)
    });
    let auth = AuthStore::in_memory();
    let state = AppState {
        table: Arc::new(table),
        auth: auth.clone(),
        descriptor: environment.subscribe_descriptor(),
        engine: None,
        deps: Default::default(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        println!("conn-server listening on http://{addr}");
        println!("pairingUrl: http://{addr}/pair#token={code}");
        axum::serve(listener, router(state)).await.unwrap();
    });
}
