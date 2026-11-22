//! End-to-end thread open against a mock `conn-server` socket: the `subscribeThread` opt-ins,
//! a frame-split multi-megabyte snapshot, and the `synchronized` marker.

use std::time::{Duration, Instant};

use conn_client::{ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig};
use conn_contract::OrchestrationV2ThreadStreamItem as Item;
use conn_state::testkit::{SyntheticThread, synthetic_thread_snapshot_json};
use conn_wire::{FromClient, frame_parts};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test uses assert! for diffs while propagating setup errors with ?"
)]
async fn opens_a_large_thread_with_completion_marker() -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = synthetic_thread_snapshot_json(SyntheticThread::sized(5 * 1024 * 1024));
    let snapshot_mib = snapshot.len() as f64 / (1024.0 * 1024.0);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (payload_tx, mut payload_rx) = mpsc::unbounded_channel::<Value>();

    let server = tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
            return;
        };
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(frames) = conn_wire::decode_client_message(&text) else {
                continue;
            };
            for frame in frames {
                let FromClient::Request(req) = frame else {
                    continue;
                };
                if req.tag != "orchestration.subscribeThread" {
                    continue;
                }
                let _ = payload_tx.send(req.payload.clone());
                let id = serde_json::to_string(&req.id).unwrap_or_default();
                // Send exactly what conn-server sends: one Chunk per item, split into
                // 48 KiB frame parts.
                for item in [snapshot.as_str(), r#"{"kind":"synchronized"}"#] {
                    let raw = format!(r#"{{"_tag":"Chunk","requestId":{id},"values":[{item}]}}"#);
                    for part in frame_parts::split(&raw, frame_parts::PART_BYTES) {
                        if ws.send(Message::Text(part.into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });

    let config = ServerConfig {
        http_base_url: url::Url::parse(&format!("http://{addr}"))?,
        credential: Credential::Bearer("test-bearer".to_owned()),
    };
    let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await? {
            Some(ClientEvent::Status(ConnectionStatus::Connected)) => break,
            Some(_) => {}
            None => return Err("event channel closed".into()),
        }
    }

    let opened_at = Instant::now();
    conn.subscribe_thread("thread-1");
    let payload = tokio::time::timeout(Duration::from_secs(5), payload_rx.recv())
        .await?
        .ok_or("no subscribeThread payload")?;
    assert_eq!(
        payload["requestCompletionMarker"], true,
        "must ask for `synchronized`"
    );
    assert_eq!(
        payload["acceptDedupedBodies"], true,
        "must accept deduped bodies"
    );
    assert_eq!(
        payload["acceptCompactTurnItems"], true,
        "must accept compact turn items"
    );
    for flag in ["acceptDeferredWork", "acceptCompactIds"] {
        assert!(
            payload.get(flag).is_none(),
            "{flag} must stay off: this client cannot decode it"
        );
    }

    let mut snapshot_ms = None;
    let mut synchronized_ms = None;
    while synchronized_ms.is_none() {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await?
            .ok_or("event channel closed")?;
        if let ClientEvent::Thread { item, .. } = event {
            let at = opened_at.elapsed().as_secs_f64() * 1000.0;
            match item {
                Item::Snapshot(s) => {
                    assert!(
                        !s.projection.visible_turn_items.is_empty(),
                        "snapshot must carry its rows"
                    );
                    snapshot_ms = Some(at);
                }
                Item::Synchronized(_) => synchronized_ms = Some(at),
                Item::Event(_) | Item::Event2(_) => {}
            }
        }
    }
    let snapshot_ms = snapshot_ms.ok_or("snapshot must arrive before synchronized")?;
    println!(
        "{snapshot_mib:.1} MiB snapshot: decoded event after {snapshot_ms:.1} ms, synchronized after {:.1} ms",
        synchronized_ms.unwrap_or_default()
    );

    conn.close();
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    Ok(())
}
