//! The context handoff of a provider switch, as the T3 server prepares it when a run starts on
//! another provider instance than the conversation's (`Orchestrator.ts`, the provider switch
//! parts of `dispatchMessage` and `startNextQueuedRun`).
//!
//! The run gets a `provider_handoff` context transfer, already `consumed`, and a context
//! handoff with the conversation's history (`handoff::prepare_provider_handoff`). The new
//! provider gets all of it when it has no native thread of this conversation yet
//! (`full_thread_summary`), else what happened since that thread last took part
//! (`delta_since_target_last_seen`). A "Provider handoff" item shows before the message. The
//! turn start delivers the history (`runner.rs`, `handoff::plan_delivery`), injected into the
//! native thread (Codex) or inline ahead of the user's text.

use conn_support::ids::join_id;
use serde_json::{Value, json};

use crate::commands::{CommandError, reject};
use crate::store::{Draft, StoreResult, Tx};

/// Fork ancestors read for inherited history; a longer chain is cut there.
const MAX_FORK_ANCESTORS: usize = 16_384;

/// `isHandoffSourceRun`: a run whose history a later provider may need. A queued run cancelled
/// before it started never reached a provider.
pub(crate) fn is_handoff_source(run: &Value) -> bool {
    match run["status"].as_str() {
        Some("completed" | "failed" | "interrupted") => true,
        Some("cancelled") => !run["startedAt"].is_null(),
        _ => false,
    }
}

/// Where the switching run goes.
pub(crate) struct Place<'a> {
    pub(crate) thread_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) root_node_id: &'a str,
    pub(crate) ordinal: u64,
    pub(crate) model_selection: &'a Value,
    pub(crate) created_by: &'a Value,
    /// A pending merge-back: the switch then carries the whole conversation.
    pub(crate) requires_full: bool,
    /// A queued run that starts now: it switches when the newest run that reached a provider
    /// ran on another instance (`startNextQueuedRun`).
    pub(crate) queued: bool,
    pub(crate) now: &'a str,
}

/// What a provider switch adds to its run.
pub(crate) struct Switch {
    pub(crate) handoff: Value,
    pub(crate) transfer: Value,
    /// `context-transfer.created` for a switch; a portable fork consumes its pending fork
    /// transfer (`context-transfer.updated`).
    transfer_event: &'static str,
    pub(crate) turn_item: Value,
    /// The run's provider thread: the target instance's own, or none until the run starts.
    pub(crate) provider_thread_id: Value,
    /// The runs the handoff covers (`fromProviderInstanceIds`, `fromModelSelections`).
    covered: Vec<Value>,
}

impl Switch {
    /// `full_thread_summary` or `delta_context`: what `ensureContextHandoff` checks.
    fn needs_full(&self) -> bool {
        self.handoff["strategy"] == "full_thread_summary"
    }

    /// `ensureContextHandoff`: the target provider must take a handoff of this kind.
    pub(crate) fn ensure_supported(
        &self,
        capabilities: &Value,
        instance: &str,
        command_id: &str,
    ) -> Result<(), CommandError> {
        ensure_context_handoff(capabilities, instance, command_id, self.needs_full())
    }

    /// The handoff item's sources, from the covered runs. A merge-back's item shows them too
    /// when the run carries both (T3 shows one handoff item per run).
    pub(crate) fn sources(&self) -> (Value, Value) {
        let mut instances: Vec<Value> = Vec::new();
        let mut selections: Vec<(String, Value)> = Vec::new();
        for run in &self.covered {
            if !instances.contains(&run["providerInstanceId"]) {
                instances.push(run["providerInstanceId"].clone());
            }
            let selection = &run["modelSelection"];
            let key = format!(
                "{}\0{}",
                selection["instanceId"].as_str().unwrap_or_default(),
                selection["model"].as_str().unwrap_or_default()
            );
            // A `Map` keyed by instance and model: the first place, the last value.
            match selections.iter_mut().find(|(k, _)| *k == key) {
                Some((_, value)) => *value = selection.clone(),
                None => selections.push((key, selection.clone())),
            }
        }
        (
            Value::Array(instances),
            Value::Array(selections.into_iter().map(|(_, v)| v).collect()),
        )
    }

    /// Appends the transfer, then the handoff, in T3's order.
    pub(crate) fn append_records(
        &self,
        tx: &mut Tx<'_>,
        thread_id: &str,
        run_id: &str,
        command_id: Option<&str>,
    ) -> StoreResult<()> {
        tx.append(
            Draft::new(thread_id, self.transfer_event, self.transfer.clone())
                .run(Some(run_id))
                .command(command_id),
        )?;
        tx.append(
            Draft::new(thread_id, "context-handoff.updated", self.handoff.clone())
                .run(Some(run_id))
                .command(command_id),
        )?;
        Ok(())
    }
}

