//! Session tests against `MethodTable` with fake handlers, over an in-memory transport.
//! Tokio's clock is paused: `settle()` returns once every task is idle, so "nothing more
//! was sent" is checked without real waiting.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::*;

#[derive(Debug, PartialEq)]
enum Sent {
    Text(String),
    Close(u16),
}

struct TestSocket {
    incoming: mpsc::UnboundedReceiver<Incoming>,
    sent: mpsc::UnboundedSender<Sent>,
}

impl Transport for TestSocket {
    async fn recv(&mut self) -> Incoming {
        self.incoming.recv().await.unwrap_or(Incoming::Closed)
    }
    async fn send(&mut self, text: String) -> bool {
        self.sent.send(Sent::Text(text)).is_ok()
    }
    async fn close(&mut self, code: u16, _: &'static str) {
        let _ = self.sent.send(Sent::Close(code));
    }
}

struct Client {
    to_server: mpsc::UnboundedSender<Incoming>,
    from_server: mpsc::UnboundedReceiver<Sent>,
}

impl Client {
    fn connect(table: MethodTable, options: SessionOptions) -> Self {
        let (to_server, incoming) = mpsc::unbounded_channel();
        let (sent, from_server) = mpsc::unbounded_channel();
        tokio::spawn(run(TestSocket { incoming, sent }, Arc::new(table), options));
        Self {
            to_server,
            from_server,
        }
    }

    fn send(&self, frame: Value) {
        self.send_text(frame.to_string());
    }

    fn send_text(&self, text: String) {
        let _ = self.to_server.send(Incoming::Text(text));
    }

    fn request(&self, id: i64, tag: &str, payload: Value) {
        self.send(
            json!({"_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": []}),
        );
    }

    fn ack(&self, id: i64) {
        self.send(json!({"_tag": "Ack", "requestId": id}));
    }

    /// Everything the server sent so far, once all tasks are idle.
    async fn drain(&mut self) -> Vec<Sent> {
        settle().await;
        let mut out = Vec::new();
        while let Ok(sent) = self.from_server.try_recv() {
            out.push(sent);
        }
        out
    }

