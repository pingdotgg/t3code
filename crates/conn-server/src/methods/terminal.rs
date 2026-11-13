//! `terminal.*` and `subscribeTerminalMetadata`, served by one `conn_terminal::TerminalManager`.
//! Owner: the terminal track.
//!
//! Inputs are checked against the contract's bounds here, as Effect's schema does in the T3
//! server: a payload outside them is a defect, not a typed error.

use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use conn_contract::{
    TerminalAttachInput, TerminalAttachStreamEvent, TerminalClearInput, TerminalCloseInput,
    TerminalMetadataStreamEvent, TerminalOpenInput, TerminalResizeInput, TerminalWriteInput,
    to_json,
};
use conn_terminal::{
    MetadataSubscription, Subscription, TerminalConfig, TerminalManager, ViewerId,
};
use serde::Serialize;
use tokio::sync::mpsc;

use super::Deps;
use crate::{
    environment::CONTRACT_SERVER_VERSION,
    table::{CallContext, Failure, ItemStream, MethodTable},
};

/// Values a stream may have waiting for the session. With at most 16 KiB of output per value,
/// a chunk the session batches from them stays near the 64 KiB ack window.
const STREAM_BUFFER: usize = 4;

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let manager = TerminalManager::new(TerminalConfig {
        history_dir: deps
            .environment
            .as_ref()
            .map(|e| e.state_dir.join("terminals")),
        version: CONTRACT_SERVER_VERSION.into(),
        ..TerminalConfig::default()
    });

    let m = manager.clone();
    table.unary("terminal.open", move |_, input: TerminalOpenInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            check_grid(input.cols, input.rows)?;
            m.open(input).map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.stream("terminal.attach", move |ctx, input: TerminalAttachInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            check_grid(input.cols, input.rows)?;
            let sub = m
                .attach(input, viewer(&ctx))
                .map_err(|e| Failure::fail(&e))?;
            Ok(forward(sub))
        }
    });
    let m = manager.clone();
    table.stream("terminal.observe", move |_, input: TerminalClearInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            let sub = m.observe(input).map_err(|e| Failure::fail(&e))?;
            Ok(forward(sub))
        }
    });
    let m = manager.clone();
    table.unary("terminal.write", move |_, input: TerminalWriteInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            // `Schema.isMaxLength` counts UTF-16 code units.
            let units = input.data.encode_utf16().count();
            if units == 0 || units > 65_536 {
                return Err(Failure::die(format!(
                    "terminal.write data must hold 1 to 65536 characters, not {units}"
                )));
            }
            m.write(input).await.map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.resize", move |ctx, input: TerminalResizeInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            check_grid(Some(input.cols), Some(input.rows))?;
            m.resize(input, Some(viewer(&ctx)))
                .map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.clear", move |_, input: TerminalClearInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            m.clear(input).map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.close", move |_, input: TerminalCloseInput| {
        let m = m.clone();
        async move {
            check_id(&input.thread_id, usize::MAX)?;
            if let Some(terminal_id) = &input.terminal_id {
                check_id(terminal_id, 128)?;
            }
            m.close(input);
            Ok(())
        }
    });
    table.stream(
        "subscribeTerminalMetadata",
        move |_, _: serde_json::Value| {
            let sub = manager.subscribe_metadata();
            async move { Ok(forward(sub)) }
        },
    );
}

/// The connection a call came on. The session builds one `Principal` per socket, so its
/// address names the connection while the socket lives; calls without one each get their own.
fn viewer(ctx: &CallContext) -> ViewerId {
    static ANONYMOUS: AtomicU64 = AtomicU64::new(1 << 63);
    match &ctx.principal {
        Some(principal) => Arc::as_ptr(principal) as usize as u64,
        None => ANONYMOUS.fetch_add(1, Ordering::Relaxed),
    }
}

/// A terminal or metadata subscription.
trait Source: Send + 'static {
    type Item: Serialize + Send;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send;
}

impl Source for Subscription {
    type Item = TerminalAttachStreamEvent;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send {
        Subscription::next(self)
    }
}

impl Source for MetadataSubscription {
    type Item = TerminalMetadataStreamEvent;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send {
        MetadataSubscription::next(self)
    }
}

