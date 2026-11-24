//! The shell and thread streams: a snapshot or a replay, `synchronized` when the client asks
//! for it, then live items.
//!
//! A stream task holds only its cursor. It wakes when a write commits and reads what is new
//! from the store, so a slow client never makes the engine buffer items, and a snapshot and the
//! updates after it can never overlap or leave a gap: both are read by sequence.

use std::{collections::HashMap, sync::Arc};

use conn_contract::{
    GetShellSnapshotError, GetThreadProjectionError, ShellStreamItem, ThreadStreamItem, from_json,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::engine::{Inner, contract_error, rejected};
use crate::store::Store;
use crate::{EngineError, Subscription};

/// `THREAD_RESUME_MAX_REPLAY_EVENTS` in `ThreadStream.ts`: a longer gap gets a snapshot.
const MAX_REPLAY_EVENTS: usize = 128;
/// `THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES` and `THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES`: a
/// replay larger than this, as stored payloads or as sent items, gets a snapshot too.
const MAX_REPLAY_BYTES: u64 = 1_048_576;
const LIVE_READ_BATCH: usize = 256;

fn shell_error(message: impl Into<String>) -> Result<GetShellSnapshotError, String> {
    contract_error(
        json!({"_tag": "OrchestrationV2GetShellSnapshotError", "message": message.into()}),
    )
}

fn thread_error(
    thread_id: &str,
    message: impl Into<String>,
) -> Result<GetThreadProjectionError, String> {
    contract_error(json!({
        "_tag": "OrchestrationV2GetThreadProjectionError",
        "threadId": thread_id,
        "message": message.into(),
    }))
}

/// Ends a stream with an error. An error the contract no longer accepts ends it without one.
async fn fail<T, E>(tx: &mpsc::Sender<Result<T, E>>, error: Result<E, String>) {
    match error {
        Ok(error) => {
            let _ = tx.send(Err(error)).await;
        }
        Err(reason) => eprintln!("conn-engine: {reason}"),
    }
}

/// Sends one item. False when the subscriber is gone or the item does not fit the contract.
async fn send<T: DeserializeOwned, E>(
    tx: &mpsc::Sender<Result<T, E>>,
    item: Value,
    error: impl Fn(String) -> Result<E, String>,
) -> bool {
    match from_json::<T>(item) {
        Ok(item) => tx.send(Ok(item)).await.is_ok(),
        Err(e) => {
            fail(tx, error(format!("conn-engine built an invalid item: {e}"))).await;
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
            let resumed = match after {
                Some(after) if store.shell_resumable(after)? => store.shell_changes_since(after)?,
                _ => None,
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
                    fail(&tx, shell_error(e)).await;
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

/// Whether a thread or shell stream can resume from `after` by replaying. A cursor above the
/// high water is from another database. A cursor at or below the T3 import boundary
/// (`imported`, 0 when never imported) may be the T3 server's: the rows it imported have no
/// events here, so only a snapshot is complete.
pub(crate) fn can_replay(after: u64, high: u64, imported: u64) -> bool {
    after <= high && (imported == 0 || after > imported)
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
    let dedupe = input["acceptDedupedBodies"] == true;
    let omit_local = input["acceptCompactTurnItems"] == true;
    let mut wake = inner.notify.subscribe();
    let id = thread_id.clone();
    let first = inner
        .db(move |store| -> Result<Option<(Vec<Value>, u64)>, String> {
            let high = store.high_water();
            // T3 replays a resumed stream before it looks for the thread (`ws.ts`), so a
            // client that missed a deletion gets `thread.deleted`.
            let imported = store.imported_through();
            if let Some(after) = after.filter(|after| can_replay(*after, high, imported))
                && store.thread_known(&id)?
                && let Some(items) = replay(store, &id, after)?
            {
                return Ok(Some((items, high)));
            }
            if !store.thread_exists(&id)? {
                return Ok(None);
            }
            let (projection, omitted) = store
                .thread_projection_with(&id, omit_local)?
                .unwrap_or((Value::Null, false));
            Ok(Some((
                vec![snapshot_item(projection, high, dedupe, omitted)],
                high,
            )))
        })
        .await
        .map_err(EngineError::Internal)?;
    let Some((first, mut cursor)) = first else {
        return Err(rejected(thread_error(
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
                        fail(&tx, error(e)).await;
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

/// The items a resume from `after` replays, or `None` when it needs a snapshot, decided as
/// `ws.ts` `subscribeThread` does: more than 128 events or 1 MiB of stored payload JSON; a
/// `thread.created` of a thread that exists now (deleted and created again under its ID); or
/// more than 1 MiB of items once streamed updates are coalesced.
fn replay(store: &Store, id: &str, after: u64) -> Result<Option<Vec<Value>>, String> {
    let stats = store.thread_replay_stats(id, after, MAX_REPLAY_EVENTS + 1)?;
    if stats.events > MAX_REPLAY_EVENTS as u64 || stats.payload_bytes > MAX_REPLAY_BYTES {
        return Ok(None);
    }
    if stats.has_create && store.thread_exists(id)? {
        return Ok(None);
    }
    let events = store.thread_events_after(id, after, MAX_REPLAY_EVENTS + 1)?;
    let items = coalesce(events.into_iter().map(event_item).collect());
    let fits = items.len() <= MAX_REPLAY_EVENTS && encoded_bytes(&items) <= MAX_REPLAY_BYTES;
    Ok(fits.then_some(items))
}

/// `coalesceLiveUpdatedEvents`: of consecutive updates to one streamed message or running
/// turn item, only the last stays, at its own place and sequence. An update to another
/// entity of the same event type, or any other event, ends the run.
fn coalesce(items: Vec<Value>) -> Vec<Value> {
    let mut latest: HashMap<String, usize> = HashMap::new();
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut superseded = vec![false; items.len()];
    for (index, item) in items.iter().enumerate() {
        let event = &item["event"];
        let Some(key) = coalescible_key(event) else {
            latest.clear();
            pending.clear();
            continue;
        };
        let kind = event["type"].as_str().unwrap_or_default().to_owned();
        if pending.get(&kind).is_some_and(|open| *open != key) {
            latest.clear();
        }
        pending.insert(kind, key.clone());
        if let Some(previous) = latest.insert(key, index)
            && let Some(slot) = superseded.get_mut(previous)
        {
            *slot = true;
        }
    }
    items
        .into_iter()
        .zip(superseded)
        .filter_map(|(item, superseded)| (!superseded).then_some(item))
        .collect()
}

/// `coalescibleUpdateKey`.
fn coalescible_key(event: &Value) -> Option<String> {
    let kind = event["type"].as_str()?;
    let payload = &event["payload"];
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let prefix = format!(
        "{}\0{}\0{kind}",
        text(&event["threadId"]),
        text(&event["runId"])
    );
    match kind {
        "message.updated" => (payload["role"] == "assistant" && payload["streaming"] == true)
            .then(|| format!("{prefix}\0{}", text(&payload["id"]))),
        "turn-item.updated" if payload["status"] == "running" => {
            let item = payload["type"].as_str()?;
            let streams = match item {
                "assistant_message" | "reasoning" => payload["streaming"] == true,
                "command_execution" | "file_change" | "file_search" | "web_search"
                | "dynamic_tool" => true,
                _ => false,
            };
            streams.then(|| format!("{prefix}\0{item}\0{}", text(&payload["id"])))
        }
        _ => None,
    }
}

/// `threadReplayEncodedBytes`: the items' JSON bytes, counted without keeping the text, up to
/// the first total over [`MAX_REPLAY_BYTES`].
fn encoded_bytes(items: &[Value]) -> u64 {
    struct Count(u64);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len() as u64;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    for item in items {
        if serde_json::to_writer(&mut count, item).is_err() || count.0 > MAX_REPLAY_BYTES {
            return count.0.max(MAX_REPLAY_BYTES + 1);
        }
    }
    count.0
}

/// The thread snapshot item, compacted for clients that opted in: a turn item's text that its
/// message carries is blanked and marked (`acceptDedupedBodies`), and `turnItems` leaves out
/// the items `visibleTurnItems` already holds (`acceptCompactTurnItems`). Clients undo both
/// with `boundedSnapshotProjection` on every snapshot. Either roughly halves a long thread's
/// snapshot, as each item otherwise travels twice and each message three times.
fn snapshot_item(mut projection: Value, high: u64, dedupe: bool, omitted: bool) -> Value {
    if dedupe {
        let index = |collection: &str| -> HashMap<String, usize> {
            projection[collection]
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .enumerate()
                        .filter_map(|(i, r)| r["id"].as_str().map(|id| (id.to_owned(), i)))
                        .collect()
                })
                .unwrap_or_default()
        };
        let (messages, subagents) = (index("messages"), index("subagents"));
        let text_of = |id: &Value| {
            let at = *messages.get(id.as_str()?)?;
            Some(projection["messages"][at]["text"].clone())
        };
        let subagent_of = |id: &Value| {
            let row = &projection["subagents"][*subagents.get(id.as_str()?)?];
            Some((row["prompt"].clone(), row["result"].clone()))
        };
        let mut changes: Vec<(usize, Value)> = vec![];
        if let Some(rows) = projection["visibleTurnItems"].as_array() {
            for (index, row) in rows.iter().enumerate() {
                let mut item = row["item"].clone();
                let mut changed = false;
                match item["type"].as_str() {
                    Some("user_message" | "assistant_message")
                        if item["text"] != ""
                            && text_of(&item["messageId"]).as_ref() == Some(&item["text"]) =>
                    {
                        item["text"] = json!("");
                        item["textOmitted"] = json!(true);
                        changed = true;
                    }
                    Some("subagent") => {
                        if let Some((prompt, result)) = subagent_of(&item["subagentId"]) {
                            if item["prompt"] != "" && item["prompt"] == prompt {
                                item["prompt"] = json!("");
                                item["promptOmitted"] = json!(true);
                                changed = true;
                            }
                            if !item["result"].is_null() && item["result"] == result {
                                item["result"] = Value::Null;
                                item["resultOmitted"] = json!(true);
                                changed = true;
                            }
                        }
                    }
                    _ => {}
                }
                if changed {
                    changes.push((index, item));
                }
            }
        }
        let items = index("turnItems");
        for (row, item) in changes {
            if let Some(at) = item["id"].as_str().and_then(|id| items.get(id)) {
                projection["turnItems"][*at] = item.clone();
            }
            projection["visibleTurnItems"][row]["item"] = item;
        }
    }
    let mut snapshot = json!({"kind": "snapshot", "snapshotSequence": high});
    // The store left the visible local rows out of `turnItems` (they were its first items).
    if omitted {
        snapshot["turnItemsOmitLocalVisible"] = json!(true);
    }
    snapshot["projection"] = projection;
    snapshot
}

fn event_item((sequence, event): (u64, Value)) -> Value {
    json!({"kind": "event", "sequence": sequence, "event": event})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `coalesceLiveUpdatedEvents`: a run of one message's streamed updates keeps its last
    /// one; another message of the same type, or another event, ends the run.
    #[test]
    fn coalesce_keeps_the_last_update_of_each_run() {
        let update = |seq: u64, id: &str| {
            event_item((
                seq,
                json!({"type": "message.updated", "threadId": "t1", "runId": "r1",
                "payload": {"id": id, "role": "assistant", "streaming": true}}),
            ))
        };
        let other = event_item((5, json!({"type": "run.updated", "threadId": "t1"})));
        let items = vec![
            update(1, "a"),
            update(2, "a"),
            update(3, "b"),
            update(4, "a"),
            other,
            update(6, "a"),
            update(7, "a"),
        ];
        let kept: Vec<u64> = coalesce(items)
            .iter()
            .filter_map(|item| item["sequence"].as_u64())
            .collect();
        assert_eq!(kept, [2, 3, 4, 5, 7]);
    }
}