    /// Server frames sent so far, decoded; panics on a close.
    async fn frames(&mut self) -> Vec<Value> {
        self.drain()
            .await
            .into_iter()
            .map(|sent| match sent {
                Sent::Text(text) => serde_json::from_str(&text).unwrap(),
                Sent::Close(code) => panic!("unexpected close {code}"),
            })
            .collect()
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

fn options() -> SessionOptions {
    SessionOptions {
        idle_timeout: Duration::from_secs(3600),
        ..SessionOptions::default()
    }
}

/// A stream handler fed one value at a time by a producer, which records how far it got
/// and when the session dropped the stream.
#[derive(Clone, Default)]
struct Producer {
    produced: Arc<AtomicUsize>,
    dropped: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl Producer {
    fn register(&self, table: &mut MethodTable, tag: &'static str, total: usize) {
        let this = self.clone();
        table.stream(tag, move |_, _: Value| {
            let this = this.clone();
            async move {
                let (tx, rx) = mpsc::channel(1);
                tokio::spawn(async move {
                    // A finite producer drops `tx` after `total`, which ends the stream.
                    for n in 0..total {
                        if tx.send(Ok(json!(n))).await.is_err() {
                            if let Some(dropped) = this.dropped.lock().unwrap().take() {
                                let _ = dropped.send(());
                            }
                            return;
                        }
                        this.produced.fetch_add(1, Ordering::SeqCst);
                    }
                });
                Ok(rx)
            }
        });
    }

    fn on_drop(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        *self.dropped.lock().unwrap() = Some(tx);
        rx
    }
}

fn chunks(frames: &[Value], id: i64) -> Vec<&Value> {
    frames
        .iter()
        .filter(|f| f["_tag"] == "Chunk" && f["requestId"] == id)
        .collect()
}

fn exit(frames: &[Value], id: i64) -> Option<&Value> {
    frames
        .iter()
        .find(|f| f["_tag"] == "Exit" && f["requestId"] == id)
        .map(|f| &f["exit"])
}

fn values(frames: &[Value], id: i64) -> Vec<Value> {
    chunks(frames, id)
        .into_iter()
        .flat_map(|c| c["values"].as_array().unwrap().clone())
        .collect()
}

#[tokio::test(start_paused = true)]
async fn answers_unary_calls_pings_and_unknown_methods() {
    let mut table = MethodTable::new();
    table.unary("server.probe", |ctx: CallContext, _: Value| async move {
        Ok(json!({ "headers": ctx.headers }))
    });
    table.unary("server.getConfig", |_, _: Value| async {
        Err::<Value, _>(Failure::Fail(json!({"_tag": "E"})))
    });
    let mut client = Client::connect(table, options());
    client.send(json!({"_tag": "Request", "id": 1, "tag": "server.probe", "payload": {}, "headers": [["x", "y"]]}));
    client.request(2, "server.getConfig", json!({}));
    client.request(3, "server.nope", json!({}));
    client.send(json!({"_tag": "Ping"}));
    let frames = client.frames().await;
    assert_eq!(
        exit(&frames, 1),
        Some(&json!({"_tag": "Success", "value": {"headers": [["x", "y"]]}}))
    );
    assert_eq!(
        exit(&frames, 2),
        Some(&json!({"_tag": "Failure", "cause": [{"_tag": "Fail", "error": {"_tag": "E"}}]}))
    );
    assert_eq!(
        exit(&frames, 3).unwrap()["cause"][0]["defect"]["name"],
        "ConnServerNotSupported"
    );
    assert!(frames.contains(&json!({"_tag": "Pong"})));
    assert_eq!(frames.len(), 4);
}

#[tokio::test(start_paused = true)]
async fn bad_json_and_bad_payloads_do_not_end_the_connection() {
    let mut table = MethodTable::new();
    #[derive(serde::Deserialize)]
    struct Input {
        #[expect(
            dead_code,
            reason = "only decoded, to test a payload that does not fit"
        )]
        name: String,
    }
    table.unary("server.getConfig", |_, _: Input| async { Ok(json!(1)) });
    let mut client = Client::connect(table, options());
    client.send_text("{not json".into());
    client.send(json!({"_tag": "Nope"}));
    client.request(1, "server.getConfig", json!({"other": 1}));
    let frames = client.frames().await;
    assert_eq!(frames[0]["_tag"], "Defect");
    assert_eq!(frames[0]["defect"]["name"], "ConnServerProtocolError");
    assert_eq!(frames[1]["_tag"], "Defect");
    let defect = &exit(&frames, 1).unwrap()["cause"][0]["defect"];
    assert!(
        defect["message"]
            .as_str()
            .unwrap()
            .contains("invalid payload")
    );
    client.send(json!({"_tag": "Ping"}));
    assert_eq!(client.frames().await, vec![json!({"_tag": "Pong"})]);
}

#[tokio::test(start_paused = true)]
async fn a_windowed_stream_runs_eight_chunks_ahead_and_no_further() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeShell", 20);
    let mut client = Client::connect(table, options());
    client.request(1, "orchestration.subscribeShell", json!({}));

    let frames = client.frames().await;
    assert_eq!(chunks(&frames, 1).len(), ack_window::MAX_PENDING_CHUNKS);
    // The producer is blocked: one value in the channel, one in its hand.
    assert!(producer.produced.load(Ordering::SeqCst) <= ack_window::MAX_PENDING_CHUNKS + 2);

    let mut all = values(&frames, 1);
    client.ack(1);
    let mut frames = client.frames().await;
    assert_eq!(chunks(&frames, 1).len(), 1);
    // Ack every chunk as it arrives, as the Effect client does, until the stream ends.
    loop {
        all.extend(values(&frames, 1));
        if let Some(exit) = exit(&frames, 1) {
            assert_eq!(exit, &json!({"_tag": "Success", "value": null}));
            break;
        }
        for _ in chunks(&frames, 1) {
            client.ack(1);
        }
        frames = client.frames().await;
    }
    assert_eq!(all, (0..20).map(|n| json!(n)).collect::<Vec<_>>());
}

#[tokio::test(start_paused = true)]
async fn an_unwindowed_stream_waits_for_each_ack() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "subscribeVcsStatus", 3);
    let mut client = Client::connect(table, options());
    client.request(1, "subscribeVcsStatus", json!({}));
    let mut seen = Vec::new();
    for _ in 0..3 {
        let frames = client.frames().await;
        assert_eq!(chunks(&frames, 1).len(), 1);
        seen.extend(values(&frames, 1));
        client.ack(1);
    }
    let frames = client.frames().await;
    assert_eq!(
        exit(&frames, 1),
        Some(&json!({"_tag": "Success", "value": null}))
    );
    assert_eq!(seen, vec![json!(0), json!(1), json!(2)]);
}

