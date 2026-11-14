//! An in-memory agent that replays a T3 test kit transcript: the logic of the T3 server's
//! `apps/server/scripts/acp-replay-agent.ts`, kept rule for rule so a frame passes here when
//! it passes there. `tools/t3-replay.mjs` runs the T3 script itself against our session to
//! show that the two agree.
//!
//! - `emit_inbound` entries are sent until the next `expect_outbound`; requests get ids
//!   1, 2, … and replies take the id of our pending request with the same method.
//! - Each frame we write must match the next `expect_outbound` frame with T3's
//!   `matchesExpected`: `"<any>"` matches anything, `<workspace>` is the replay folder,
//!   `<any>` inside a string matches any text, object key sets must be equal.
//! - A `runtime_exit` ends this agent; a respawned one continues after it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conn_provider_support::lines::Line;
use conn_provider_support::process::{ExitInfo, ProcEvent};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

/// The state shared by the agents of one transcript (one per process).
#[derive(Debug)]
pub(crate) struct Script {
    pub entries: Vec<Value>,
    pub workspace: String,
    pub cursor: usize,
    pub failure: Option<String>,
    /// Every frame we wrote, as parsed JSON, for the stub comparison and for debugging.
    pub written: Vec<Value>,
    pub processes: usize,
}

impl Script {
    pub(crate) fn new(entries: Vec<Value>, workspace: &str) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            entries,
            workspace: workspace.to_owned(),
            cursor: 0,
            failure: None,
            written: Vec::new(),
            processes: 0,
        }))
    }

    pub(crate) fn complete(&self) -> bool {
        self.failure.is_none() && self.cursor >= self.entries.len()
    }
}

/// Starts one agent process. Returns its stdin and its stdout events, as `Process` gives them.
pub(crate) fn spawn(
    script: Arc<Mutex<Script>>,
) -> (mpsc::Sender<String>, mpsc::Receiver<ProcEvent>) {
    let (stdin, mut lines) = mpsc::channel::<String>(64);
    let (events, events_rx) = mpsc::channel::<ProcEvent>(1024);
    crate::lock(&script).processes += 1;
    tokio::spawn(async move {
        let mut agent = Agent {
            script,
            next_agent_request_id: 1,
            pending_client_requests: HashMap::new(),
            pending_agent_requests: HashMap::new(),
        };
        let mut open = agent.flush(&events).await;
        while open {
            let Some(line) = lines.recv().await else {
                break;
            };
            open = agent.handle(&line, &events).await;
        }
        // Our side closed stdin, or the transcript ended this process.
        let _ = events
            .send(ProcEvent::Exited(ExitInfo {
                code: Some(0),
                signal: None,
                stderr_tail: String::new(),
            }))
            .await;
    });
    (stdin, events_rx)
}

struct Agent {
    script: Arc<Mutex<Script>>,
    next_agent_request_id: i64,
    pending_client_requests: HashMap<String, Value>,
    pending_agent_requests: HashMap<String, String>,
}

impl Agent {
    /// Sends inbound entries up to the next expectation. `false` when this process ends.
    async fn flush(&mut self, events: &mpsc::Sender<ProcEvent>) -> bool {
        let mut out = Vec::new();
        let mut alive = true;
        {
            let mut script = crate::lock(&self.script);
            loop {
                if script.failure.is_some() {
                    alive = false;
                    break;
                }
                let Some(entry) = script.entries.get(script.cursor).cloned() else {
                    break;
                };
                match entry["type"].as_str() {
                    Some("expect_outbound") => break,
                    Some("runtime_exit") => {
                        let status = entry["status"].as_str().unwrap_or("");
                        if status != "success" && status != "cancelled" {
                            script.failure = Some(format!("recorded runtime exit was {status}"));
                            alive = false;
                            break;
                        }
                        script.cursor += 1;
                        if script.cursor < script.entries.len() {
                            alive = false;
                            break;
                        }
                    }
                    _ => {
                        let workspace = script.workspace.clone();
                        let frame = materialize(&entry["frame"], &workspace);
                        match inbound(
                            &mut self.next_agent_request_id,
                            &mut self.pending_client_requests,
                            &mut self.pending_agent_requests,
                            &frame,
                        ) {
                            Ok(message) => out.push(message),
                            Err(detail) => {
                                script.failure = Some(detail);
                                alive = false;
                                break;
                            }
                        }
                        script.cursor += 1;
                    }
                }
            }
        }
        for message in out {
            let _ = events
                .send(ProcEvent::Line(Line::Text(message.to_string())))
                .await;
        }
        alive
    }
}

fn inbound(
    next_agent_request_id: &mut i64,
    pending_client_requests: &mut HashMap<String, Value>,
    pending_agent_requests: &mut HashMap<String, String>,
    frame: &Value,
) -> Result<Value, String> {
    {
        let method = frame["method"]
            .as_str()
            .ok_or("inbound frame without method")?;
        let mut message = Map::new();
        message.insert("jsonrpc".into(), json!("2.0"));
        match frame["kind"].as_str() {
            Some("notification") => {
                message.insert("method".into(), json!(method));
                if let Some(params) = frame.get("params") {
                    message.insert("params".into(), params.clone());
                }
            }
            Some("request") => {
                let id = *next_agent_request_id;
                *next_agent_request_id += 1;
                pending_agent_requests.insert(id.to_string(), method.to_owned());
                message.insert("id".into(), json!(id));
                message.insert("method".into(), json!(method));
                if let Some(params) = frame.get("params") {
                    message.insert("params".into(), params.clone());
                }
                message.insert("headers".into(), json!([]));
            }
            Some("response") => {
                let id = pending_client_requests
                    .remove(method)
                    .ok_or_else(|| format!("no pending client request for {method}"))?;
                message.insert("id".into(), id);
                if let Some(result) = frame.get("result") {
                    message.insert("result".into(), result.clone());
                }
                if let Some(error) = frame.get("error") {
                    message.insert("error".into(), error.clone());
                }
            }
            _ => return Err("invalid emit_inbound logical ACP frame".into()),
        }
        Ok(Value::Object(message))
    }
}