/// `CommandPolicy.ensureContextHandoff` for a full (`full_thread_summary`) or a delta handoff.
pub(crate) fn ensure_context_handoff(
    capabilities: &Value,
    instance: &str,
    command_id: &str,
    full: bool,
) -> Result<(), CommandError> {
    let context = &capabilities["context"];
    let detail = if context["canConsumeHandoffSummaries"] != true {
        "providerInstanceId cannot consume handoff summaries"
    } else if context["acceptsSyntheticUserContext"] != true {
        "providerInstanceId cannot receive synthetic user context"
    } else if !full && context["supportsDeltaHandoff"] != true {
        "providerInstanceId does not support delta handoff"
    } else if full && context["supportsFullThreadHandoff"] != true {
        "providerInstanceId does not support full-thread handoff"
    } else {
        return Ok(());
    };
    reject(format!(
        "{instance} cannot satisfy context_handoff for command {command_id}: {detail}"
    ))
}

fn ordinal(run: &Value) -> u64 {
    run["ordinal"].as_u64().unwrap_or(0)
}

/// The instance of the provider thread a message continues (`dispatchProviderThread`). A
/// switch clears the active provider thread here, where T3 keeps it until the next run starts;
/// then the newest run that reached a provider names it.
pub(crate) fn conversation_instance(
    tx: &Tx<'_>,
    thread: &Value,
    wake: bool,
) -> StoreResult<Option<Value>> {
    let thread_id = thread["id"].as_str().unwrap_or_default();
    if let Some(id) = thread["activeProviderThreadId"].as_str()
        && let Some(active) = tx.entity(thread_id, "providerThreads", id)?
    {
        let active = if wake {
            active
        } else {
            crate::fresh::conversation_thread(tx, thread_id, active)?
        };
        return Ok(Some(active["providerInstanceId"].clone()));
    }
    let mut runs = tx.entities(thread_id, "runs")?;
    runs.sort_by_key(ordinal);
    Ok(runs
        .iter()
        .rev()
        .find(|r| r["providerThreadId"].is_string() && r["status"] != "queued")
        .map(|r| r["providerInstanceId"].clone()))
}

/// `lastDeliveredRunForProviderThread`: the newest run whose turn reached `provider_thread`.
fn last_delivered_run<'a>(
    runs: &'a [Value],
    provider_turns: &[Value],
    provider_thread: &Value,
) -> Option<&'a Value> {
    runs.iter().rev().find(|run| {
        is_handoff_source(run)
            && run["providerThreadId"] == provider_thread["id"]
            && (run["status"] == "completed"
                || (!run["activeAttemptId"].is_null()
                    && provider_turns
                        .iter()
                        .any(|turn| turn["runAttemptId"] == run["activeAttemptId"])))
    })
}

