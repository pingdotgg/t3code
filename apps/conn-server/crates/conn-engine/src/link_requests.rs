//! Link cards (`Orchestrator.dispatchLinkRequestRecord`): an agent asks the user to link another
//! environment. The pairing code never enters an event; the card carries what was asked and how
//! it ended. The answer that closes a card wakes its agent with a notification message.

use serde_json::{Map, Value, json};

use crate::commands::{self, CommandError, Outcome, is_active, reject};
use crate::store::{Draft, StoreResult, Tx};

/// Command fields that never go on the card.
const NOT_ON_CARD: &[&str] = &[
    "type",
    "commandId",
    "turnItemId",
    "answeringTurnItemIds",
    "wake",
];

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `askedForLinkedMachine`: an older card the new link answers too.
fn asked_for_linked_machine(card: &Value, linked: &Value) -> bool {
    if card.get("requestedAccess") != linked.get("requestedAccess") {
        return false;
    }
    if let Some(environment) = text(card, "environmentId") {
        return Some(environment) == text(linked, "linkedEnvironmentId");
    }
    if let Some(url) = text(card, "url") {
        return text(linked, "url") == Some(url);
    }
    let normalize = |v: Option<&str>| v.map(|t| t.trim().to_lowercase()).unwrap_or_default();
    let hint = normalize(text(card, "hint"));
    !hint.is_empty()
        && hint == normalize(text(linked, "hint"))
        && hint == normalize(text(linked, "linkedLabel"))
}