/// Passes a subscription's events to the session until the client unsubscribes; then the
/// subscription is dropped, which unsubscribes it from the terminal.
fn forward(mut source: impl Source) -> ItemStream {
    let (tx, rx) = mpsc::channel(STREAM_BUFFER);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                () = tx.closed() => return,
                item = source.next() => item,
            };
            if tx.send(Ok(to_json(&item))).await.is_err() {
                return;
            }
        }
    });
    rx
}

fn check_session(thread_id: &str, terminal_id: &str) -> Result<(), Failure> {
    check_id(thread_id, usize::MAX)?;
    check_id(terminal_id, 128)
}

/// `TrimmedNonEmptyString`, with the terminal id's 128-character cap.
fn check_id(id: &str, max: usize) -> Result<(), Failure> {
    if id.is_empty() || id.trim() != id || id.encode_utf16().count() > max {
        return Err(Failure::die(format!(
            "invalid terminal or thread id {id:?}"
        )));
    }
    Ok(())
}

fn check_grid(cols: Option<i64>, rows: Option<i64>) -> Result<(), Failure> {
    let cols_ok = cols.is_none_or(|c| (1..=1000).contains(&c));
    let rows_ok = rows.is_none_or(|r| (1..=500).contains(&r));
    if cols_ok && rows_ok {
        Ok(())
    } else {
        Err(Failure::die(format!(
            "terminal size out of range: {cols:?} columns, {rows:?} rows"
        )))
    }
}

#[cfg(test)]
mod tests {
    //! The terminal methods through a real session, with a real shell, as the client sees them.

    use std::time::Duration;

    use conn_wire::ack_window;
    use serde_json::{Value, json};
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    use super::*;
    use crate::session::{Incoming, SessionOptions, Transport, run};

    struct Socket {
        incoming: UnboundedReceiver<Incoming>,
        sent: UnboundedSender<String>,
    }

    impl Transport for Socket {
        async fn recv(&mut self) -> Incoming {
            self.incoming.recv().await.unwrap_or(Incoming::Closed)
        }
        async fn send(&mut self, text: String) -> bool {
            self.sent.send(text).is_ok()
        }
        async fn close(&mut self, _: u16, _: &'static str) {}
    }

    struct Client {
        to_server: UnboundedSender<Incoming>,
        from_server: UnboundedReceiver<String>,
    }

    impl Client {
        fn connect() -> Self {
            let mut table = MethodTable::new();
            register(&mut table, &Deps::default());
            let (to_server, incoming) = unbounded_channel();
            let (sent, from_server) = unbounded_channel();
            tokio::spawn(run(
                Socket { incoming, sent },
                Arc::new(table),
                SessionOptions::default(),
            ));
            Self {
                to_server,
                from_server,
            }
        }

        fn send(&self, frame: Value) {
            let _ = self.to_server.send(Incoming::Text(frame.to_string()));
        }

        fn request(&self, id: i64, tag: &str, payload: Value) {
            self.send(
                json!({"_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": []}),
            );
        }

        /// The next frame, or `None` after `quiet` without one.
        async fn next(&mut self, quiet: Duration) -> Option<(String, Value)> {
            let text = tokio::time::timeout(quiet, self.from_server.recv())
                .await
                .ok()??;
            let value = serde_json::from_str(&text).expect("frames are JSON");
            Some((text, value))
        }

        /// Frames until `done` matches one.
        async fn until(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
            let mut seen = Vec::new();
            while let Some((_, frame)) = self.next(Duration::from_secs(15)).await {
                let stop = done(&frame);
                seen.push(frame);
                if stop {
                    return seen;
                }
            }
            panic!("timed out; saw {seen:#?}");
        }
    }

    fn is_exit(frame: &Value, id: i64) -> bool {
        frame["_tag"] == "Exit" && frame["requestId"] == id
    }

