//! `orchestration.subscribeCommandOutput`: the output of one `command_execution` turn item as
//! `replace` and `append` frames, until the command stops running.
//!
//! Live output comes from [`CommandOutputHub`], fed by the provider's `command_output.delta`
//! (Codex streams it; `CommandOutputHub.ts` upstream). A command without live output follows the
//! stored item: a frame goes out when the provider writes the item. The settled item always has
//! the last word.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::EngineError;
use crate::engine::Inner;
use crate::lock;

/// Frames carry at most the last 64 KiB of output, as the client panel shows a tail.
const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Commands with live output held at once; the least recently written goes first. Upstream
/// keeps 64; 8 caps the hub near 1 MiB.
const MAX_LIVE_COMMANDS: usize = 8;
/// `COMMAND_OUTPUT_MAX_APPEND_CHARS`: a subscriber further behind gets the tail again.
const MAX_APPEND_BYTES: usize = 16 * 1024;
/// `COMMAND_OUTPUT_FRAME_INTERVAL_MS`: the fastest a subscriber gets frames while output flows.
const FRAME_INTERVAL: Duration = Duration::from_millis(100);

fn tail(text: &str) -> (&str, bool) {
    if text.len() <= MAX_FRAME_BYTES {
        return (text, false);
    }
    let mut start = text.len() - MAX_FRAME_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text.get(start..).unwrap_or_default(), true)
}

/// The live output of one running command: a tail of at most [`MAX_FRAME_BYTES`].
struct LiveCommand {
    thread_id: String,
    item_id: String,
    /// New for each entry, so a subscriber notices an entry that was evicted and came back.
    generation: u64,
    /// Bytes appended since the entry began; the tail holds the newest of them.
    total: u64,
    tail: String,
    truncated: bool,
}

/// What a subscriber reads from the hub.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LiveTail {
    generation: u64,
    total: u64,
    text: String,
    truncated: bool,
}

/// Bounded live output of running commands. At most [`MAX_LIVE_COMMANDS`] entries, each a tail
/// of at most 64 KiB (its buffer at most twice that), dropped when the command settles, its run
/// ends or its session closes. Nothing is stored.
pub(crate) struct CommandOutputHub {
    commands: Mutex<VecDeque<LiveCommand>>,
    next_generation: Mutex<u64>,
    /// Bumped on every chunk; subscribers wake on it.
    changed: watch::Sender<u64>,
}

impl Default for CommandOutputHub {
    fn default() -> Self {
        Self {
            commands: Mutex::new(VecDeque::new()),
            next_generation: Mutex::new(0),
            changed: watch::Sender::new(0),
        }
    }
}

