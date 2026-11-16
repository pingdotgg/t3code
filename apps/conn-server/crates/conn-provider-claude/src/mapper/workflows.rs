//! Claude workflow snapshots (`claudeWorkflowProgress.ts`), with bounded member telemetry.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const MAX_MEMBERS: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn count(value: &Value) -> Option<Value> {
    value
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .map(|n| json!(n))
}
fn text(value: &Value) -> Option<Value> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
}
fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}

pub(super) fn has_snapshot(frame: &Value) -> bool {
    frame["workflow_progress"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
}

pub(super) fn handles(value: &Value) -> Option<Value> {
    if value["taskType"] != "local_workflow" {
        return None;
    }
    let mut map = Map::new();
    for key in ["runId", "transcriptDir", "scriptPath"] {
        put(&mut map, key, text(&value[key]));
    }
    (!map.is_empty()).then_some(Value::Object(map))
}

fn epoch_ms(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= 8_640_000_000_000_000)
}

fn agent(entry: &Value) -> Option<Value> {
    let mut map = Map::new();
    map.insert("index".into(), count(&entry["index"])?);
    map.insert("label".into(), text(&entry["label"])?);
    let started = epoch_ms(&entry["startedAt"]);
    let state = match entry["state"].as_str() {
        Some("queued") => "queued",
        Some("start") if started.is_none() => "queued",
        Some("done") => "completed",
        Some("error") => "failed",
        _ => "running",
    };
    map.insert("state".into(), json!(state));
    for key in ["agentId", "phaseTitle", "model"] {
        put(&mut map, key, text(&entry[key]));
    }
    for key in ["phaseIndex", "attempt", "toolCalls", "durationMs"] {
        put(&mut map, key, count(&entry[key]));
    }
    put(&mut map, "totalTokens", count(&entry["tokens"]));
    for (dest, source) in [("prompt", "promptPreview"), ("result", "resultPreview")] {
        put(
            &mut map,
            dest,
            entry[source]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| json!(s)),
        );
    }
    put(&mut map, "startedAt", started.map(|n| json!(n)));
    put(
        &mut map,
        "queuedAt",
        epoch_ms(&entry["queuedAt"]).map(|n| json!(n)),
    );
    if matches!(state, "completed" | "failed") {
        put(
            &mut map,
            "completedAt",
            epoch_ms(&entry["lastProgressAt"]).map(|n| json!(n)),
        );
    }
    Some(Value::Object(map))
}