#[tokio::test(start_paused = true)]
async fn interrupt_ends_the_stream_and_drops_its_items() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeThread", usize::MAX - 1);
    let dropped = producer.on_drop();
    let mut client = Client::connect(table, options());
    client.request(1, "orchestration.subscribeThread", json!({}));
    assert_eq!(chunks(&client.frames().await, 1).len(), 8);
    client.send(json!({"_tag": "Interrupt", "requestId": 1}));
    client.ack(1);
    let frames = client.frames().await;
    assert_eq!(
        frames,
        vec![
            json!({"_tag": "Exit", "requestId": 1, "exit": {"_tag": "Failure", "cause": [{"_tag": "Interrupt", "fiberId": null}]}})
        ]
    );
    dropped.await.expect("the handler's stream was dropped");
    // An unknown id gets an interrupt exit too, as Effect sends.
    client.send(json!({"_tag": "Interrupt", "requestId": 9}));
    assert_eq!(
        exit(&client.frames().await, 9).unwrap()["cause"][0]["_tag"],
        "Interrupt"
    );
}

#[tokio::test(start_paused = true)]
async fn disconnect_stops_every_stream() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeShell", usize::MAX - 1);
    let dropped = producer.on_drop();
    let mut client = Client::connect(table, options());
    client.request(1, "orchestration.subscribeShell", json!({}));
    assert_eq!(chunks(&client.frames().await, 1).len(), 8);
    let _ = client.to_server.send(Incoming::Closed);
    dropped.await.expect("the handler's stream was dropped");
    let produced = producer.produced.load(Ordering::SeqCst);
    settle().await;
    assert_eq!(producer.produced.load(Ordering::SeqCst), produced);
}