/// The provider thread a run on `instance` continues: the active one when it is that
/// instance's, else its newest root thread from the current conversation
/// (`rootProviderThreadsForProvider`).
fn target_provider_thread(
    tx: &Tx<'_>,
    thread: &Value,
    instance: &str,
    boundary: u64,
) -> StoreResult<Option<Value>> {
    let thread_id = thread["id"].as_str().unwrap_or_default();
    let threads =
        tx.entities_where(thread_id, "providerThreads", "providerInstanceId", instance)?;
    let usable = |pt: &&Value| !crate::fresh::predates(pt, boundary);
    if let Some(active) = threads
        .iter()
        .filter(usable)
        .find(|pt| pt["id"] == thread["activeProviderThreadId"])
    {
        return Ok(Some(active.clone()));
    }
    Ok(threads
        .iter()
        .filter(usable)
        .filter(|pt| pt["appThreadId"] == thread_id && pt["ownerNodeId"].is_null())
        .max_by_key(|pt| {
            (
                pt["lastRunOrdinal"].as_u64().unwrap_or(0),
                pt["updatedAt"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .cloned())
}

/// A thread's turn items of the given runs (`None`: those without a run), in timeline order.
fn items_of(
    tx: &Tx<'_>,
    thread_id: &str,
    run_ids: &[Value],
    imported: bool,
) -> StoreResult<Vec<Value>> {
    let mut items: Vec<Value> = tx
        .entities(thread_id, "turnItems")?
        .into_iter()
        .filter(|item| {
            if item["runId"].is_null() {
                imported
            } else {
                run_ids.contains(&item["runId"])
            }
        })
        .collect();
    items.sort_by(|a, b| {
        (a["ordinal"].as_u64(), a["id"].as_str()).cmp(&(b["ordinal"].as_u64(), b["id"].as_str()))
    });
    Ok(items)
}

/// `readInheritedHandoffItems`: the history a run fork shows from its ancestors, oldest
/// first; each ancestor's visible items through the fork run. Side chats inherit none.
fn inherited_items(tx: &Tx<'_>, thread: &Value) -> StoreResult<Vec<Value>> {
    let mut segments: Vec<Vec<Value>> = Vec::new();
    let mut seen = vec![thread["id"].clone()];
    let mut current = thread.clone();
    while segments.len() < MAX_FORK_ANCESTORS
        && current["forkedFrom"]["type"] == "run"
        && current["lineage"]["sideChat"] != true
        && !seen.contains(&current["forkedFrom"]["threadId"])
    {
        let source_id = current["forkedFrom"]["threadId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        seen.push(json!(source_id));
        let Some(source) = tx.thread(&source_id)? else {
            break;
        };
        let runs = tx.entities(&source_id, "runs")?;
        let Some(fork_run) = runs
            .iter()
            .find(|r| r["id"] == current["forkedFrom"]["runId"])
        else {
            break;
        };
        let through: Vec<Value> = runs
            .iter()
            .filter(|r| ordinal(r) <= ordinal(fork_run))
            .map(|r| r["id"].clone())
            .collect();
        let items = items_of(
            tx,
            &source_id,
            &through,
            source["historyOrigin"] == "v1_import",
        )?;
        let attempts = tx.entities(&source_id, "attempts")?;
        segments.push(
            crate::visibility::visible_items(&runs, &attempts, &items)
                .into_iter()
                .filter_map(|at| items.get(at).cloned())
                .collect(),
        );
        current = source;
    }
    Ok(segments.into_iter().rev().flatten().collect())
}

/// The provider switch of a run on `place.model_selection`'s instance, coming from another
/// instance. `None` when no earlier run reached a provider.
pub(crate) fn prepare(
    tx: &Tx<'_>,
    thread: &Value,
    place: &Place<'_>,
) -> StoreResult<Option<Switch>> {
    let thread_id = place.thread_id;
    let instance = place.model_selection["instanceId"]
        .as_str()
        .unwrap_or_default();
    let mut runs: Vec<Value> = tx
        .entities(thread_id, "runs")?
        .into_iter()
        .filter(|r| r["id"] != place.run_id)
        .collect();
    runs.sort_by_key(ordinal);
    let Some(latest) = runs.iter().rev().find(|r| is_handoff_source(r)).cloned() else {
        return Ok(None);
    };
    if place.queued && latest["providerInstanceId"] == instance {
        return Ok(None);
    }
    let user_items = tx.entities_where(thread_id, "turnItems", "type", "user_message")?;
    let boundary = crate::fresh::boundary(&runs, &user_items);
    let target = target_provider_thread(tx, thread, instance, boundary)?;
    let provider_turns = tx.entities(thread_id, "providerTurns")?;
    let target_last = target
        .as_ref()
        .and_then(|pt| last_delivered_run(&runs, &provider_turns, pt))
        .cloned();
    let seen_through = if place.requires_full {
        0
    } else {
        target_last.as_ref().map_or(0, ordinal)
    };
    let covered: Vec<Value> = runs
        .iter()
        .filter(|r| {
            is_handoff_source(r)
                && ordinal(r) >= boundary
                && ordinal(r) > seen_through
                && ordinal(r) <= ordinal(&latest)
        })
        .cloned()
        .collect();
    let (Some(first), Some(last)) = (covered.first(), covered.last()) else {
        return Ok(None);
    };
    let needs_full = place.requires_full
        || target
            .as_ref()
            .is_none_or(|pt| pt["nativeThreadRef"].is_null());
    let mut items = Vec::new();
    if needs_full && boundary == 0 {
        items.extend(inherited_items(tx, thread)?);
    }
    let imported = needs_full
        && boundary == 0
        && thread["historyOrigin"] == "v1_import"
        && runs.iter().any(|r| r["status"] == "completed");
    if imported {
        items.extend(items_of(tx, thread_id, &[], true)?);
    }
    let covered_ids: Vec<Value> = covered.iter().map(|r| r["id"].clone()).collect();
    items.extend(items_of(tx, thread_id, &covered_ids, false)?);

    let provider_thread_id = target.as_ref().map_or(Value::Null, |pt| pt["id"].clone());
    // Until the run starts, the handoff names a provisional provider thread (T3's
    // `pending:<run>`); the delivery replaces it.
    let to_provider_thread = if provider_thread_id.is_string() {
        provider_thread_id.clone()
    } else {
        json!(crate::merge_back::provisional_provider_thread(place.run_id))
    };
    let mut from_provider_threads: Vec<Value> = Vec::new();
    for run in &covered {
        if run["providerThreadId"].is_string()
            && !from_provider_threads.contains(&run["providerThreadId"])
        {
            from_provider_threads.push(run["providerThreadId"].clone());
        }
    }
    let from_instance = latest["providerInstanceId"].as_str().unwrap_or_default();
    let transfer_id = join_id(
        "context-transfer",
        &[
            "type",
            "provider_handoff",
            "source-thread",
            thread_id,
            "target-thread",
            thread_id,
            &conn_support::uuid_v4(),
        ],
    );
    let handoff_id = join_id(
        "context-handoff",
        &[
            "thread",
            thread_id,
            "from-provider-instance",
            from_instance,
            "to-provider-instance",
            instance,
            &conn_support::uuid_v4(),
        ],
    );
    let strategy = if needs_full {
        "full_thread_summary"
    } else {
        "delta_since_target_last_seen"
    };
    let transfer_value = json!(transfer_id);
    let handoff = crate::handoff::prepare_provider_handoff(&crate::handoff::ProviderHandoff {
        id: handoff_id.clone(),
        thread_id,
        source_thread_id: None,
        target_run_id: place.run_id,
        transfer_id: &transfer_value,
        from_provider_thread_ids: from_provider_threads,
        to_provider_thread_id: to_provider_thread,
        covered: json!({"from": ordinal(first), "to": ordinal(last)}),
        strategy,
        items: &items,
        runs: &runs,
        token_cap: crate::handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
        now: place.now,
    });
    let base_point = match &target_last {
        Some(run) if !place.requires_full => crate::fork::source_point(tx, thread_id, run)?,
        _ => Value::Null,
    };
    let transfer = json!({
        "id": transfer_id,
        "type": "provider_handoff",
        "sourceThreadId": thread_id,
        "targetThreadId": thread_id,
        "sourcePoint": crate::fork::source_point(tx, thread_id, &latest)?,
        "basePoint": base_point,
        "sourceProviderInstanceId": latest["providerInstanceId"],
        "targetProviderInstanceId": instance,
        "targetRunId": place.run_id,
        "status": "consumed",
        "resolution": {
            "strategy": if needs_full { "portable_context" } else { "delta_context" },
            "contextHandoffId": handoff_id,
        },
        "createdBy": place.created_by,
        "error": null,
        "createdAt": place.now,
        "updatedAt": place.now,
        "consumedAt": place.now,
    });
    Ok(Some(assemble(
        place,
        Switch {
            turn_item: Value::Null,
            handoff,
            transfer,
            transfer_event: "context-transfer.created",
            provider_thread_id,
            covered,
        },
    )))
}

/// A run's first message on a fork that cannot fork natively (`decideForkExecution`
/// `portable_context`): the fork's pending transfer is consumed, and the run gets the history
/// the fork inherits through its fork point (`readForkHistoryItems`), in full.
pub(crate) fn prepare_fork(
    tx: &Tx<'_>,
    thread: &Value,
    place: &Place<'_>,
    pending: &Value,
) -> StoreResult<Switch> {
    let instance = place.model_selection["instanceId"]
        .as_str()
        .unwrap_or_default();
    let source_id = pending["sourceThreadId"].as_str().unwrap_or_default();
    let mut runs = tx.entities(source_id, "runs")?;
    runs.sort_by_key(ordinal);
    let fork_ordinal = runs
        .iter()
        .find(|r| r["id"] == pending["sourcePoint"]["runId"])
        .map_or(u64::MAX, ordinal);
    let covered: Vec<Value> = runs
        .iter()
        .filter(|r| is_handoff_source(r) && ordinal(r) <= fork_ordinal)
        .cloned()
        .collect();
    let items = inherited_items(tx, thread)?;
    let from_provider_threads: Vec<Value> = runs
        .iter()
        .filter(|r| r["id"] == pending["sourcePoint"]["runId"])
        .filter_map(|r| r["providerThreadId"].as_str().map(Value::from))
        .collect();
    let from_instance = pending["sourceProviderInstanceId"]
        .as_str()
        .unwrap_or_default();
    let handoff_id = join_id(
        "context-handoff",
        &[
            "thread",
            place.thread_id,
            "from-provider-instance",
            from_instance,
            "to-provider-instance",
            instance,
            &conn_support::uuid_v4(),
        ],
    );
    let range = json!({
        "from": covered.first().map_or(0, ordinal),
        "to": covered.last().map_or(0, ordinal),
    });
    let handoff = crate::handoff::prepare_provider_handoff(&crate::handoff::ProviderHandoff {
        id: handoff_id.clone(),
        thread_id: place.thread_id,
        source_thread_id: Some(source_id),
        target_run_id: place.run_id,
        transfer_id: &pending["id"],
        from_provider_thread_ids: from_provider_threads,
        to_provider_thread_id: json!(crate::merge_back::provisional_provider_thread(place.run_id)),
        covered: range,
        strategy: "full_thread_summary",
        items: &items,
        runs: &runs,
        token_cap: crate::handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
        now: place.now,
    });
    let mut transfer = pending.clone();
    for (field, value) in [
        ("targetProviderInstanceId", json!(instance)),
        ("targetRunId", json!(place.run_id)),
        ("status", json!("consumed")),
        (
            "resolution",
            json!({"strategy": "portable_context", "contextHandoffId": handoff_id}),
        ),
        ("updatedAt", json!(place.now)),
        ("consumedAt", json!(place.now)),
    ] {
        transfer[field] = value;
    }
    Ok(assemble(
        place,
        Switch {
            turn_item: Value::Null,
            handoff,
            transfer,
            transfer_event: "context-transfer.updated",
            provider_thread_id: Value::Null,
            covered,
        },
    ))
}

/// Adds the "Provider handoff" item, just ahead of the run's user message.
fn assemble(place: &Place<'_>, mut switch: Switch) -> Switch {
    let instance = place.model_selection["instanceId"].clone();
    let handoff_id = switch.handoff["id"].as_str().unwrap_or_default().to_owned();
    let strategy = switch.handoff["strategy"].clone();
    let (from_instances, from_selections) = switch.sources();
    switch.turn_item = json!({
        "id": join_id("turn-item", &["run", place.run_id, "signal", &format!("context-handoff:{handoff_id}")]),
        "threadId": place.thread_id,
        "runId": place.run_id,
        "nodeId": place.root_node_id,
        "providerThreadId": switch.provider_thread_id,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        // Just ahead of the run's user message (`ordinal * 1_000_000 + 1` here).
        "ordinal": place.ordinal * 1_000_000,
        "status": "completed",
        "title": "Provider handoff",
        "startedAt": place.now,
        "completedAt": place.now,
        "updatedAt": place.now,
        "type": "handoff",
        "contextHandoffId": handoff_id,
        "fromProviderThreadIds": switch.handoff["fromProviderThreadIds"],
        "toProviderThreadId": switch.handoff["toProviderThreadId"],
        "fromProviderInstanceIds": from_instances,
        "toProviderInstanceId": instance,
        "fromModelSelections": from_selections,
        "toModel": place.model_selection["model"],
        "strategy": strategy,
        "summary": switch.handoff["summaryText"],
    });
    switch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_sources_are_the_runs_that_reached_a_provider() {
        let run = |status: &str, started: Value| json!({"status": status, "startedAt": started});
        assert!(is_handoff_source(&run("completed", Value::Null)));
        assert!(is_handoff_source(&run("failed", Value::Null)));
        assert!(is_handoff_source(&run("interrupted", Value::Null)));
        assert!(is_handoff_source(&run("cancelled", json!("t"))));
        assert!(!is_handoff_source(&run("cancelled", Value::Null)));
        assert!(!is_handoff_source(&run("queued", Value::Null)));
        assert!(!is_handoff_source(&run("rolled_back", json!("t"))));
        assert!(!is_handoff_source(&run("running", json!("t"))));
    }

    #[test]
    fn the_item_lists_each_source_once_in_first_seen_order() {
        let run = |instance: &str, model: &str, effort: &str| {
            json!({"providerInstanceId": instance,
                "modelSelection": {"instanceId": instance, "model": model, "effort": effort}})
        };
        let switch = Switch {
            handoff: Value::Null,
            transfer: Value::Null,
            transfer_event: "context-transfer.created",
            turn_item: Value::Null,
            provider_thread_id: Value::Null,
            covered: vec![
                run("codex", "gpt", "low"),
                run("grok", "g", "x"),
                run("codex", "gpt", "high"),
            ],
        };
        let (instances, selections) = switch.sources();
        assert_eq!(instances, json!(["codex", "grok"]));
        assert_eq!(
            selections,
            json!([
                {"instanceId": "codex", "model": "gpt", "effort": "high"},
                {"instanceId": "grok", "model": "g", "effort": "x"},
            ])
        );
    }
}
