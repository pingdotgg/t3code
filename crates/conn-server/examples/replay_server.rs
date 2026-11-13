//! `conn-server` with the engine's scripted fake provider in place of Claude, for
//! `tools/replay.mjs`: same flags, same routes, no model calls.

use std::sync::Arc;

use conn_engine::fake::FakeProvider;
use conn_server::serve::{ServeOptions, serve};

fn main() {
    let options = ServeOptions::from_args();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(
            options,
            vec![Arc::new(FakeProvider::new("claudeAgent"))],
        ));
}