#[tokio::test(start_paused = true)]
async fn eof_closes_once_in_flight_calls_finish() {
    let mut table = MethodTable::new();
    let gate: Arc<Mutex<Option<oneshot::Receiver<()>>>> = Arc::default();
    let (open, rx) = oneshot::channel();
    *gate.lock().unwrap() = Some(rx);
    table.unary("server.getConfig", move |_, _: Value| {
        let rx = gate.lock().unwrap().take();
        async move {
            if let Some(rx) = rx {
                let _ = rx.await;
            }
            Ok(json!("done"))
        }
    });
    let mut client = Client::connect(table, options());
    client.request(1, "server.getConfig", json!({}));
    client.send(json!({"_tag": "Eof"}));
    client.request(2, "server.getConfig", json!({}));
    assert_eq!(client.drain().await, vec![]);
    open.send(()).unwrap();
    let sent = client.drain().await;
    assert_eq!(sent.len(), 2, "{sent:?}");
    let Sent::Text(text) = &sent[0] else { panic!() };
    assert!(text.contains(r#""value":"done""#));
    assert_eq!(sent[1], Sent::Close(CLOSE_NORMAL));
}

#[tokio::test(start_paused = true)]
async fn notifications_and_discards_get_no_replies_beyond_the_ack() {
    let mut table = MethodTable::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    table.unary("server.getConfig", move |_, _: Value| {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Err::<Value, _>(Failure::die("boom")) }
    });
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeShell", 3);
    let mut client = Client::connect(table, options());
    client.send(json!({"_tag": "Request", "id": 1, "tag": "server.getConfig", "payload": {}, "headers": [], "isNotification": true}));
    client.send(json!({"_tag": "Request", "id": 2, "tag": "server.getConfig", "payload": {}, "headers": [], "discard": true}));
    client.send(json!({"_tag": "Request", "id": 3, "tag": "orchestration.subscribeShell", "payload": {}, "headers": [], "discard": true}));
    let frames = client.frames().await;
    assert_eq!(
        frames,
        vec![
            json!({"_tag": "Exit", "requestId": 2, "exit": {"_tag": "Success", "value": null}}),
            json!({"_tag": "Exit", "requestId": 3, "exit": {"_tag": "Success", "value": null}}),
        ]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(producer.produced.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn large_replies_go_out_in_parts_when_asked() {
    let big = "é".repeat(60_000); // 120 KB of UTF-8
    for frame_parts in [false, true] {
        let mut t = MethodTable::new();
        let reply = big.clone();
        t.unary("server.getConfig", move |_, _: Value| {
            let reply = reply.clone();
            async move { Ok(json!(reply)) }
        });
        let mut client = Client::connect(
            t,
            SessionOptions {
                frame_parts,
                ..options()
            },
        );
        client.request(1, "server.getConfig", json!({}));
        let texts: Vec<String> = client
            .drain()
            .await
            .into_iter()
            .map(|s| match s {
                Sent::Text(t) => t,
                Sent::Close(_) => panic!(),
            })
            .collect();
        let mut joiner = frame_parts::Joiner::new(usize::MAX);
        let mut whole = None;
        for text in &texts {
            if frame_parts {
                assert!(text.len() <= frame_parts::PART_BYTES);
            }
            whole = joiner.push(text).unwrap();
        }
        assert_eq!(texts.len() > 1, frame_parts);
        let frame: Value = serde_json::from_str(&whole.unwrap()).unwrap();
        assert_eq!(frame["exit"]["value"], json!(big));
    }
}

#[tokio::test(start_paused = true)]
async fn each_connection_has_its_own_id_for_all_its_calls() {
    let whoami = || {
        let mut t = MethodTable::new();
        t.unary("server.getConfig", |ctx, _: Value| async move {
            Ok(json!(ctx.connection_id))
        });
        t
    };
    let mut ids = Vec::new();
    for mut client in [
        Client::connect(whoami(), options()),
        Client::connect(whoami(), options()),
    ] {
        client.request(1, "server.getConfig", json!({}));
        client.request(2, "server.getConfig", json!({}));
        let values: Vec<u64> = client
            .frames()
            .await
            .iter()
            .map(|f| f["exit"]["value"].as_u64().unwrap())
            .collect();
        assert_eq!(values[0], values[1]);
        ids.push(values[0]);
    }
    assert!(ids[0] != 0 && ids[1] != 0 && ids[0] != ids[1], "{ids:?}");
}

#[tokio::test(start_paused = true)]
async fn joins_client_parts_and_closes_on_oversized_messages() {
    let mut table = MethodTable::new();
    table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
    let mut client = Client::connect(
        table,
        SessionOptions {
            max_message_bytes: 256,
            ..options()
        },
    );
    let request =
        json!({"_tag": "Request", "id": 1, "tag": "server.probe", "payload": {}, "headers": []})
            .to_string();
    let (head, tail) = request.split_at(20);
    client.send_text(format!("\u{1e}{head}"));
    client.send_text(tail.to_owned());
    assert_eq!(
        exit(&client.frames().await, 1),
        Some(&json!({"_tag": "Success", "value": {}}))
    );

    client.send_text(format!("\u{1e}{}", "x".repeat(200)));
    client.send_text("y".repeat(100));
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_TOO_LARGE)]);

    let mut table = MethodTable::new();
    table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
    let mut client = Client::connect(table, options());
    let _ = client.to_server.send(Incoming::TooLarge);
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_TOO_LARGE)]);
}

#[tokio::test(start_paused = true)]
async fn idle_connections_close() {
    let mut client = Client::connect(
        MethodTable::new(),
        SessionOptions {
            idle_timeout: Duration::from_secs(60),
            ..SessionOptions::default()
        },
    );
    tokio::time::sleep(Duration::from_secs(30)).await;
    client.send(json!({"_tag": "Ping"}));
    tokio::time::sleep(Duration::from_secs(45)).await;
    assert_eq!(
        client.drain().await,
        vec![Sent::Text(r#"{"_tag":"Pong"}"#.into())]
    );
    tokio::time::sleep(Duration::from_secs(20)).await;
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_GOING_AWAY)]);
}

