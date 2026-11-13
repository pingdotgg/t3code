//! The shell and thread streams: a snapshot or a replay, `synchronized` when the client asks
//! for it, then live items.
//!
//! A stream task holds only its cursor. It wakes when a write commits and reads what is new
//! from the store, so a slow client never makes the engine buffer items, and a snapshot and the
//! updates after it can never overlap or leave a gap: both are read by sequence.

use std::sync::Arc;

use conn_contract::{
    GetShellSnapshotError, GetThreadProjectionError, ShellStreamItem, ThreadStreamItem, from_json,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::engine::Inner;
use crate::{EngineError, Subscription};

/// `THREAD_RESUME_MAX_REPLAY_EVENTS` in `ThreadStream.ts`: a longer gap gets a snapshot.
const MAX_REPLAY_EVENTS: usize = 128;
const LIVE_READ_BATCH: usize = 256;

fn shell_error(message: impl Into<String>) -> GetShellSnapshotError {
    from_json(json!({"_tag": "OrchestrationV2GetShellSnapshotError", "message": message.into()}))
        .expect("error shape")
}

fn thread_error(thread_id: &str, message: impl Into<String>) -> GetThreadProjectionError {
    from_json(json!({
        "_tag": "OrchestrationV2GetThreadProjectionError",
        "threadId": thread_id,
        "message": message.into(),
    }))
    .expect("error shape")
}

/// Sends one item. False when the subscriber is gone or the item does not fit the contract.
async fn send<T: DeserializeOwned, E>(
    tx: &mpsc::Sender<Result<T, E>>,
    item: Value,
    error: impl Fn(String) -> E,
) -> bool {
    match from_json::<T>(item) {
        Ok(item) => tx.send(Ok(item)).await.is_ok(),
        Err(e) => {
            let _ = tx
                .send(Err(error(format!(
                    "conn-engine built an invalid item: {e}"
                ))))
                .await;
            false
        }
    }
}

pub(crate) async fn subscribe_shell(
    inner: Arc<Inner>,
    input: Value,
) -> Result<Subscription<ShellStreamItem, GetShellSnapshotError>, EngineError<GetShellSnapshotError>>
{
    let after = input["afterSequence"].as_u64();
    let fallback = input["httpSnapshotFallback"] == true;
    let marker = input["requestCompletionMarker"] == true;
    let omit_idle = input["omitIdleSubagents"] == true;
    let omit_older = input["omitOlderSettled"] == true;
    // Subscribe before reading, so a commit between the read and the first wait still wakes us.
    let mut wake = inner.notify.subscribe();
    let (first, mut cursor) = inner
        .db(move |store| -> Result<(Vec<Value>, u64), String> {
            let high = store.high_water();
            let resumed = match after.filter(|after| *after <= high) {
                Some(after) => store.shell_changes_since(after)?,
                None => None,
            };
            Ok(match resumed {
                Some(items) => (items, high),
                None if after.is_some() && fallback => {
                    (vec![json!({"kind": "snapshot-required"})], high)
                }
                None => (
                    vec![json!({"kind": "snapshot", "snapshot": store.shell_snapshot_trimmed(omit_idle, omit_older)?})],
                    high,
                ),
            })
        })
        .await
        .map_err(EngineError::Internal)?;

    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        for item in first {
            if !send(&tx, item, shell_error).await {
                return;
            }
        }
        if marker && !send(&tx, json!({"kind": "synchronized"}), shell_error).await {
            return;
        }
        loop {
            tokio::select! {
                _ = tx.closed() => return,
                changed = wake.changed() => if changed.is_err() { return },
            }
            let after = cursor;
            let items = match inner
                .db(move |store| -> Result<Vec<Value>, String> {
                    // A reader that fell behind retention starts over from a snapshot.
                    Ok(match store.shell_changes_since(after)? {
                        Some(items) => items,
                        None => {
                            vec![json!({"kind": "snapshot", "snapshot": store.shell_snapshot_trimmed(omit_idle, omit_older)?})]
                        }
                    })
                })
                .await
            {
                Ok(items) => items,
                Err(e) => {
                    let _ = tx.send(Err(shell_error(e))).await;
                    return;
                }
            };
            for item in items {
                let sequence = item["sequence"]
                    .as_u64()
                    .or(item["snapshot"]["snapshotSequence"].as_u64());
                cursor = cursor.max(sequence.unwrap_or(cursor));
                if !send(&tx, item, shell_error).await {
                    return;
                }
            }
        }
    });
    Ok(rx)
}

pub(crate) async fn subscribe_thread(
    inner: Arc<Inner>,
    input: Value,
) -> Result<
    Subscription<ThreadStreamItem, GetThreadProjectionError>,
    EngineError<GetThreadProjectionError>,
> {
    let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
    let after = input["afterSequence"].as_u64();
    let marker = input["requestCompletionMarker"] == true;
    let mut wake = inner.notify.subscribe();
    let id = thread_id.clone();
    let first = inner
        .db(move |store| -> Result<Option<(Vec<Value>, u64)>, String> {
            let high = store.high_water();
            if !store.thread_exists(&id)? {
                return Ok(None);
            }
            if let Some(after) = after.filter(|after| *after <= high) {
                let events = store.thread_events_after(&id, after, MAX_REPLAY_EVENTS + 1)?;
                if events.len() <= MAX_REPLAY_EVENTS {
                    let items = events.into_iter().map(event_item).collect();
                    return Ok(Some((items, high)));
                }
            }
            let projection = store.thread_projection(&id)?.unwrap_or(Value::Null);
            Ok(Some((
                vec![
                    json!({"kind": "snapshot", "snapshotSequence": high, "projection": projection}),
                ],
                high,
            )))
        })
        .await
        .map_err(EngineError::Internal)?;
    let Some((first, mut cursor)) = first else {
        return Err(EngineError::Rejected(thread_error(
            &thread_id,
            format!("Thread {thread_id} does not exist."),
        )));
    };

    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        let error = |message: String| thread_error(&thread_id, message);
        for item in first {
            if !send(&tx, item, error).await {
                return;
            }
        }
        if marker && !send(&tx, json!({"kind": "synchronized"}), error).await {
            return;
        }
        loop {
            tokio::select! {
                _ = tx.closed() => return,
                changed = wake.changed() => if changed.is_err() { return },
            }
            loop {
                let (id, after) = (thread_id.clone(), cursor);
                let events = match inner
                    .db(move |store| store.thread_events_after(&id, after, LIVE_READ_BATCH))
                    .await
                {
                    Ok(events) => events,
                    Err(e) => {
                        let _ = tx.send(Err(error(e))).await;
                        return;
                    }
                };
                let full = events.len() == LIVE_READ_BATCH;
                for event in events {
                    cursor = event.0;
                    if !send(&tx, event_item(event), error).await {
                        return;
                    }
                }
                if !full {
                    break;
                }
            }
        }
    });
    Ok(rx)
}

fn event_item((sequence, event): (u64, Value)) -> Value {
    json!({"kind": "event", "sequence": sequence, "event": event})
}
