//! Secret card transitions (`Orchestrator.dispatchSecretRequestRecord`); values never enter events.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::commands::{CommandError, Outcome, live_thread, reject};
use crate::store::{Draft, StoreResult, Tx};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    command_id: String,
    thread_id: String,
    run_id: String,
    node_id: String,
    turn_item_id: String,
    label: String,
    reason: String,
    url: Option<String>,
    placeholder: Option<String>,
    delivery: Option<String>,
    secret_status: conn_contract::OrchestrationV2SecretRequestStatus,
}

pub(crate) fn record(tx: &mut Tx<'_>, input: Value) -> Outcome {
    let c: Record = serde_json::from_value(input)
        .map_err(|_| CommandError::Rejected("Invalid secret request.".into()))?;
    let thread = live_thread(tx, &c.thread_id)?;
    let run = tx.entity(&c.thread_id, "runs", &c.run_id)?;
    let Some(run) = run.filter(|r| r.get("rootNodeId").and_then(Value::as_str) == Some(&c.node_id))
    else {
        return reject(format!(
            "Node {} is not the root of run {}.",
            c.node_id, c.run_id
        ));
    };
    let existing = tx.entity(&c.thread_id, "turnItems", &c.turn_item_id)?;
    if let Some(item) = &existing {
        if item.get("type").and_then(Value::as_str) != Some("secret_request") {
            return reject(format!(
                "Turn item {} is not a secret request.",
                c.turn_item_id
            ));
        }
        if item.get("runId").and_then(Value::as_str) != Some(&c.run_id) {
            return reject(format!(
                "Secret request {} belongs to another run.",
                c.turn_item_id
            ));
        }
    }
    let state = conn_contract::to_json(&c.secret_status);
    let unchanged = existing
        .as_ref()
        .is_some_and(|i| i.get("secretStatus") != Some(&json!("pending")) || state == "pending");
    let item = if unchanged {
        existing.unwrap_or(Value::Null)
    } else {
        let provider_turn = match run.get("activeAttemptId").and_then(Value::as_str) {
            Some(attempt_id) => tx
                .entities_where(&c.thread_id, "providerTurns", "runAttemptId", attempt_id)?
                .into_iter()
                .max_by_key(|t| t.get("ordinal").and_then(Value::as_i64).unwrap_or_default())
                .and_then(|t| t.get("id").cloned())
                .or(tx
                    .entity(&c.thread_id, "attempts", attempt_id)?
                    .and_then(|a| a.get("providerTurnId").cloned())),
            None => None,
        };
        let now = tx.now();
        let pending = state == "pending";
        let mut item = json!({
            "id": c.turn_item_id, "threadId": c.thread_id, "runId": c.run_id, "nodeId": c.node_id,
            "providerThreadId": run.get("providerThreadId"), "providerTurnId": provider_turn,
            "nativeItemRef": null, "parentItemId": null, "ordinal": 0,
            "status": if pending {"waiting"} else if state == "saved" {"completed"} else {"cancelled"},
            "title": c.label, "startedAt": existing.as_ref().and_then(|i| i.get("startedAt")).cloned().unwrap_or(json!(now)),
            "completedAt": if pending {Value::Null} else {json!(now)}, "updatedAt": now,
            "type": "secret_request", "label": c.label, "reason": c.reason, "secretStatus": state
        });
        if let Some(fields) = item.as_object_mut() {
            for (key, value) in [
                ("url", c.url),
                ("placeholder", c.placeholder),
                ("delivery", c.delivery),
            ] {
                if let Some(value) = value {
                    fields.insert(key.into(), json!(value));
                }
            }
        }
        if state == "saved" && thread.get("snoozedUntil").is_some_and(|v| !v.is_null()) {
            let mut thread = thread;
            if let Some(fields) = thread.as_object_mut() {
                fields.insert("snoozedUntil".into(), Value::Null);
                fields.insert("snoozedAt".into(), Value::Null);
                fields.insert("updatedAt".into(), json!(now));
            }
            tx.append(
                Draft::new(&c.thread_id, "thread.unsnoozed", thread)
                    .command(Some(&c.command_id))
                    .payload_instance(),
            )?;
        }
        item
    };
    tx.append(
        Draft::new(&c.thread_id, "turn-item.updated", item)
            .run(Some(&c.run_id))
            .node(Some(&c.node_id))
            .command(Some(&c.command_id)),
    )?;
    Ok(vec![])
}

pub(crate) fn cancel_pending(tx: &mut Tx<'_>, thread: &str, run: &str) -> StoreResult<()> {
    for mut item in tx.entities_where(thread, "turnItems", "runId", run)? {
        if item.get("type").and_then(Value::as_str) == Some("secret_request")
            && item.get("secretStatus").and_then(Value::as_str) == Some("pending")
        {
            let now = tx.now().to_owned();
            if let Some(fields) = item.as_object_mut() {
                fields.insert("secretStatus".into(), json!("cancelled"));
                fields.insert("status".into(), json!("cancelled"));
                fields.insert("completedAt".into(), json!(now));
                fields.insert("updatedAt".into(), json!(now));
            }
            tx.append(Draft::new(thread, "turn-item.updated", item).run(Some(run)))?;
        }
    }
    Ok(())
}
