//! Deterministic synthetic thread snapshots for latency benchmarks (feature `testkit`).
//!
//! Builds `orchestration.subscribeThread` snapshot items shaped exactly like `conn-server`
//! sends them to a client that opted into `acceptDedupedBodies` + `acceptCompactTurnItems`:
//! every local row lives in `visibleTurnItems`, `turnItems` is empty
//! (`turnItemsOmitLocalVisible`), and user/assistant texts are blanked (`textOmitted`) and
//! restored from `messages`. Item templates come from a recorded `conn-server` session, so the
//! payload decodes through the real `conn-contract` types.

use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../tests/fixtures/thread_permission_stream.json");

/// Size knobs for [`synthetic_thread_snapshot_json`].
#[derive(Clone, Copy, Debug)]
pub struct SyntheticThread {
    /// User turns in the thread.
    pub turns: usize,
    /// Command tool calls per turn.
    pub commands_per_turn: usize,
    /// Bytes of output per command tool call.
    pub command_output_bytes: usize,
    /// Bytes of assistant Markdown per turn.
    pub assistant_bytes: usize,
}

impl SyntheticThread {
    /// A thread whose snapshot JSON is roughly `target_bytes` long.
    #[must_use]
    pub fn sized(target_bytes: usize) -> Self {
        // One turn is about 4 KiB of envelope plus its bodies (measured from the templates).
        let per_turn = 4 * 1024 + 3 * 1024 + 1500;
        Self {
            turns: (target_bytes / per_turn).max(1),
            commands_per_turn: 3,
            command_output_bytes: 1024,
            assistant_bytes: 1500,
        }
    }
}

fn filler(len: usize, seed: usize) -> String {
    const WORDS: [&str; 8] = [
        "alpha ",
        "bravo\n",
        "`code` ",
        "**bold** ",
        "- item\n",
        "delta ",
        "echo ",
        "fox ",
    ];
    let mut out = String::with_capacity(len + 16);
    let mut i = seed;
    while out.len() < len {
        out.push_str(WORDS[i % WORDS.len()]);
        i = i.wrapping_add(7);
    }
    out
}

struct Templates {
    snapshot: Value,
    user_row: Value,
    user_message: Value,
    assistant_item: Value,
    assistant_message: Value,
    command_item: Value,
}

fn templates() -> Templates {
    let stream: Vec<Value> = serde_json::from_str(FIXTURE).unwrap_or_default();
    let snapshot = stream.first().cloned().unwrap_or(Value::Null);
    let user_row = snapshot["projection"]["visibleTurnItems"][0].clone();
    let user_message = snapshot["projection"]["messages"][0].clone();
    let mut assistant_item = Value::Null;
    let mut assistant_message = Value::Null;
    let mut command_item = Value::Null;
    for item in &stream {
        let event = &item["event"];
        let payload = &event["payload"];
        match (event["type"].as_str(), payload["type"].as_str()) {
            (Some("turn-item.updated"), Some("assistant_message")) => {
                assistant_item = payload.clone();
            }
            (Some("turn-item.updated"), Some("command_execution"))
                if payload["status"] == "completed" =>
            {
                command_item = payload.clone();
            }
            (Some("message.updated"), _) if payload["role"] == "assistant" => {
                assistant_message = payload.clone();
            }
            _ => {}
        }
    }
    Templates {
        snapshot,
        user_row,
        user_message,
        assistant_item,
        assistant_message,
        command_item,
    }
}

/// Builds one `{"kind":"snapshot",...}` thread stream item as JSON text.
#[must_use]
pub fn synthetic_thread_snapshot_json(spec: SyntheticThread) -> String {
    let t = templates();
    let mut rows = Vec::new();
    let mut messages = Vec::new();
    let mut position = 0_i64;
    let mut ordinal = 1_000_000_i64;
    let mut push_row = |rows: &mut Vec<Value>, item: Value| {
        let mut row = t.user_row.clone();
        row["sourceItemId"] = item["id"].clone();
        row["item"] = item;
        row["position"] = json!(position);
        position += 1;
        rows.push(row);
    };
    for turn in 0..spec.turns {
        ordinal += 1;
        let user_msg_id = format!("user-msg-{turn}");
        let mut user_msg = t.user_message.clone();
        user_msg["id"] = json!(user_msg_id);
        user_msg["text"] = json!(format!("Turn {turn}: {}", filler(200, turn)));
        messages.push(user_msg);
        let mut user_item = t.user_row["item"].clone();
        user_item["id"] = json!(format!("turn-item:user-{turn}"));
        user_item["messageId"] = json!(user_msg_id);
        user_item["ordinal"] = json!(ordinal);
        push_row(&mut rows, user_item);

        for cmd in 0..spec.commands_per_turn {
            ordinal += 1;
            let mut item = t.command_item.clone();
            item["id"] = json!(format!("turn-item:cmd-{turn}-{cmd}"));
            item["input"] = json!(format!("cargo test --workspace -- turn{turn} cmd{cmd}"));
            item["output"] = json!(filler(spec.command_output_bytes, turn + cmd));
            item["ordinal"] = json!(ordinal);
            push_row(&mut rows, item);
        }

        ordinal += 1;
        let assistant_msg_id = format!("assistant-msg-{turn}");
        let mut assistant_msg = t.assistant_message.clone();
        assistant_msg["id"] = json!(assistant_msg_id);
        assistant_msg["text"] = json!(filler(spec.assistant_bytes, turn * 3));
        messages.push(assistant_msg);
        let mut item = t.assistant_item.clone();
        item["id"] = json!(format!("turn-item:assistant-{turn}"));
        item["messageId"] = json!(assistant_msg_id);
        item["text"] = json!("");
        item["textOmitted"] = json!(true);
        item["ordinal"] = json!(ordinal);
        push_row(&mut rows, item);
    }

    let mut snapshot = t.snapshot;
    snapshot["projection"]["visibleTurnItems"] = Value::Array(rows);
    snapshot["projection"]["messages"] = Value::Array(messages);
    snapshot["projection"]["turnItems"] = json!([]);
    snapshot["turnItemsOmitLocalVisible"] = json!(true);
    snapshot.to_string()
}