impl CommandOutputHub {
    pub(crate) fn append(&self, thread_id: &str, item_id: &str, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        let mut commands = lock(&self.commands);
        let found = commands
            .iter()
            .position(|c| c.thread_id == thread_id && c.item_id == item_id);
        let mut entry = match found.and_then(|at| commands.remove(at)) {
            Some(entry) => entry,
            None => {
                let mut next = lock(&self.next_generation);
                *next += 1;
                LiveCommand {
                    thread_id: thread_id.to_owned(),
                    item_id: item_id.to_owned(),
                    generation: *next,
                    total: 0,
                    tail: String::new(),
                    truncated: false,
                }
            }
        };
        entry.total += chunk.len() as u64;
        let (chunk_tail, cut) = tail(chunk);
        entry.truncated |= cut;
        entry.tail.push_str(chunk_tail);
        if entry.tail.len() > MAX_FRAME_BYTES {
            let mut start = entry.tail.len() - MAX_FRAME_BYTES;
            while !entry.tail.is_char_boundary(start) {
                start += 1;
            }
            entry.tail.drain(..start);
            entry.truncated = true;
        }
        commands.push_back(entry);
        while commands.len() > MAX_LIVE_COMMANDS {
            commands.pop_front();
        }
        drop(commands);
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// The command settled: its stored item has the output now.
    pub(crate) fn finish(&self, thread_id: &str, item_id: &str) {
        lock(&self.commands).retain(|c| c.thread_id != thread_id || c.item_id != item_id);
    }

    /// The thread's run ended or its session closed.
    pub(crate) fn finish_thread(&self, thread_id: &str) {
        lock(&self.commands).retain(|c| c.thread_id != thread_id);
    }

    pub(crate) fn get(&self, thread_id: &str, item_id: &str) -> Option<LiveTail> {
        lock(&self.commands)
            .iter()
            .find(|c| c.thread_id == thread_id && c.item_id == item_id)
            .map(|c| LiveTail {
                generation: c.generation,
                total: c.total,
                text: c.tail.clone(),
                truncated: c.truncated,
            })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        lock(&self.commands).len()
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
}

/// The frame that brings a subscriber from `seen` to `live`: the new bytes when they are few
/// and still in the tail, otherwise the whole tail.
fn live_frame(seen: Option<(u64, u64)>, live: &LiveTail) -> Option<Value> {
    if let Some((generation, total)) = seen
        && generation == live.generation
        && total <= live.total
    {
        let new = usize::try_from(live.total - total).unwrap_or(usize::MAX);
        if new == 0 {
            return None;
        }
        if new <= MAX_APPEND_BYTES
            && let Some(text) = live
                .text
                .len()
                .checked_sub(new)
                .and_then(|at| live.text.get(at..))
        {
            return Some(
                json!({"kind": "append", "text": text, "truncated": live.truncated, "running": true}),
            );
        }
    }
    Some(
        json!({"kind": "replace", "text": live.text, "truncated": live.truncated, "running": true}),
    )
}

type Frames = mpsc::Sender<Result<Value, Value>>;

pub(crate) async fn spawn(
    inner: Arc<Inner>,
    input: Value,
    tx: Frames,
) -> Result<(), EngineError<Value>> {
    let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
    let item_id = input["itemId"].as_str().unwrap_or_default().to_owned();
    let error = |message: &str| json!({"_tag": "OrchestrationV2CommandOutputError", "threadId": thread_id, "message": message});
    let mut wake = inner.notify.subscribe();
    let read = {
        let inner = inner.clone();
        let (thread_id, item_id) = (thread_id.clone(), item_id.clone());
        move || {
            let inner = inner.clone();
            let (thread_id, item_id) = (thread_id.clone(), item_id.clone());
            async move { inner.db(move |s| s.turn_item(&thread_id, &item_id)).await }
        }
    };
    let item = read().await.map_err(EngineError::Internal)?;
    let Some(item) = item.filter(|i| i["type"] == "command_execution") else {
        return Err(EngineError::Rejected(error("No such command.")));
    };
    let mut live_wake = inner.command_output.subscribe();
    tokio::spawn(async move {
        // Bytes of the stored output sent, or the hub entry and total sent.
        let mut sent: Option<usize> = None;
        let mut seen_live: Option<(u64, u64)> = None;
        let mut last_frame: Option<tokio::time::Instant> = None;
        let mut item = item;
        loop {
            let output = item["output"].as_str().unwrap_or_default();
            let running = matches!(
                item["status"].as_str(),
                Some("running" | "pending" | "waiting")
            );
            let live = running
                .then(|| inner.command_output.get(&thread_id, &item_id))
                .flatten();
            let frame = if let Some(live) = &live {
                let frame = live_frame(seen_live, live);
                seen_live = Some((live.generation, live.total));
                frame
            } else if seen_live.is_some() && !running {
                // A command that streamed ends on its stored output, as upstream.
                let (text, truncated) = tail(output);
                Some(
                    json!({"kind": "replace", "text": text, "truncated": truncated, "running": false}),
                )
            } else {
                match sent {
                    Some(len)
                        if output.len() >= len
                            && output.len() - len <= MAX_FRAME_BYTES
                            && output.get(len..).is_some() =>
                    {
                        (output.len() > len || !running).then(|| {
                            json!({"kind": "append", "text": output.get(len..).unwrap_or_default(), "truncated": false, "running": running})
                        })
                    }
                    _ => {
                        let (text, truncated) = tail(output);
                        Some(json!({"kind": "replace", "text": text, "truncated": truncated, "running": running}))
                    }
                }
            };
            if let Some(frame) = frame {
                // Live output comes in bursts; frames go out at most every 100 ms.
                if running && let Some(at) = last_frame {
                    tokio::time::sleep_until(at + FRAME_INTERVAL).await;
                }
                if tx.send(Ok(frame)).await.is_err() {
                    return;
                }
                last_frame = Some(tokio::time::Instant::now());
            }
            if !running {
                return;
            }
            sent = Some(output.len());
            tokio::select! {
                _ = tx.closed() => return,
                changed = live_wake.changed() => {
                    if changed.is_err() { return }
                    // Only the hub moved; the stored item did not.
                    continue;
                }
                changed = wake.changed() => if changed.is_err() { return },
            }
            match read().await {
                Ok(Some(next)) => item = next,
                Ok(None) => return,
                Err(e) => {
                    let _ = tx
                        .send(Err(json!({"_tag": "OrchestrationV2CommandOutputError",
                        "threadId": item["threadId"], "message": e})))
                        .await;
                    return;
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hub_keeps_a_bounded_tail_per_command_and_few_commands() {
        let hub = CommandOutputHub::default();
        // 1 MiB of output in 4 KiB chunks, some multi-byte, keeps only a 64 KiB tail.
        let chunk = "é".repeat(2048);
        for _ in 0..256 {
            hub.append("t", "i", &chunk);
        }
        let live = hub.get("t", "i").unwrap();
        assert!(live.text.len() <= MAX_FRAME_BYTES);
        assert!(live.text.len() > MAX_FRAME_BYTES - 4);
        assert!(live.truncated);
        assert_eq!(live.total, 256 * chunk.len() as u64);
        let capacity = lock(&hub.commands)[0].tail.capacity();
        assert!(capacity <= 2 * MAX_FRAME_BYTES, "buffer {capacity}");
        // One chunk larger than the tail keeps its end.
        hub.append("t", "big", &"x".repeat(200_000));
        assert_eq!(hub.get("t", "big").unwrap().text.len(), MAX_FRAME_BYTES);

        for n in 0..20 {
            hub.append("t", &format!("c{n}"), "x");
        }
        assert_eq!(hub.len(), MAX_LIVE_COMMANDS);
        assert!(
            hub.get("t", "c0").is_none(),
            "the least recently written goes"
        );
        assert!(hub.get("t", "c19").is_some());
        hub.finish("t", "c19");
        assert!(hub.get("t", "c19").is_none());
        hub.finish_thread("t");
        assert_eq!(hub.len(), 0);
    }

    #[test]
    fn a_subscriber_gets_appends_until_it_falls_behind() {
        let hub = CommandOutputHub::default();
        hub.append("t", "i", "one\n");
        let first = hub.get("t", "i").unwrap();
        assert_eq!(live_frame(None, &first).unwrap()["kind"], "replace");
        let seen = Some((first.generation, first.total));
        assert_eq!(live_frame(seen, &first), None);
        hub.append("t", "i", "two\n");
        let second = hub.get("t", "i").unwrap();
        assert_eq!(
            live_frame(seen, &second).unwrap(),
            json!({"kind": "append", "text": "two\n", "truncated": false, "running": true})
        );
        hub.append("t", "i", &"z".repeat(MAX_APPEND_BYTES + 1));
        let third = hub.get("t", "i").unwrap();
        let behind = Some((second.generation, second.total));
        assert_eq!(live_frame(behind, &third).unwrap()["kind"], "replace");
        // An evicted entry that comes back is new: the subscriber gets the tail again.
        hub.finish("t", "i");
        hub.append("t", "i", "again");
        let fresh = hub.get("t", "i").unwrap();
        assert_eq!(
            live_frame(Some((third.generation, 0)), &fresh).unwrap()["kind"],
            "replace"
        );
    }
}
