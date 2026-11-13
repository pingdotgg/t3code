//! `orchestration.subscribeCommandOutput`: the output of one `command_execution` turn item as
//! `replace` and `append` frames, until the command stops running.
//!
//! It follows the stored item, not a live provider pipe: a frame goes out when the provider
//! writes the item. The task keeps only how many bytes it sent: output only grows, and a
//! shorter one is sent whole again.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::EngineError;
use crate::engine::Inner;

/// Frames carry at most the last 64 KiB of output, as the client panel shows a tail.
const MAX_FRAME_BYTES: usize = 64 * 1024;

fn tail(text: &str) -> (&str, bool) {
    if text.len() <= MAX_FRAME_BYTES {
        return (text, false);
    }
    let mut start = text.len() - MAX_FRAME_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
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
    tokio::spawn(async move {
        let mut sent: Option<usize> = None;
        let mut item = item;
        loop {
            let output = item["output"].as_str().unwrap_or_default();
            let running = matches!(
                item["status"].as_str(),
                Some("running" | "pending" | "waiting")
            );
            let frame = match sent {
                Some(len)
                    if output.len() >= len
                        && output.is_char_boundary(len)
                        && output.len() - len <= MAX_FRAME_BYTES =>
                {
                    (output.len() > len || !running).then(|| {
                        json!({"kind": "append", "text": &output[len..], "truncated": false, "running": running})
                    })
                }
                _ => {
                    let (text, truncated) = tail(output);
                    Some(json!({"kind": "replace", "text": text, "truncated": truncated, "running": running}))
                }
            };
            if let Some(frame) = frame
                && tx.send(Ok(frame)).await.is_err()
            {
                return;
            }
            if !running {
                return;
            }
            sent = Some(output.len());
            tokio::select! {
                _ = tx.closed() => return,
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
