//! The real router, auth and `server.*` methods, plus one stream for
//! `tools/effect-client.mjs`: `subscribeServerConfig` sends the real snapshot
//! [`SNAPSHOTS`] times, more than the ack window, then stays open. It prints
//! `stream dropped` on stderr when the client interrupts it.

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
        )
        .unwrap(),
    );
    let mut table = MethodTable::new();
    server::register(&mut table, &Deps::default());
    let env = environment.clone();
    table.stream("subscribeServerConfig", move |_, _: Value| {
        let config = server::server_config(&env, Vec::new());
        async move {
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
    let auth = AuthStore::in_memory();
    let state = AppState {
        table: Arc::new(table),
        auth: auth.clone(),
        descriptor: Arc::new(environment.descriptor.clone()),
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