    fn output(frame: &Value) -> String {
        frame["values"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| {
                v["data"]
                    .as_str()
                    .or(v["snapshot"]["history"].as_str())
                    .unwrap_or("")
                    .to_owned()
            })
            .collect()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_busy_terminal_stays_within_the_byte_window() {
        let mut client = Client::connect();
        let cwd = std::env::temp_dir();
        let session = json!({"threadId": "thread-1", "terminalId": "term-1"});
        let mut attach = session.clone();
        attach["cwd"] = json!(cwd);
        attach["cols"] = json!(80);
        attach["rows"] = json!(24);
        client.request(1, "terminal.attach", attach);
        let first = client.until(|f| f["_tag"] == "Chunk").await;
        assert_eq!(first.last().unwrap()["values"][0]["type"], "snapshot");
        client.send(json!({"_tag": "Ack", "requestId": 1}));

        let mut write = session.clone();
        write["data"] = json!("yes 0123456789abcdef | head -c 3000000; echo END-\"\"MARK\n");
        client.request(2, "terminal.write", write);

        // Ack until the flood arrives, then stop: the session sends at most the window.
        let size = |text: &str, frame: &Value| {
            let values = frame["values"].as_array().map_or(0, Vec::len);
            text.len() + values * ack_window::VALUE_OVERHEAD_BYTES
        };
        let mut pending: Vec<usize> = Vec::new();
        while let Some((text, frame)) = client.next(Duration::from_secs(15)).await {
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                if text.len() > 8 * 1024 {
                    pending.push(size(&text, &frame));
                    break;
                }
                client.send(json!({"_tag": "Ack", "requestId": 1}));
            }
        }
        assert_eq!(pending.len(), 1, "the flood never arrived");
        while let Some((text, frame)) = client.next(Duration::from_millis(1500)).await {
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                pending.push(size(&text, &frame));
            }
        }
        let bytes: usize = pending.iter().sum();
        let largest = pending.iter().copied().max().unwrap_or(0);
        assert!(
            pending.len() <= ack_window::MAX_PENDING_CHUNKS,
            "{pending:?}"
        );
        assert!(
            largest <= ack_window::MAX_PENDING_BYTES + 4096,
            "{pending:?}"
        );
        assert!(
            bytes < ack_window::MAX_PENDING_BYTES + largest,
            "{pending:?}"
        );

        // Acking lets the rest through; a viewer that fell behind resyncs from a snapshot.
        let mut seen = String::new();
        for _ in &pending {
            client.send(json!({"_tag": "Ack", "requestId": 1}));
        }
        while !seen.contains("END-MARK") {
            let Some((_, frame)) = client.next(Duration::from_secs(15)).await else {
                panic!(
                    "no END-MARK; tail {:?}",
                    &seen[seen.len().saturating_sub(200)..]
                );
            };
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                seen.push_str(&output(&frame));
                client.send(json!({"_tag": "Ack", "requestId": 1}));
            }
        }

        let mut close = session.clone();
        close["deleteHistory"] = json!(true);
        client.request(3, "terminal.close", close);
        let frames = client.until(|f| output_type(f) == Some("closed")).await;
        assert!(
            frames
                .iter()
                .any(|f| is_exit(f, 3) && f["exit"]["_tag"] == "Success")
        );
    }

    fn output_type(frame: &Value) -> Option<&str> {
        frame["values"].as_array()?.last()?["type"].as_str()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reports_typed_errors_and_defects() {
        let mut client = Client::connect();
        client.request(
            1,
            "terminal.write",
            json!({"threadId": "t", "terminalId": "term-1", "data": "x"}),
        );
        let frames = client.until(|f| is_exit(f, 1)).await;
        let cause = &frames.last().unwrap()["exit"]["cause"][0];
        assert_eq!(cause["_tag"], "Fail");
        assert_eq!(cause["error"]["_tag"], "TerminalSessionLookupError");

        client.request(
            2,
            "terminal.resize",
            json!({"threadId": "t", "terminalId": "term-1", "cols": 0, "rows": 10}),
        );
        let frames = client.until(|f| is_exit(f, 2)).await;
        assert_eq!(frames.last().unwrap()["exit"]["cause"][0]["_tag"], "Die");

        client.request(3, "subscribeTerminalMetadata", json!({}));
        let frames = client.until(|f| f["_tag"] == "Chunk").await;
        assert_eq!(
            frames.last().unwrap()["values"][0],
            json!({"type": "snapshot", "terminals": []})
        );
    }
}