pub(crate) fn record(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let (Some(command_id), Some(thread_id), Some(run_id), Some(node_id), Some(item_id)) = (
        text(&command, "commandId"),
        text(&command, "threadId"),
        text(&command, "runId"),
        text(&command, "nodeId"),
        text(&command, "turnItemId"),
    ) else {
        return reject("Invalid link request.");
    };
    let (command_id, thread_id, run_id, node_id, item_id) = (
        command_id.to_owned(),
        thread_id.to_owned(),
        run_id.to_owned(),
        node_id.to_owned(),
        item_id.to_owned(),
    );
    let Some(status) = text(&command, "linkStatus").map(str::to_owned) else {
        return reject("Invalid link request.");
    };
    if !matches!(
        status.as_str(),
        "pending" | "linked" | "declined" | "cancelled" | "failed"
    ) || text(&command, "reason").is_none()
    {
        return reject("Invalid link request.");
    }
    let Some(thread) = tx.thread(&thread_id)? else {
        return reject(format!("Thread {thread_id} was not found."));
    };
    let Some(run) = tx.entity(&thread_id, "runs", &run_id)? else {
        return reject(format!("Run {run_id} was not found."));
    };
    let existing = tx.entity(&thread_id, "turnItems", &item_id)?;
    if let Some(item) = &existing {
        if text(item, "type") != Some("link_request") {
            return reject(format!("Turn item {item_id} is not a link request."));
        }
        if text(item, "runId") != Some(run_id.as_str()) {
            return reject(format!("Link request {item_id} belongs to another run."));
        }
    }
    // Only a new card needs the run's current root and a live run; an answer may land later.
    if existing.is_none() {
        if text(&run, "rootNodeId") != Some(node_id.as_str()) {
            return reject(format!("Node {node_id} is not the root of run {run_id}."));
        }
        if !is_active(&run) {
            return reject(format!("Run {run_id} is not active."));
        }
    }
    let pending = status == "pending";
    let unchanged = existing
        .as_ref()
        .is_some_and(|i| text(i, "linkStatus") != Some("pending") || pending);
    let now = tx.now().to_owned();
    let item = if unchanged {
        existing.unwrap_or(Value::Null)
    } else {
        let mut fields: Map<String, Value> = command
            .as_object()
            .map(|o| {
                o.iter()
                    .filter(|(k, _)| !NOT_ON_CARD.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let (provider_thread, provider_turn, node, ordinal, started) = match &existing {
            Some(old) => (
                old.get("providerThreadId").cloned().unwrap_or(Value::Null),
                old.get("providerTurnId").cloned().unwrap_or(Value::Null),
                old.get("nodeId").cloned().unwrap_or(json!(node_id)),
                old.get("ordinal").cloned().unwrap_or(json!(0)),
                old.get("startedAt").cloned().unwrap_or(json!(now)),
            ),
            None => (
                run.get("providerThreadId").cloned().unwrap_or(Value::Null),
                provider_turn(tx, &thread_id, &run)?,
                json!(node_id),
                // The store gives a new item its position (`Tx::append`).
                json!(0),
                json!(now),
            ),
        };
        let title = text(&command, "label")
            .or(text(&command, "url"))
            .unwrap_or("Link an environment")
            .to_owned();
        let item_status = match status.as_str() {
            "pending" => "waiting",
            "linked" => "completed",
            "failed" => "failed",
            _ => "cancelled",
        };
        for (key, value) in [
            ("id", json!(item_id)),
            ("nodeId", node),
            ("providerThreadId", provider_thread),
            ("providerTurnId", provider_turn),
            ("nativeItemRef", Value::Null),
            ("parentItemId", Value::Null),
            ("ordinal", ordinal),
            ("status", json!(item_status)),
            ("title", json!(title)),
            ("startedAt", started),
            (
                "completedAt",
                if pending { Value::Null } else { json!(now) },
            ),
            ("updatedAt", json!(now)),
            ("type", json!("link_request")),
        ] {
            fields.insert(key.into(), value);
        }
        Value::Object(fields)
    };
    if !unchanged && status == "linked" && thread.get("snoozedUntil").is_some_and(|v| !v.is_null())
    {
        let mut thread = thread.clone();
        if let Some(fields) = thread.as_object_mut() {
            fields.insert("snoozedUntil".into(), Value::Null);
            fields.insert("snoozedAt".into(), Value::Null);
            fields.insert("updatedAt".into(), json!(now));
        }
        tx.append(Draft::new(&thread_id, "thread.unsnoozed", thread).command(Some(&command_id)))?;
    }
    let card_node = text(&item, "nodeId").unwrap_or(&node_id).to_owned();
    tx.append(
        Draft::new(&thread_id, "turn-item.updated", item)
            .run(Some(&run_id))
            .node(Some(&card_node))
            .command(Some(&command_id)),
    )?;
    // The link answers older cards that asked for the same machine and access; they end
    // without waking anyone. Cards still being answered stay open for their own answer.
    if !unchanged && status == "linked" {
        let answering: Vec<&str> = command
            .get("answeringTurnItemIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let own = tx
            .entity(&thread_id, "turnItems", &item_id)?
            .and_then(|i| i.get("ordinal").and_then(Value::as_u64))
            .unwrap_or(0);
        for mut other in tx.entities(&thread_id, "turnItems")? {
            if text(&other, "type") != Some("link_request")
                || text(&other, "linkStatus") != Some("pending")
                || other.get("ordinal").and_then(Value::as_u64).unwrap_or(0) >= own
                || text(&other, "id").is_some_and(|id| answering.contains(&id))
                || !asked_for_linked_machine(&other, &command)
            {
                continue;
            }
            let (run, node) = (
                text(&other, "runId").map(str::to_owned),
                text(&other, "nodeId").map(str::to_owned),
            );
            if let Some(fields) = other.as_object_mut() {
                fields.insert("status".into(), json!("cancelled"));
                fields.insert("linkStatus".into(), json!("cancelled"));
                fields.insert("completedAt".into(), json!(now));
                fields.insert("updatedAt".into(), json!(now));
            }
            tx.append(
                Draft::new(&thread_id, "turn-item.updated", other)
                    .run(run.as_deref())
                    .node(node.as_deref())
                    .command(Some(&command_id)),
            )?;
        }
    }
    // Only the answer that closes the card wakes the agent, and never a closed thread.
    let Some(wake) = command.get("wake").filter(|w| w.is_object()) else {
        return Ok(vec![]);
    };
    if unchanged
        || thread.get("archivedAt").is_some_and(|v| !v.is_null())
        || thread.get("deletedAt").is_some_and(|v| !v.is_null())
    {
        return Ok(vec![]);
    }
    let dispatch = commands::handler("message.dispatch").expect("message.dispatch");
    match dispatch(
        tx,
        json!({
            "type": "message.dispatch", "commandId": command_id, "threadId": thread_id,
            "messageId": wake.get("messageId"), "text": wake.get("text"),
            "notification": wake.get("notification"),
            "attachments": [], "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent", "creationSource": "server",
        }),
    ) {
        Ok(effects) => Ok(effects),
        Err(CommandError::Store(e)) => Err(CommandError::Store(e)),
        Err(CommandError::Rejected(e)) => {
            eprintln!("conn-engine: could not wake {thread_id}: {e}");
            Ok(vec![])
        }
    }
}

fn provider_turn(tx: &Tx<'_>, thread_id: &str, run: &Value) -> StoreResult<Value> {
    let Some(attempt_id) = run.get("activeAttemptId").and_then(Value::as_str) else {
        return Ok(Value::Null);
    };
    Ok(tx
        .entities_where(thread_id, "providerTurns", "runAttemptId", attempt_id)?
        .into_iter()
        .max_by_key(|t| t.get("ordinal").and_then(Value::as_i64).unwrap_or_default())
        .and_then(|t| t.get("id").cloned())
        .or(tx
            .entity(thread_id, "attempts", attempt_id)?
            .and_then(|a| a.get("providerTurnId").cloned()))
        .unwrap_or(Value::Null))
}

/// Closes link cards still waiting (`closePendingLinkRequests`): stopping or archiving the
/// thread means the user is done with it. Nobody is woken.
pub(crate) fn close_pending(tx: &mut Tx<'_>, thread_id: &str) -> StoreResult<()> {
    for mut item in tx.entities_where(thread_id, "turnItems", "status", "waiting")? {
        if text(&item, "type") != Some("link_request")
            || text(&item, "linkStatus") != Some("pending")
        {
            continue;
        }
        let now = tx.now().to_owned();
        let (run, node) = (
            text(&item, "runId").map(str::to_owned),
            text(&item, "nodeId").map(str::to_owned),
        );
        if let Some(fields) = item.as_object_mut() {
            fields.insert("status".into(), json!("cancelled"));
            fields.insert("linkStatus".into(), json!("cancelled"));
            fields.insert("completedAt".into(), json!(now));
            fields.insert("updatedAt".into(), json!(now));
        }
        tx.append(
            Draft::new(thread_id, "turn-item.updated", item)
                .run(run.as_deref())
                .node(node.as_deref()),
        )?;
    }
    Ok(())
}