pub(super) fn merge(
    previous: Option<&Value>,
    name: Option<&str>,
    handles: Option<&Value>,
    frame: &Value,
    coordinator: &str,
) -> Option<Value> {
    let mut phases = BTreeMap::new();
    let mut agents = BTreeMap::new();
    for (key, table) in [("phases", &mut phases), ("agents", &mut agents)] {
        for value in previous
            .and_then(|p| p[key].as_array())
            .into_iter()
            .flatten()
            .take(MAX_MEMBERS)
        {
            if let Some(index) = value["index"].as_u64() {
                table.insert(index, value.clone());
            }
        }
    }
    let mut evidence = false;
    for entry in frame["workflow_progress"].as_array().into_iter().flatten() {
        match entry["type"].as_str() {
            Some("workflow_phase") => {
                if let (Some(index), Some(title)) = (
                    count(&entry["index"]).and_then(|n| n.as_u64()),
                    text(&entry["title"]),
                ) {
                    evidence = true;
                    if phases.contains_key(&index) || phases.len() < MAX_MEMBERS {
                        phases.insert(index, json!({"index":index,"title":title}));
                    }
                }
            }
            Some("workflow_agent") => {
                if let Some(mut next) = agent(entry) {
                    let index = next["index"].as_u64()?;
                    evidence = true;
                    if let Some(prior) = agents.get(&index) {
                        let attempt = next["attempt"]
                            .as_u64()
                            .or_else(|| prior["attempt"].as_u64())
                            .unwrap_or(1);
                        let prior_attempt = prior["attempt"].as_u64().unwrap_or(1);
                        if attempt < prior_attempt {
                            continue;
                        }
                        let restarted = attempt > prior_attempt;
                        let regressed = !restarted
                            && (matches!(prior["state"].as_str(), Some("completed" | "failed"))
                                && next["state"] != prior["state"]
                                || prior["state"] == "running" && next["state"] == "queued");
                        let mut combined = if restarted {
                            let mut p = Map::new();
                            for key in ["phaseIndex", "phaseTitle"] {
                                if let Some(v) = prior.get(key) {
                                    p.insert(key.into(), v.clone());
                                }
                            }
                            p
                        } else {
                            prior.as_object().cloned().unwrap_or_default()
                        };
                        if let Some(map) = next.as_object() {
                            combined.extend(map.clone());
                        }
                        if regressed && let Some(map) = prior.as_object() {
                            combined.extend(map.clone());
                        }
                        next = Value::Object(combined);
                    }
                    next["childThreadId"] = json!(super::subagent_thread_id(&format!(
                        "{coordinator}:agent:{index}"
                    )));
                    if agents.contains_key(&index) || agents.len() < MAX_MEMBERS {
                        agents.insert(index, next);
                    }
                }
            }
            _ => {}
        }
    }
    if previous.is_none() && name.is_none() && handles.is_none() && !evidence {
        return None;
    }
    let mut result = previous
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    put(&mut result, "name", name.map(|n| json!(n)));
    if let Some(handles) = handles.and_then(Value::as_object) {
        let mut all = result
            .get("runHandles")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        all.extend(handles.clone());
        result.insert("runHandles".into(), Value::Object(all));
    }
    result.insert(
        "phases".into(),
        json!(phases.into_values().collect::<Vec<_>>()),
    );
    result.insert(
        "agents".into(),
        json!(agents.into_values().collect::<Vec<_>>()),
    );
    for (dest, source) in [
        ("totalTokens", "total_tokens"),
        ("toolCalls", "tool_uses"),
        ("durationMs", "duration_ms"),
    ] {
        put(&mut result, dest, count(&frame["usage"][source]));
    }
    Some(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn update(previous: Option<&Value>, entry: Value) -> Value {
        merge(
            previous,
            None,
            None,
            &json!({"workflow_progress":[entry]}),
            "coordinator",
        )
        .unwrap()
    }
    #[test]
    fn snapshots_keep_terminal_members_until_a_new_attempt_and_ignore_old_attempts() {
        assert!(merge(None, None, None, &json!({"usage":{"total_tokens":2}}), "c").is_none());
        let queued = update(
            None,
            json!({"type":"workflow_agent","index":0,"label":" A ","state":"start","attempt":1,"phaseIndex":2}),
        );
        assert_eq!(queued["agents"][0]["state"], "queued");
        let done = update(
            Some(&queued),
            json!({"type":"workflow_agent","index":0,"label":"A","state":"done","attempt":1,"resultPreview":"answer","tokens":5}),
        );
        let late = update(
            Some(&done),
            json!({"type":"workflow_agent","index":0,"label":"late","state":"start","attempt":1}),
        );
        assert_eq!(late, done);
        let retry = update(
            Some(&done),
            json!({"type":"workflow_agent","index":0,"label":"retry","state":"start","attempt":2,"startedAt":10}),
        );
        assert_eq!(retry["agents"][0]["state"], "running");
        assert_eq!(retry["agents"][0]["phaseIndex"], 2);
        assert!(retry["agents"][0].get("result").is_none());
        assert!(retry["agents"][0].get("totalTokens").is_none());
        let stale = update(
            Some(&retry),
            json!({"type":"workflow_agent","index":0,"label":"old","state":"done","attempt":1}),
        );
        assert_eq!(stale, retry);
    }
    #[test]
    fn invalid_telemetry_is_ignored_and_member_history_is_bounded() {
        for entry in [
            json!({"type":"workflow_phase","index":-1,"title":"x"}),
            json!({"type":"workflow_agent","index":1.5,"label":"x"}),
            json!({"type":"workflow_agent","index":1,"label":" "}),
        ] {
            assert!(merge(None, None, None, &json!({"workflow_progress":[entry]}), "c").is_none());
        }
        let entries:Vec<_>=(0..MAX_MEMBERS+10).rev().map(|i|json!({"type":"workflow_agent","index":i,"label":"a","state":"start","startedAt":-1})).collect();
        let result = merge(None, None, None, &json!({"workflow_progress":entries}), "c").unwrap();
        let members = result["agents"].as_array().unwrap();
        assert_eq!(members.len(), MAX_MEMBERS);
        assert!(
            members
                .windows(2)
                .all(|w| w[0]["index"].as_u64() < w[1]["index"].as_u64())
        );
        assert!(members.iter().all(|v| v["state"] == "queued"));
    }
}
