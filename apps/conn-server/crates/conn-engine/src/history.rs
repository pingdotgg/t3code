//! Bounded thread snapshots and older history pages, as T3's `threadHistoryPaging.ts`.
//!
//! A subscriber that sends `acceptBoundedSnapshot` gets the newest window of the timeline
//! (10 user turns, or 75 rows when the window holds no user turn, within a byte budget) and a
//! cursor. `GET /api/orchestration/threads/:threadId/history?cursor=` reads the page before it.
//!
//! The store reads the timeline as an index first (`IndexRows`): per visible row, the fields
//! these rules read and the row's encoded size, never the bodies. The window or page is chosen
//! on the index; the store then loads the bodies of the chosen rows only (T3's
//! `readSnapshotTimelineIndex`, then `materializeHistoryRows`).

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::transcript::RowSink;

/// `THREAD_HISTORY_PAGE_POLICY`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Policy {
    pub(crate) max_user_turns: usize,
    pub(crate) max_items: usize,
    pub(crate) max_turn_items: usize,
    pub(crate) max_encoded_bytes: usize,
}

pub(crate) const PAGE_POLICY: Policy = Policy {
    max_user_turns: 10,
    max_items: 75,
    max_turn_items: 500,
    max_encoded_bytes: 1_048_576,
};
/// `OLDER_THREAD_USER_TURN_LIMIT`: older pages allow twice the turns.
const OLDER_USER_TURN_LIMIT: usize = 20;
/// `THREAD_HISTORY_MAX_RAW_TURNS`.
const MAX_RAW_TURNS: usize = 150;
const CURSOR_MAX_LENGTH: usize = 4_096;
/// The item fields the window rules read; an index row keeps only these.
const INDEX_FIELDS: [&str; 12] = [
    "id",
    "type",
    "inputIntent",
    "createdBy",
    "runId",
    "status",
    "ordinal",
    "messageId",
    "requestId",
    "planId",
    "contextHandoffId",
    "subagentId",
];

/// What a bounded snapshot sends (`BoundedProjectionResult`).
pub(crate) struct Bounded {
    pub(crate) projection: Value,
    pub(crate) history_cursor: Option<String>,
    pub(crate) has_more_history: bool,
    /// The newest local turn item's ordinal, in or out of the window: a client's watermark
    /// for updates to rows older than the window.
    pub(crate) latest_local_turn_ordinal: Option<u64>,
}

/// `InvalidThreadHistoryCursorError`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidCursor;

/// `ThreadHistoryCursorPayload`.
#[derive(Debug, PartialEq)]
pub(crate) struct Cursor {
    pub(crate) source_thread: String,
    pub(crate) source_item: String,
    position: u64,
    pub(crate) inclusive: bool,
}

pub(crate) fn encode_cursor(sequence: u64, row: &Value) -> String {
    let payload = json!({
        "v": 1, "seq": sequence, "st": row["sourceThreadId"], "si": row["sourceItemId"],
        "p": row["position"],
    });
    conn_support::base64::url_encode(payload.to_string().as_bytes())
}

/// `decodeThreadHistoryCursor`.
pub(crate) fn decode_cursor(cursor: &str) -> Result<Cursor, InvalidCursor> {
    if cursor.is_empty() || cursor.len() > CURSOR_MAX_LENGTH {
        return Err(InvalidCursor);
    }
    let bytes = conn_support::base64::url_decode(cursor).ok_or(InvalidCursor)?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| InvalidCursor)?;
    let text = |key: &str| v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let inclusive = match v.get("inclusive") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(InvalidCursor),
    };
    match (
        v["v"].as_u64(),
        v["seq"].as_u64(),
        text("st"),
        text("si"),
        v["p"].as_u64(),
    ) {
        (Some(1), Some(_), Some(source_thread), Some(source_item), Some(position)) => Ok(Cursor {
            source_thread,
            source_item,
            position,
            inclusive,
        }),
        _ => Err(InvalidCursor),
    }
}

fn encoded_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

/// The timeline as an index: each visible row with its encoded size (`rowBytes`, and
/// `itemBytes` for the item alone) and only [`INDEX_FIELDS`] of its item. A fork marker keeps
/// its whole item, synthetic or inherited: it is generated, not stored, and it is small.
#[derive(Default)]
pub(crate) struct IndexRows(pub(crate) Vec<Value>);