impl Agent {
    async fn handle(&mut self, line: &str, events: &mpsc::Sender<ProcEvent>) -> bool {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            crate::lock(&self.script).failure = Some(format!("not JSON: {line}"));
            return false;
        };
        let actual = self.logical(&message);
        {
            let mut script = crate::lock(&self.script);
            script.written.push(message.clone());
            if script.failure.is_some() {
                return false;
            }
            let Some(actual) = actual else {
                script.failure = Some(format!("could not identify outbound frame {message}"));
                return false;
            };
            let workspace = script.workspace.clone();
            let entry = script
                .entries
                .get(script.cursor)
                .cloned()
                .unwrap_or(Value::Null);
            if entry["type"] != "expect_outbound"
                || !matches_expected(&entry["frame"], &actual, &workspace)
            {
                script.failure = Some(format!(
                    "unexpected outbound frame at entry {}:\n  expected {}\n  actual   {}",
                    script.cursor, entry, actual
                ));
                return false;
            }
            let id = message.get("id").filter(|id| !id.is_null()).cloned();
            match (actual["kind"].as_str(), id) {
                (Some("request"), Some(id)) => {
                    let method = actual["method"].as_str().unwrap_or("").to_owned();
                    self.pending_client_requests.insert(method, id);
                }
                (Some("response"), Some(id)) => {
                    self.pending_agent_requests.remove(&id_key(&id));
                }
                _ => {}
            }
            script.cursor += 1;
        }
        self.flush(events).await
    }

    fn logical(&self, message: &Value) -> Option<Value> {
        let id = message
            .get("id")
            .filter(|id| !id.is_null() && **id != json!(""));
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let mut frame = Map::new();
            frame.insert(
                "kind".into(),
                json!(if id.is_some() {
                    "request"
                } else {
                    "notification"
                }),
            );
            frame.insert("method".into(), json!(method));
            if let Some(params) = message.get("params") {
                frame.insert("params".into(), params.clone());
            }
            return Some(Value::Object(frame));
        }
        let method = self.pending_agent_requests.get(&id_key(id?))?;
        let mut frame = Map::new();
        frame.insert("kind".into(), json!("response"));
        frame.insert("method".into(), json!(method));
        if let Some(result) = message.get("result") {
            frame.insert("result".into(), result.clone());
        }
        if let Some(error) = message.get("error") {
            frame.insert("error".into(), error.clone());
        }
        Some(Value::Object(frame))
    }
}

fn id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn materialize(value: &Value, workspace: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<workspace>", workspace)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| materialize(v, workspace)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), materialize(v, workspace)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// T3's `matchesExpected`.
pub(crate) fn matches_expected(expected: &Value, actual: &Value, workspace: &str) -> bool {
    if expected == "<any>" {
        return true;
    }
    match (expected, actual) {
        (Value::String(expected), Value::String(actual)) => {
            let expanded = expected.replace("<workspace>", workspace);
            if !expanded.contains("<any>") {
                return expanded == *actual;
            }
            let mut offset = 0;
            for part in expanded.split("<any>") {
                match actual.get(offset..).and_then(|rest| rest.find(part)) {
                    Some(at) => offset += at + part.len(),
                    None => return false,
                }
            }
            true
        }
        (Value::Array(expected), Value::Array(actual)) => {
            expected.len() == actual.len()
                && expected
                    .iter()
                    .zip(actual)
                    .all(|(e, a)| matches_expected(e, a, workspace))
        }
        (Value::Object(expected), Value::Object(actual)) => {
            let mut expected_keys: Vec<&String> = expected.keys().collect();
            let mut actual_keys: Vec<&String> = actual.keys().collect();
            expected_keys.sort();
            actual_keys.sort();
            expected_keys == actual_keys
                && expected.iter().all(|(k, e)| {
                    actual
                        .get(k)
                        .is_some_and(|a| matches_expected(e, a, workspace))
                })
        }
        (Value::Object(_) | Value::Array(_), _) => false,
        // `Object.is`: numbers compare by value.
        (Value::Number(e), Value::Number(a)) => e.as_f64() == a.as_f64(),
        (e, a) => e == a,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_like_the_t3_replay_agent() {
        let ws = "/w";
        assert!(
            matches_expected(&json!("<any>"), &json!({"x": 1}), ws),
            "any"
        );
        assert!(
            matches_expected(&json!("<workspace>/a"), &json!("/w/a"), ws),
            "workspace"
        );
        assert!(
            matches_expected(&json!("a<any>c<any>e"), &json!("abcde"), ws),
            "inline any"
        );
        assert!(
            !matches_expected(&json!("a<any>c"), &json!("ab"), ws),
            "inline any order"
        );
        assert!(
            !matches_expected(&json!({"a": 1}), &json!({"a": 1, "b": 2}), ws),
            "extra key"
        );
        assert!(
            matches_expected(&json!({"a": [1, "<any>"]}), &json!({"a": [1, 2]}), ws),
            "nested"
        );
        assert!(
            !matches_expected(&json!([1]), &json!([1, 2]), ws),
            "array length"
        );
    }
}