#[tokio::test(start_paused = true)]
async fn a_byte_windowed_chunk_holds_at_most_the_window_of_events() {
    // Five output events of 20 KiB wait in the stream before the session reads it. JSON
    // escapes make each line longer on the wire, but T3 charges the event's own bytes.
    let event = json!({
        "type": "output", "threadId": "t", "terminalId": "x", "sequence": 1,
        "data": "0123456789abcdef\r\n".repeat(20 * 1024 / 18),
    });
    let mut table = MethodTable::new();
    let queued = event.clone();
    table.stream("terminal.attach", move |_, _: Value| {
        let event = queued.clone();
        async move {
            let (tx, rx) = mpsc::channel(8);
            for _ in 0..5 {
                let _ = tx.try_send(Ok(event.clone()));
            }
            Ok(rx)
        }
    });
    let mut client = Client::connect(table, options());
    client.request(1, "terminal.attach", json!({}));
    let frames = client.frames().await;
    let sizes: Vec<usize> = chunks(&frames, 1)
        .iter()
        .map(|chunk| ack_window::chunk_size(chunk["values"].as_array().unwrap()))
        .collect();
    // Three events fit the window (3 x 20 KiB); the next two go in a second chunk.
    assert_eq!(
        chunks(&frames, 1)
            .iter()
            .map(|chunk| chunk["values"].as_array().unwrap().len())
            .collect::<Vec<_>>(),
        vec![3, 2],
        "chunk sizes {sizes:?}"
    );
    assert!(
        sizes
            .iter()
            .all(|&size| size <= ack_window::MAX_PENDING_BYTES + ack_window::VALUE_OVERHEAD_BYTES),
        "chunk sizes {sizes:?}"
    );
    assert_eq!(values(&frames, 1).len(), 5);
}

/// A gate the test closes by hand.
struct TestGate {
    open: std::sync::atomic::AtomicBool,
    closed: tokio::sync::watch::Sender<bool>,
}

impl TestGate {
    fn new(open: bool) -> Arc<Self> {
        Arc::new(Self {
            open: std::sync::atomic::AtomicBool::new(open),
            closed: tokio::sync::watch::channel(!open).0,
        })
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
        let _ = self.closed.send(true);
    }
}

impl Gate for TestGate {
    fn state(&self) -> GateState {
        if self.open.load(Ordering::SeqCst) {
            GateState::Open
        } else {
            GateState::Closed
        }
    }

    fn changed(&self) -> futures_core::future::BoxFuture<'static, ()> {
        Box::pin(std::future::pending())
    }

    fn closed(&self) -> futures_core::future::BoxFuture<'static, ()> {
        let mut closed = self.closed.subscribe();
        Box::pin(async move {
            let _ = closed.wait_for(|c| *c).await;
        })
    }
}

/// Managed access: a fence ends a running stream at once with a policy close, and no chunk
/// the stream queued after it reaches the socket.
#[tokio::test(start_paused = true)]
async fn a_closed_gate_ends_the_session_and_sends_no_queued_frame() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeShell", usize::MAX - 1);
    let gate = TestGate::new(true);
    let mut client = Client::connect(
        table,
        SessionOptions {
            gate: Some(SessionGate(gate.clone())),
            ..options()
        },
    );
    client.request(1, "orchestration.subscribeShell", json!({}));
    let frames = client.frames().await;
    assert!(!chunks(&frames, 1).is_empty());
    let dropped = producer.on_drop();
    // The producer has more queued; the gate closes before the client acks.
    gate.open.store(false, Ordering::SeqCst);
    client.ack(1);
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_POLICY)]);
    gate.close();
    assert!(dropped.await.is_ok(), "the stream's producer was dropped");
}

/// A gate that is already closed when a request arrives refuses the dispatch: the handler
/// never runs. This is the fence that lands during the upgrade.
#[tokio::test(start_paused = true)]
async fn a_closed_gate_refuses_dispatch() {
    let mut table = MethodTable::new();
    let producer = Producer::default();
    producer.register(&mut table, "orchestration.subscribeShell", 5);
    let gate = TestGate::new(true);
    let mut client = Client::connect(
        table,
        SessionOptions {
            gate: Some(SessionGate(gate.clone())),
            ..options()
        },
    );
    settle().await;
    gate.open.store(false, Ordering::SeqCst);
    client.request(1, "orchestration.subscribeShell", json!({}));
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_POLICY)]);
    assert_eq!(producer.produced.load(Ordering::SeqCst), 0);
}

/// The gate's close signal ends an idle session without any frame or call.
#[tokio::test(start_paused = true)]
async fn a_gate_close_ends_an_idle_session() {
    let gate = TestGate::new(true);
    let mut client = Client::connect(
        MethodTable::new(),
        SessionOptions {
            gate: Some(SessionGate(gate.clone())),
            ..options()
        },
    );
    settle().await;
    gate.close();
    assert_eq!(client.drain().await, vec![Sent::Close(CLOSE_POLICY)]);
}