impl RowSink for IndexRows {
    fn has_room(&self, _bytes: u64) -> bool {
        true
    }

    fn push(
        &mut self,
        visibility: &str,
        source_thread_id: Value,
        source_item_id: Value,
        item: Value,
    ) -> Result<bool, String> {
        let mut row = json!({
            "position": self.0.len(), "visibility": visibility,
            "sourceThreadId": source_thread_id, "sourceItemId": source_item_id,
        });
        let item_bytes = encoded_bytes(&item);
        row["rowBytes"] = json!(encoded_bytes(&row) + item_bytes + r#","item":"#.len());
        row["itemBytes"] = json!(item_bytes);
        row["item"] = if is_generated(&item) {
            item
        } else {
            let mut light = serde_json::Map::new();
            for field in INDEX_FIELDS {
                if let Some(value) = item.get(field) {
                    light.insert(field.to_owned(), value.clone());
                }
            }
            Value::Object(light)
        };
        self.0.push(row);
        Ok(true)
    }
}

/// A fork marker (`makeForkMarkerTurnItem`): the index holds its body, which no row stores.
pub(crate) fn is_generated(item: &Value) -> bool {
    item["type"] == "fork"
}

fn size_of(row: &Value, key: &str) -> usize {
    row[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(0)
}

/// `isThreadHistoryTurnStart`.
fn is_turn_start(item: &Value) -> bool {
    item["type"] == "user_message"
        && matches!(
            item["inputIntent"].as_str(),
            Some("turn_start" | "queued_turn")
        )
}

/// `isThreadHistoryUserTurn`.
fn is_user_turn(item: &Value) -> bool {
    is_turn_start(item) && item["createdBy"] == "user"
}

/// `isConversationHistoryItem`.
fn is_conversation_item(item: &Value) -> bool {
    !matches!(
        item["type"].as_str(),
        Some("command_execution" | "reasoning" | "file_change" | "dynamic_tool")
    )
}

/// `threadHistoryTurnStarts`: a notification starts a wake turn when it is its run's first
/// input.
fn turn_starts(rows: &[Value]) -> Vec<bool> {
    let mut started = HashSet::new();
    rows.iter()
        .map(|row| {
            let item = &row["item"];
            let kind = item["type"].as_str();
            if kind != Some("user_message") && kind != Some("notification") {
                return false;
            }
            let run = item["runId"].as_str();
            let first = run.is_some_and(|run| !started.contains(run));
            if let Some(run) = run {
                started.insert(run.to_owned());
            }
            if kind == Some("notification") {
                first
            } else {
                is_turn_start(item)
            }
        })
        .collect()
}

/// `SelectTimelinePageResult`, over index rows.
#[derive(Debug)]
pub(crate) struct Page {
    pub(crate) rows: Vec<Value>,
    pub(crate) next_cursor: Option<String>,
    pub(crate) has_more_history: bool,
}

/// `selectOlderTimelinePage`: the rows before `end`, newest first, until a budget is spent.
/// At least one row is always taken, so an oversized row cannot stall paging.
fn select_older(
    rows: &[Value],
    end: usize,
    sequence: u64,
    policy: Policy,
    cost: impl Fn(&Value) -> usize,
) -> Page {
    let end = end.min(rows.len());
    let Some(candidates) = rows.get(..end).filter(|c| !c.is_empty()) else {
        return Page {
            rows: vec![],
            next_cursor: None,
            has_more_history: false,
        };
    };
    let starts = turn_starts(candidates);
    let turn_limit = candidates
        .iter()
        .any(|row| is_user_turn(&row["item"]))
        .then_some(policy.max_user_turns);
    let max_items = if turn_limit.is_some() {
        policy.max_turn_items
    } else {
        policy.max_items
    };
    let (mut selected, mut bytes, mut user_turns, mut raw_turns) = (vec![], 0, 0, 0);
    for (index, row) in candidates.iter().enumerate().rev() {
        let full = selected.len() >= max_items
            || turn_limit.is_some_and(|limit| user_turns >= limit || raw_turns >= MAX_RAW_TURNS);
        if !selected.is_empty() && full {
            break;
        }
        let row_bytes = cost(row);
        if !selected.is_empty() && bytes + row_bytes > policy.max_encoded_bytes {
            break;
        }
        selected.push(index);
        bytes += row_bytes;
        if is_user_turn(&row["item"]) {
            user_turns += 1;
        }
        if starts.get(index).copied().unwrap_or(false) {
            raw_turns += 1;
        }
    }
    // Inside a turn longer than the window, the page uses `maxItems`, as later pages do.
    if user_turns == 0 {
        selected.truncate(policy.max_items);
    }
    selected.reverse();
    let oldest = selected.first().copied();
    let has_more_history = oldest.is_some_and(|at| at > 0);
    let next_cursor = oldest
        .filter(|_| has_more_history)
        .and_then(|at| rows.get(at))
        .map(|row| encode_cursor(sequence, row));
    Page {
        rows: selected
            .into_iter()
            .filter_map(|at| rows.get(at).cloned())
            .collect(),
        next_cursor,
        has_more_history,
    }
}

/// Numbers rows from 0 and drops the index sizes, as clients get them.
pub(crate) fn renumber(rows: impl IntoIterator<Item = Value>) -> Vec<Value> {
    rows.into_iter()
        .enumerate()
        .map(|(position, mut row)| {
            row["position"] = json!(position);
            if let Some(map) = row.as_object_mut() {
                map.remove("rowBytes");
                map.remove("itemBytes");
            }
            row
        })
        .collect()
}

/// `findCursorEndIndex`.
fn cursor_end(rows: &[Value], cursor: &Cursor) -> usize {
    if let Some(at) = rows.iter().position(|row| {
        row["sourceThreadId"] == cursor.source_thread.as_str()
            && row["sourceItemId"] == cursor.source_item.as_str()
    }) {
        return at + usize::from(cursor.inclusive);
    }
    rows.iter()
        .position(|row| {
            let position = row["position"].as_u64().unwrap_or(0);
            if cursor.inclusive {
                row["sourceThreadId"] == cursor.source_thread.as_str()
                    && row["item"]["ordinal"].as_u64().unwrap_or(position) > cursor.position
            } else {
                position >= cursor.position
            }
        })
        .unwrap_or(rows.len())
}

/// `olderHistoryPagePolicy`: twice the turns, widened further so a targeted page reaches
/// `throughEntryId`.
fn older_policy(rows: &[Value], end: usize, through: Option<&str>) -> Policy {
    let policy = Policy {
        max_user_turns: OLDER_USER_TURN_LIMIT,
        ..PAGE_POLICY
    };
    let Some(through) = through else {
        return policy;
    };
    let Some(target) = rows.iter().position(|row| {
        row["item"]["messageId"]
            .as_str()
            .or(row["item"]["id"].as_str())
            == Some(through)
    }) else {
        return policy;
    };
    if target >= end {
        return policy;
    }
    let turns = rows
        .get(target..end)
        .unwrap_or_default()
        .iter()
        .filter(|row| is_user_turn(&row["item"]))
        .count();
    let own = usize::from(
        !rows
            .get(target)
            .is_some_and(|row| is_user_turn(&row["item"])),
    );
    Policy {
        max_user_turns: (turns + own).clamp(OLDER_USER_TURN_LIMIT, OLDER_USER_TURN_LIMIT * 2),
        max_items: policy.max_items * 2,
        max_turn_items: policy.max_turn_items * 2,
        ..policy
    }
}

/// `missingInterruptRequests`: a page carries the interrupt requests its results need, as
/// clients hide a result that has no request.
fn missing_interrupt_requests(rows: &[Value], page: &[Value]) -> Vec<Value> {
    let run_of = |row: &Value, kind: &str| {
        (row["item"]["type"] == kind)
            .then(|| row["item"]["runId"].as_str())
            .flatten()
            .map(str::to_owned)
    };
    let mut runs: HashSet<String> = page
        .iter()
        .filter_map(|row| run_of(row, "run_interrupt_result"))
        .collect();
    for row in page {
        if let Some(run) = run_of(row, "run_interrupt_request") {
            runs.remove(&run);
        }
    }
    if runs.is_empty() {
        return vec![];
    }
    rows.iter()
        .filter(|row| run_of(row, "run_interrupt_request").is_some_and(|run| runs.contains(&run)))
        .cloned()
        .collect()
}

/// `getThreadHistoryPage` without work folding: the index rows of the page before `cursor`,
/// the interrupt requests they need first. `conversation_only` is `view=conversation`.
pub(crate) fn page_rows(
    index: &[Value],
    sequence: u64,
    cursor: &Cursor,
    through: Option<&str>,
    conversation_only: bool,
) -> Page {
    let end = cursor_end(index, cursor);
    let policy = older_policy(index, end, through);
    let page = select_older(index, end, sequence, policy, |_| 0);
    let has_user_turns = conversation_only
        && index
            .get(..end)
            .unwrap_or_default()
            .iter()
            .any(|row| is_user_turn(&row["item"]));
    let rows: Vec<Value> = page
        .rows
        .into_iter()
        .filter(|row| !has_user_turns || is_conversation_item(&row["item"]))
        .collect();
    let bounded = select_older(&rows, rows.len(), sequence, policy, |row| {
        size_of(row, "rowBytes")
    });
    let mut out = missing_interrupt_requests(index, &bounded.rows);
    out.extend(bounded.rows);
    if conversation_only {
        out.retain(|row| is_conversation_item(&row["item"]));
    }
    // When the byte budget trimmed the page, the next page starts at the trimmed one.
    Page {
        rows: out,
        next_cursor: if bounded.has_more_history {
            bounded.next_cursor
        } else {
            page.next_cursor
        },
        has_more_history: bounded.has_more_history || page.has_more_history,
    }
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

fn is_local(thread_id: &Value, row: &Value) -> bool {
    row["visibility"] == "local" || row["sourceThreadId"] == *thread_id
}

/// The pending runtime request ids of a projection (`pendingRequestIdsOf`).
pub(crate) fn pending_request_ids(projection: &Value) -> HashSet<String> {
    array(&projection["runtimeRequests"])
        .iter()
        .filter(|r| r["status"] == "pending")
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect()
}

/// `isRetainedDependency`: an interrupt request, or the row of an open question or approval,
/// which clients build its answer panel from.
pub(crate) fn is_retained_dependency(item: &Value, pending: &HashSet<String>) -> bool {
    item["type"] == "run_interrupt_request"
        || (matches!(
            item["type"].as_str(),
            Some("user_input_request" | "approval_request")
        ) && item["requestId"]
            .as_str()
            .is_some_and(|id| pending.contains(id)))
}

fn latest_todo_list(projection: &Value) -> Option<String> {
    let run_ordinals: HashMap<&str, u64> = array(&projection["runs"])
        .iter()
        .filter_map(|run| Some((run["id"].as_str()?, run["ordinal"].as_u64()?)))
        .collect();
    let mut latest: Option<(&str, u64)> = None;
    for plan in array(&projection["plans"]) {
        let ordinal = plan["runId"].as_str().and_then(|run| run_ordinals.get(run));
        if plan["kind"] == "todo_list"
            && plan["status"] != "superseded"
            && let (Some(ordinal), Some(id)) = (ordinal, plan["id"].as_str())
            && latest.is_none_or(|(_, at)| *ordinal >= at)
        {
            latest = Some((id, *ordinal));
        }
    }
    latest.map(|(id, _)| id.to_owned())
}

/// `buildBoundedThreadProjection`, step one: the window over the index. `control` is the
/// projection without `messages`, `turnItems` and `visibleTurnItems`; `dependencies` are the
/// local items kept outside the window.
pub(crate) fn select_window(
    control: &Value,
    index: &[Value],
    dependencies: &[Value],
    sequence: u64,
) -> Page {
    let policy = PAGE_POLICY;
    let thread_id = &control["thread"]["id"];
    let dependency_reserve: usize = dependencies.iter().map(encoded_bytes).sum();
    let latest_todo = latest_todo_list(control);
    let mut kept = control.clone();
    kept["plans"] = json!(
        array(&control["plans"])
            .iter()
            .filter(|p| p["status"] == "active" || p["id"].as_str() == latest_todo.as_deref())
            .collect::<Vec<_>>()
    );
    kept["contextHandoffs"] = json!(
        array(&control["contextHandoffs"])
            .iter()
            .filter(|h| matches!(h["status"].as_str(), Some("pending" | "ready")))
            .collect::<Vec<_>>()
    );
    // Control state cannot be paged, so the window keeps half the budget; dependency cards
    // take their reserve from that half.
    let half = (policy.max_encoded_bytes / 2).saturating_sub(dependency_reserve);
    let rest = policy
        .max_encoded_bytes
        .saturating_sub(dependency_reserve + encoded_bytes(&kept) + 1_024);
    let window_policy = Policy {
        max_encoded_bytes: half.max(rest),
        ..policy
    };
    // `projectedRowBoundedSnapshotEncodedBytes`: a local row also travels in `turnItems`.
    select_older(index, index.len(), sequence, window_policy, |row| {
        let bytes = size_of(row, "rowBytes");
        if is_local(thread_id, row) {
            bytes + size_of(row, "itemBytes")
        } else {
            bytes
        }
    })
}

/// The runs a window keeps (T3's cohort): those of its rows, the live ones and the latest.
pub(crate) fn cohort_runs(control: &Value, rows: &[Value]) -> Vec<String> {
    let runs = array(&control["runs"]);
    let latest = runs
        .iter()
        .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
        .and_then(|run| run["id"].as_str());
    let live = runs.iter().filter(|run| {
        matches!(
            run["status"].as_str(),
            Some("queued" | "preparing" | "starting" | "running" | "waiting")
        )
    });
    let mut seen = HashSet::new();
    rows.iter()
        .filter_map(|row| row["item"]["runId"].as_str())
        .chain(latest)
        .chain(live.filter_map(|run| run["id"].as_str()))
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

/// Narrows the run records to the cohort, as T3's windowed reads do: the runs, attempts and
/// checkpoints of cohort runs, and any attempt still at work.
pub(crate) fn keep_cohort(control: &mut Value, cohort: &[String]) {
    let keep = |run: &Value| {
        run.as_str()
            .is_some_and(|id| cohort.iter().any(|c| c == id))
    };
    let retain = |control: &mut Value, kind: &str, rule: &dyn Fn(&Value) -> bool| {
        if let Some(rows) = control[kind].as_array_mut() {
            rows.retain(|row| rule(row));
        }
    };
    retain(control, "runs", &|run| keep(&run["id"]));
    retain(control, "attempts", &|attempt| {
        keep(&attempt["runId"])
            || matches!(
                attempt["status"].as_str(),
                Some("pending" | "starting" | "running" | "waiting")
            )
    });
    for kind in ["checkpoints", "checkpointScopes"] {
        retain(control, kind, &|row| {
            row["runId"].is_null() || keep(&row["runId"])
        });
    }
}

/// The message ids and run ids whose messages a bounded projection keeps
/// (`messagesForBoundedProjection`), for the store to read.
pub(crate) fn message_scope(control: &Value, turn_items: &[Value]) -> (Vec<String>, Vec<String>) {
    let mut message_ids: Vec<String> = turn_items
        .iter()
        .filter_map(|item| item["messageId"].as_str().map(str::to_owned))
        .collect();
    let runs = array(&control["runs"]);
    let latest = runs
        .iter()
        .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
        .and_then(|run| run["id"].as_str());
    let mut run_ids = vec![];
    for run in runs {
        let live = matches!(
            run["status"].as_str(),
            Some("preparing" | "starting" | "running" | "waiting" | "queued")
        );
        if let Some(id) = run["id"].as_str()
            && (live || latest == Some(id))
        {
            run_ids.push(id.to_owned());
            if let Some(message) = run["userMessageId"].as_str() {
                message_ids.push(message.to_owned());
            }
        }
    }
    (message_ids, run_ids)
}

/// The local turn items a window shows, then its dependencies outside the window, once each.
pub(crate) fn window_turn_items(
    thread_id: &Value,
    rows: &[Value],
    dependencies: Vec<Value>,
) -> Vec<Value> {
    let mut seen = HashSet::new();
    rows.iter()
        .filter(|row| is_local(thread_id, row))
        .map(|row| row["item"].clone())
        .chain(dependencies)
        .filter(|item| seen.insert(item["id"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// `buildBoundedThreadProjection`, step two: the plans and handoffs the window needs, older
/// ones without their bodies, and the window's rows.
pub(crate) fn finish(
    mut control: Value,
    rows: Vec<Value>,
    turn_items: Vec<Value>,
    messages: Vec<Value>,
) -> Value {
    let latest_todo = latest_todo_list(&control);
    let ids_of = |kinds: &[&str], field: &str| -> HashSet<String> {
        turn_items
            .iter()
            .filter(|item| item["type"].as_str().is_some_and(|t| kinds.contains(&t)))
            .filter_map(|item| item[field].as_str().map(str::to_owned))
            .collect()
    };
    let visible_plans = ids_of(&["proposed_plan", "todo_list"], "planId");
    let visible_handoffs = ids_of(&["handoff"], "contextHandoffId");
    let plans: Vec<Value> = array(&control["plans"])
        .iter()
        .filter_map(|plan| {
            let id = plan["id"].as_str();
            let current = plan["status"] == "active" || id == latest_todo.as_deref();
            if current {
                return Some(plan.clone());
            }
            if !id.is_some_and(|id| visible_plans.contains(id)) {
                return None;
            }
            let mut plan = plan.clone();
            if plan["kind"] == "proposed_plan" {
                plan["markdown"] = json!("");
            } else if let Some(map) = plan.as_object_mut() {
                map.remove("explanation");
            }
            plan["detailInTurnItem"] = json!(true);
            Some(plan)
        })
        .collect();
    let handoffs: Vec<Value> = array(&control["contextHandoffs"])
        .iter()
        .filter_map(|handoff| {
            if matches!(handoff["status"].as_str(), Some("pending" | "ready")) {
                return Some(handoff.clone());
            }
            if !handoff["id"]
                .as_str()
                .is_some_and(|id| visible_handoffs.contains(id))
            {
                return None;
            }
            let mut handoff = handoff.clone();
            handoff["summaryText"] = json!("");
            handoff["detailInTurnItem"] = json!(true);
            Some(handoff)
        })
        .collect();
    control["plans"] = json!(plans);
    control["contextHandoffs"] = json!(handoffs);
    control["messages"] = json!(messages);
    control["turnItems"] = json!(turn_items);
    control["visibleTurnItems"] = json!(renumber(rows));
    control
}

/// The page body (`OrchestrationV2ThreadHistoryPage`) from materialized rows, with the
/// records of its subagent items, which a bounded snapshot can omit.
pub(crate) fn page_body(thread_id: &str, sequence: u64, page: Page, subagents: &[Value]) -> Value {
    let rows = renumber(page.rows);
    let ids: HashSet<&str> = rows
        .iter()
        .filter(|row| row["item"]["type"] == "subagent" && row["sourceThreadId"] == thread_id)
        .filter_map(|row| row["item"]["subagentId"].as_str())
        .collect();
    let mut body = json!({
        "snapshotSequence": sequence,
        "items": rows,
        "nextCursor": page.next_cursor,
        "hasMoreHistory": page.has_more_history,
    });
    if !ids.is_empty() {
        body["subagents"] = json!(
            subagents
                .iter()
                .filter(|s| s["id"].as_str().is_some_and(|id| ids.contains(id)))
                .collect::<Vec<_>>()
        );
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(items: Vec<Value>) -> Vec<Value> {
        let mut index = IndexRows::default();
        for item in items {
            index
                .push("local", json!("t1"), item["id"].clone(), item)
                .unwrap();
        }
        index.0
    }

    fn turn(n: usize) -> [Value; 2] {
        let run = format!("run:t1:{n}");
        [
            json!({"id": format!("u{n}"), "type": "user_message", "inputIntent": "turn_start",
                "createdBy": "user", "runId": run, "messageId": format!("m{n}"), "ordinal": n * 2,
                "text": "x".repeat(100)}),
            json!({"id": format!("a{n}"), "type": "assistant_message", "runId": run,
                "messageId": format!("r{n}"), "ordinal": n * 2 + 1}),
        ]
    }

    fn ids(page: &Page) -> Vec<String> {
        page.rows
            .iter()
            .filter_map(|r| r["item"]["id"].as_str().map(str::to_owned))
            .collect()
    }

    /// T3 `threadHistoryPaging.test.ts`, "keeps the newest user turns and pages back": the
    /// window holds the newest 10 user turns; the cursor reads the 6 before them, and the last
    /// page has no cursor.
    #[test]
    fn a_window_holds_ten_turns_and_pages_back_by_cursor() {
        let index = index_of((0..16).flat_map(turn).collect());
        let window = select_window(&json!({"thread": {"id": "t1"}}), &index, &[], 7);
        assert_eq!(window.rows.len(), 20);
        assert_eq!(ids(&window).first().map(String::as_str), Some("u6"));
        let cursor = decode_cursor(window.next_cursor.as_deref().unwrap()).unwrap();
        let page = page_rows(&index, 7, &cursor, None, false);
        assert_eq!(ids(&page).first().map(String::as_str), Some("u0"));
        assert_eq!(ids(&page).last().map(String::as_str), Some("a5"));
        assert!(!page.has_more_history && page.next_cursor.is_none());
        assert_eq!(decode_cursor("nope"), Err(InvalidCursor));
    }

    /// When the byte budget trims an older page, the next cursor starts at the trimmed page,
    /// so paging still reaches every row (T3's `getThreadHistoryPage`).
    #[test]
    fn paging_reaches_every_row_when_a_page_exceeds_its_byte_budget() {
        let index = index_of(
            (0..30)
                .flat_map(|n| {
                    let [user, mut reply] = turn(n);
                    if n < 20 {
                        reply["text"] = json!("x".repeat(65_536));
                    }
                    [user, reply]
                })
                .collect(),
        );
        let window = select_window(&json!({"thread": {"id": "t1"}}), &index, &[], 1);
        let mut seen = ids(&window);
        let mut cursor = window.next_cursor;
        while let Some(next) = cursor {
            let page = page_rows(&index, 1, &decode_cursor(&next).unwrap(), None, false);
            assert_eq!(page.has_more_history, page.next_cursor.is_some());
            let mut older = ids(&page);
            older.append(&mut seen);
            seen = older;
            cursor = page.next_cursor;
        }
        let all: Vec<String> = (0..30)
            .flat_map(|n| [format!("u{n}"), format!("a{n}")])
            .collect();
        assert_eq!(seen, all);
    }

    /// Without a user turn, a window stops at 75 rows.
    #[test]
    fn a_window_without_user_turns_stops_at_seventy_five_rows() {
        let index = index_of(
            (0..100)
                .map(|n| json!({"id": format!("a{n}"), "type": "assistant_message", "ordinal": n}))
                .collect(),
        );
        let window = select_window(&json!({"thread": {"id": "t1"}}), &index, &[], 1);
        assert_eq!(window.rows.len(), 75);
        assert!(window.has_more_history);
    }

    /// The index keeps the fields the rules read and the row's size, not the body.
    #[test]
    fn the_index_keeps_no_bodies() {
        let index = index_of(turn(0).to_vec());
        assert!(index[0]["item"].get("text").is_none());
        let full = json!({"position": 0, "visibility": "local", "sourceThreadId": "t1",
            "sourceItemId": "u0", "item": turn(0)[0]});
        assert_eq!(size_of(&index[0], "rowBytes"), encoded_bytes(&full));
    }

    /// Messages of the window's items and of the latest run are kept; open questions travel
    /// outside the window.
    #[test]
    fn the_window_keeps_its_messages_and_open_questions() {
        let runs: Vec<Value> = (0..16)
            .map(|n| {
                json!({"id": format!("run:t1:{n}"), "ordinal": n, "status": "completed",
                "userMessageId": format!("m{n}")})
            })
            .collect();
        let control = json!({"thread": {"id": "t1"}, "runs": runs});
        let question = json!({"id": "q", "type": "user_input_request", "requestId": "req"});
        let pending: HashSet<String> = ["req".to_owned()].into();
        assert!(is_retained_dependency(&question, &pending));
        let rows: Vec<Value> = index_of(turn(15).to_vec());
        let items = window_turn_items(&json!("t1"), &rows, vec![question]);
        assert_eq!(items.len(), 3);
        let (messages, runs) = message_scope(&control, &items);
        assert_eq!(messages, ["m15", "r15", "m15"]);
        assert_eq!(runs, ["run:t1:15"]);
    }
}
