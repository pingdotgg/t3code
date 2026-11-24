//! Engine rows (shell rows, thread projections) shaped as the T3 tool results
//! (`packages/contracts/src/orchestratorMcp.ts`), as `OrchestratorMcpService.ts` builds them.

use serde_json::{Value, json};

use crate::{Caller, McpConfig, links::thread_link};

pub(crate) const LIVE_RUN_STATUSES: [&str; 5] =
    ["preparing", "queued", "starting", "running", "waiting"];

pub(crate) fn is_live(run: &Value) -> bool {
    LIVE_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or(""))
}

fn runs(projection: &Value) -> Vec<&Value> {
    let mut runs: Vec<&Value> = projection["runs"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default();
    runs.sort_by_key(|run| run["ordinal"].as_u64().unwrap_or(0));
    runs
}

pub(crate) fn latest_run(projection: &Value) -> Option<&Value> {
    runs(projection).pop()
}

pub(crate) fn active_run(projection: &Value) -> Option<&Value> {
    runs(projection)
        .into_iter()
        .rev()
        .find(|run| is_live(run) && run["status"] != "queued")
}

pub(crate) fn run_by_id<'a>(projection: &'a Value, run_id: &str) -> Option<&'a Value> {
    projection["runs"]
        .as_array()?
        .iter()
        .find(|run| run["id"] == run_id)
}

fn settled(thread: &Value) -> (bool, Value) {
    let settled = thread["settledOverride"] == "settled";
    let at = if settled {
        thread["settledAt"].clone()
    } else {
        Value::Null
    };
    (settled, at)
}

fn snoozed(thread: &Value, now: &str) -> (bool, Value) {
    match thread["snoozedUntil"].as_str() {
        Some(until) if until > now => (true, json!(until)),
        _ => (false, Value::Null),
    }
}

pub(crate) fn is_snoozed(thread: &Value, now: &str) -> bool {
    snoozed(thread, now).0
}

pub(crate) fn is_settled(thread: &Value) -> bool {
    settled(thread).0
}

/// `threadBackgroundWork`: the shell's pending background tasks without provider-internal
/// links (`parentTaskId`, `providerInstanceId`).
fn background_work(tasks: &Value) -> Value {
    let tasks = tasks.as_array().map(Vec::as_slice).unwrap_or_default();
    Value::Array(
        tasks
            .iter()
            .map(|task| {
                let mut out = json!({"taskId": task["taskId"], "kind": task["kind"]});
                for key in ["description", "awaited"] {
                    if let Some(value) = task.get(key).filter(|v| !v.is_null()) {
                        out[key] = value.clone();
                    }
                }
                if task["kind"] == "subagent"
                    && let Some(child) = task.get("childThreadId").filter(|v| !v.is_null())
                {
                    out["childThreadId"] = child.clone();
                }
                out
            })
            .collect(),
    )
}

/// `OrchestratorMcpThreadListItem` from a shell row.
pub(crate) fn list_item(config: &McpConfig, caller: &Caller, shell: &Value, now: &str) -> Value {
    let id = shell["id"].as_str().unwrap_or_default();
    let title = shell["title"].as_str().unwrap_or_default();
    let (settled, settled_at) = settled(shell);
    let (snoozed, snoozed_until) = snoozed(shell, now);
    let mut item = json!({
        "threadId": id,
        "projectId": shell["projectId"],
        "title": title,
        "link": thread_link(config, caller, id, title),
        "createdBy": shell["createdBy"],
        "creationSource": shell["creationSource"],
        "status": listed_status(shell),
        "latestRunId": shell["latestRunId"],
        "providerInstanceId": shell["modelSelection"]["instanceId"],
        "model": shell["modelSelection"]["model"],
        "runtimeMode": shell["runtimeMode"],
        "interactionMode": shell["interactionMode"],
        "linkedPullRequest": shell.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
        "settled": settled,
        "settledAt": settled_at,
        "snoozed": snoozed,
        "snoozedUntil": snoozed_until,
        "pinned": !shell["pinnedAt"].is_null(),
        "blockedOnThreadWait": shell["blockedOnThreadWait"] == true,
        "pendingBackgroundTasks": background_work(&shell["pendingBackgroundTasks"]),
        "parentThreadId": shell["lineage"]["parentThreadId"],
        "relationshipToParent": shell["lineage"]["relationshipToParent"],
        "itemCount": shell["visibleItemCount"].as_u64().unwrap_or(0),
        "createdAt": shell["createdAt"],
        "updatedAt": shell["updatedAt"],
    });
    if shell["orbitProject"].is_object() {
        item["orbitProject"] = shell["orbitProject"].clone();
    }
    insert_pull_requests(&mut item, &shell["pullRequests"], true);
    item
}

/// The status a list shows: the live run's, else the latest run's (TS `listedThreadStatus`).
pub(crate) fn listed_status(shell: &Value) -> Value {
    if shell["activityRunStatus"].is_string() {
        shell["activityRunStatus"].clone()
    } else {
        shell["status"].clone()
    }
}

/// Whether a thread read is the first page, which alone lists the thread's pull requests.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Page {
    First,
    Later,
}

/// `OrchestratorMcpThreadDetail` from a projection.
pub(crate) fn thread_detail(
    config: &McpConfig,
    caller: &Caller,
    projection: &Value,
    now: &str,
    page: Page,
) -> Value {
    let thread = &projection["thread"];
    let id = thread["id"].as_str().unwrap_or_default();
    let title = thread["title"].as_str().unwrap_or_default();
    let latest = latest_run(projection);
    let active = active_run(projection);
    let (settled, settled_at) = settled(thread);
    let (snoozed, snoozed_until) = snoozed(thread, now);
    let pending = projection["runtimeRequests"]
        .as_array()
        .map_or(0, |r| r.iter().filter(|r| r["status"] == "pending").count());
    let mut detail = json!({
        "threadId": id,
        "projectId": thread["projectId"],
        "title": title,
        "link": thread_link(config, caller, id, title),
        "createdBy": thread["createdBy"],
        "creationSource": thread["creationSource"],
        "status": active.or(latest).map_or(json!("idle"), |run| run["status"].clone()),
        "latestRunId": latest.map_or(Value::Null, |run| run["id"].clone()),
        "activeRunId": active.map_or(Value::Null, |run| run["id"].clone()),
        "providerInstanceId": thread["modelSelection"]["instanceId"],
        "model": thread["modelSelection"]["model"],
        "runtimeMode": thread["runtimeMode"],
        "interactionMode": thread["interactionMode"],
        "linkedPullRequest": thread.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
        "titleRegeneration": title_regeneration(&thread["titleRegeneration"]),
        "lastTitleRegeneration": if thread["lastTitleRegeneration"].is_object() {
            thread["lastTitleRegeneration"].clone()
        } else {
            Value::Null
        },
        "branch": thread["branch"],
        "worktreePath": thread["worktreePath"],
        "parentThreadId": thread["lineage"]["parentThreadId"],
        "relationshipToParent": thread["lineage"]["relationshipToParent"],
        "runCount": projection["runs"].as_array().map_or(0, Vec::len),
        "itemCount": projection["visibleTurnItems"].as_array().map_or(0, Vec::len),
        "pendingRequestCount": pending,
        "archived": !thread["archivedAt"].is_null(),
        "settled": settled,
        "settledAt": settled_at,
        "snoozed": snoozed,
        "snoozedUntil": snoozed_until,
        "pinned": !thread["pinnedAt"].is_null(),
        "blockedOnThreadWait": false,
        "pendingBackgroundTasks": [],
        "createdAt": thread["createdAt"],
        "updatedAt": projection["updatedAt"],
    });
    if thread["orbitProject"].is_object() {
        detail["orbitProject"] = thread["orbitProject"].clone();
    }
    insert_pull_requests(&mut detail, &thread["pullRequests"], page == Page::First);
    detail
}

/// `visibleThreadPullRequests`: every link but one the user dismissed from a stack.
fn visible_pull_requests(links: &Value) -> impl Iterator<Item = &Value> {
    links
        .as_array()
        .into_iter()
        .flatten()
        .filter(|link| link["source"] != "stack-dismissed")
}

/// The most open links a list item or a first read page shows (`THREAD_PULL_REQUEST_PREVIEW_LIMIT`);
/// `list_thread_pull_requests` pages the rest.
const PULL_REQUEST_PREVIEW_LIMIT: usize = 5;

/// `threadPullRequestUpdatedAtMs`: the snapshot's update time, else the link time; 0 when the
/// text is not a time.
fn pull_request_updated_ms(link: &Value) -> i64 {
    link["snapshot"]["updatedAt"]
        .as_str()
        .or_else(|| link["linkedAt"].as_str())
        .and_then(crate::time::parse_iso_ms)
        .unwrap_or(0)
}

/// `threadPullRequests` (`OrchestratorMcpService.ts`): `pullRequestCount` always. With
/// `include_links`: the visible links that are not merged or closed, watched first and then
/// newest first, the first five as `pullRequests`, and their number as `openPullRequestCount`.
/// The host is the link's authority or host, trimmed and lower case; the T3 server also maps
/// host aliases through the source control registry, which this does not.
fn insert_pull_requests(out: &mut Value, links: &Value, include_links: bool) {
    let visible: Vec<&Value> = visible_pull_requests(links).collect();
    out["pullRequestCount"] = json!(visible.len());
    if !include_links {
        return;
    }
    let mut open: Vec<&Value> = visible
        .into_iter()
        .filter(|link| {
            !matches!(
                link["snapshot"]["state"].as_str(),
                Some("merged" | "closed")
            )
        })
        .collect();
    out["openPullRequestCount"] = json!(open.len());
    // A stable sort, as `toSorted`.
    open.sort_by(|left, right| {
        right["watch"]
            .is_object()
            .cmp(&left["watch"].is_object())
            .then_with(|| pull_request_updated_ms(right).cmp(&pull_request_updated_ms(left)))
    });
    out["pullRequests"] = open
        .into_iter()
        .take(PULL_REQUEST_PREVIEW_LIMIT)
        .map(|link| {
            let host = link["authority"]
                .as_str()
                .or_else(|| link["host"].as_str())
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let watch = &link["watch"];
            json!({
                "host": host,
                "repository": link["repository"],
                "number": link["number"],
                "url": link["url"],
                "source": link["source"],
                "state": link["snapshot"]["state"].as_str().map_or(Value::Null, |s| json!(s)),
                "watching": watch.is_object(),
                "watchStartedAt": watch["startedAt"].as_str().map_or(Value::Null, |s| json!(s)),
            })
        })
        .collect();
}

/// The title regeneration in flight, as `{ requestId, startedAt }`.
fn title_regeneration(running: &Value) -> Value {
    if running.is_object() {
        json!({ "requestId": running["requestId"], "startedAt": running["startedAt"] })
    } else {
        Value::Null
    }
}

/// The model the provider reported for the run's attempt, if any.
pub(crate) fn executed_model(projection: &Value, run: &Value) -> Value {
    let attempt = &run["activeAttemptId"];
    if attempt.is_null() {
        return Value::Null;
    }
    projection["providerTurns"]
        .as_array()
        .and_then(|turns| {
            turns
                .iter()
                .rev()
                .find(|turn| &turn["attemptId"] == attempt && turn["model"].is_string())
        })
        .map_or(Value::Null, |turn| turn["model"].clone())
}

/// `OrchestratorMcpThreadRun`.
pub(crate) fn thread_run(projection: &Value, run: &Value) -> Value {
    json!({
        "runId": run["id"],
        "ordinal": run["ordinal"],
        "status": run["status"],
        "providerInstanceId": run["modelSelection"]["instanceId"],
        "model": run["modelSelection"]["model"],
        "executedModel": executed_model(projection, run),
        "requestedAt": run["requestedAt"],
        "startedAt": run["startedAt"],
        "completedAt": run["completedAt"],
    })
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn join(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The text a turn item shows an agent (TS `turnItemText`).
pub(crate) fn turn_item_text(item: &Value) -> Option<String> {
    let kind = item["type"].as_str().unwrap_or_default();
    Some(match kind {
        "secret_request" => format!(
            "Asked the user for {}: {}.",
            item.get("label")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            item.get("secretStatus")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        "notification" => join(&[text(&item["summary"]), text(&item["detail"])]),
        "user_message" | "assistant_message" | "reasoning" => return text(&item["text"]),
        "proposed_plan" => return text(&item["markdown"]),
        "todo_list" => {
            let mut parts = vec![text(&item["explanation"])];
            for step in item["steps"].as_array().into_iter().flatten() {
                parts.push(Some(format!(
                    "[{}] {}",
                    step["status"].as_str().unwrap_or_default(),
                    step["text"].as_str().unwrap_or_default()
                )));
            }
            join(&parts)
        }
        "user_input_request" => pretty(&item["questions"]),
        "file_change" => {
            let counts =
                (!item["additions"].is_null() || !item["deletions"].is_null()).then(|| {
                    format!(
                        "+{} -{}",
                        item["additions"].as_u64().unwrap_or(0),
                        item["deletions"].as_u64().unwrap_or(0)
                    )
                });
            let body = text(&item["diffStr"]).or_else(|| text(&item["newStr"]));
            join(&[text(&item["fileName"]), counts, body])
        }
        "command_execution" => join(&[
            item["input"].as_str().map(|input| format!("$ {input}")),
            text(&item["output"]),
        ]),
        "file_search" => pretty(&json!({"pattern": item["pattern"], "results": item["results"]})),
        "web_search" => pretty(&json!({"patterns": item["patterns"], "results": item["results"]})),
        "approval_request" => join(&[
            text(&item["prompt"]).or_else(|| text(&item["requestKind"])),
            text(&item["reason"]),
        ]),
        "checkpoint" => pretty(&item["files"]),
        "run_interrupt_request" | "run_interrupt_result" | "system_notice" => {
            return text(&item["message"]);
        }
        "error" => return text(&item["failure"]["message"]),
        "compaction" => return text(&item["summary"]),
        "thread_created" => format!(
            "Created thread {} with {} ({}).",
            item["targetThreadId"].as_str().unwrap_or_default(),
            item["targetProviderInstanceId"]
                .as_str()
                .unwrap_or_default(),
            item["targetModel"].as_str().unwrap_or_default()
        ),
        "subagent" => {
            return text(&item["result"])
                .or_else(|| text(&item["progress"]))
                .or_else(|| text(&item["prompt"]));
        }
        "dynamic_tool" => pretty(&json!({
            "toolName": item["toolName"], "input": item["input"], "output": item["output"],
        })),
        _ => return None,
    })
}

/// The end of a text page that starts at `offset`, in UTF-16 units, as the T3 server counts
/// text (`textPageEnd`). A cut inside a surrogate pair moves to the pair's edge, so no page
/// holds half an emoji.
fn text_page_end(units: &[u16], offset: usize, max_chars: usize) -> usize {
    let end = offset.saturating_add(max_chars);
    if end >= units.len() {
        return end;
    }
    let is_high_surrogate = end
        .checked_sub(1)
        .and_then(|last| units.get(last))
        .is_some_and(|unit| (0xd800..=0xdbff).contains(unit));
    if !is_high_surrogate {
        end
    } else if end - 1 > offset {
        end - 1
    } else {
        end + 1
    }
}

fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    let end = end.min(units.len());
    let start = start.min(end);
    units
        .get(start..end)
        .map(String::from_utf16_lossy)
        .unwrap_or_default()
}

/// `OrchestratorMcpThreadTimelineItem` for one visible row, its text cut to a page of
/// `max_chars` UTF-16 units from `offset` (the T3 server's `text.slice`).
pub(crate) fn timeline_item(
    row: &Value,
    messages: &[Value],
    max_chars: usize,
    offset: usize,
) -> Value {
    let item = &row["item"];
    let units: Option<Vec<u16>> = turn_item_text(item).map(|t| t.encode_utf16().collect());
    let (page, truncated, next) = match &units {
        Some(units) => {
            let end = text_page_end(units, offset, max_chars);
            let truncated = units.len() > end;
            (
                Some(utf16_slice(units, offset, end)),
                truncated,
                truncated.then_some(end),
            )
        }
        None => (None, false, None),
    };
    let kind = item["type"].as_str().unwrap_or_default();
    let message_id = matches!(kind, "user_message" | "assistant_message")
        .then(|| item["messageId"].clone())
        .unwrap_or(Value::Null);
    let message = messages
        .iter()
        .find(|m| !message_id.is_null() && m["id"] == message_id);
    let mut out = json!({
        "position": row["position"],
        "visibility": row["visibility"],
        "sourceThreadId": row["sourceThreadId"],
        "itemId": row["sourceItemId"],
        "runId": item["runId"],
        "messageId": message_id,
        "createdBy": message.map_or(Value::Null, |m| m["createdBy"].clone()),
        "creationSource": message.map_or(Value::Null, |m| m["creationSource"].clone()),
        "type": kind,
        "status": item["status"],
        "title": item["title"],
        "text": page,
        "textTruncated": truncated,
        "nextTextOffset": next,
        "updatedAt": item["updatedAt"],
    });
    if kind == "subagent" {
        out["subagentId"] = item["subagentId"].clone();
    }
    if let Some(sender) = message.and_then(|m| m.get("senderThreadId")) {
        out["senderThreadId"] = sender.clone();
    }
    out
}

/// The size a value has on the wire: bytes of its compact JSON, as the T3 server measures
/// (`jsonBytes`).
pub(crate) fn json_bytes(value: &Value) -> usize {
    value.to_string().len()
}

/// The longest length in `[low, high]` that `fits`, else `low - 1`: the T3 server's binary
/// search (`longestFitting`), which assumes a longer cut never fits when a shorter one does not.
fn longest_fitting(low: i64, high: i64, fits: impl Fn(i64) -> bool) -> i64 {
    let (mut low, mut high, mut best) = (low, high, low - 1);
    while low <= high {
        let mid = low + (high - low) / 2;
        if fits(mid) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    best
}

/// `timelineItemWithin`: the item with its text cut, and an oversized title too, until its
/// JSON fits `max_bytes`.
pub(crate) fn timeline_item_within(
    row: &Value,
    messages: &[Value],
    max_chars: usize,
    offset: usize,
    max_bytes: usize,
) -> Value {
    let longest_text = |title: &Value| {
        let with_text = |chars: usize| {
            let mut item = timeline_item(row, messages, chars, offset);
            item["title"] = title.clone();
            item
        };
        let chars = longest_fitting(2, max_chars as i64 - 1, |n| {
            json_bytes(&with_text(n as usize)) <= max_bytes
        });
        with_text(chars.max(1) as usize)
    };
    let item = longest_text(&row["item"]["title"]);
    let Some(title) = item["title"].as_str() else {
        return item;
    };
    if json_bytes(&item) <= max_bytes {
        return item;
    }
    // Half the budget for the title keeps `textOffset` pages of the text useful.
    let units: Vec<u16> = title.encode_utf16().collect();
    let cut_title = |chars: i64| {
        let end = if chars <= 0 {
            0
        } else {
            text_page_end(&units, 0, chars as usize)
        };
        json!(utf16_slice(&units, 0, end))
    };
    let title_chars = longest_fitting(1, units.len() as i64 - 1, |n| {
        let mut cut = item.clone();
        cut["title"] = cut_title(n);
        json_bytes(&cut) * 2 <= max_bytes
    });
    longest_text(&cut_title(title_chars.max(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_stopped_run_without_an_answer_reports_the_reason() {
        let run = json!({"id": "run:c:1", "status": "completed"});
        let notice = json!({"id": conn_engine::provider_stop_reason_id("run:c:1"),
            "runId": "run:c:1", "type": "system_notice", "message": "hook said stop"});
        assert_eq!(
            conn_engine::delegated_task_result(&json!({"turnItems": [notice]}), &run),
            "Child task completed without an assistant result.\n\nhook said stop"
        );
        assert_eq!(
            conn_engine::delegated_task_result(&json!({"turnItems": []}), &run),
            "Child task completed without an assistant result."
        );
    }

    #[test]
    fn secret_request_timeline_text_includes_the_label_and_every_status() {
        for status in ["pending", "saved", "declined", "cancelled"] {
            assert_eq!(
                turn_item_text(
                    &json!({"type":"secret_request","label":"Webhook key","secretStatus":status})
                ),
                Some(format!("Asked the user for Webhook key: {status}."))
            );
        }
    }

    fn with_pull_requests(links: &Value, include_links: bool) -> Value {
        let mut out = json!({});
        insert_pull_requests(&mut out, links, include_links);
        out
    }

    #[test]
    fn pull_requests_follow_the_t3_list_rules() {
        let links = json!([
            { "host": "GitHub.com ", "repository": "a/b", "number": 1, "url": "u1", "source": "agent",
              "snapshot": { "state": "open" }, "watch": { "startedAt": "2026-01-01T00:00:00.000Z" } },
            { "host": "github.com", "repository": "a/b", "number": 2, "url": "u2", "source": "agent",
              "snapshot": { "state": "merged" } },
            { "host": "github.com", "repository": "a/b", "number": 3, "url": "u3", "source": "stack-dismissed" },
        ]);
        // The dismissed link is hidden; the merged one counts but is not listed.
        assert_eq!(visible_pull_requests(&links).count(), 2);
        assert_eq!(
            with_pull_requests(&links, true),
            json!({ "pullRequestCount": 2, "openPullRequestCount": 1,
                    "pullRequests": [{ "host": "github.com", "repository": "a/b", "number": 1,
                     "url": "u1", "source": "agent", "state": "open", "watching": true,
                     "watchStartedAt": "2026-01-01T00:00:00.000Z" }] })
        );
        // A later page has the count only.
        assert_eq!(
            with_pull_requests(&links, false),
            json!({ "pullRequestCount": 2 })
        );
        assert_eq!(
            with_pull_requests(&Value::Null, true),
            json!({ "pullRequestCount": 0, "openPullRequestCount": 0, "pullRequests": [] })
        );
        assert_eq!(title_regeneration(&Value::Null), Value::Null);
        assert_eq!(
            title_regeneration(&json!({ "requestId": "r", "startedAt": "t", "x": 1 })),
            json!({ "requestId": "r", "startedAt": "t" })
        );
    }

    fn link(number: u64, updated: Option<&str>, linked: &str, watched: bool) -> Value {
        let mut link = json!({ "host": "github.com", "repository": "a/b", "number": number,
                               "url": format!("u{number}"), "source": "agent",
                               "linkedAt": linked, "snapshot": { "state": "open" } });
        if let Some(updated) = updated {
            link["snapshot"]["updatedAt"] = json!(updated);
        }
        if watched {
            link["watch"] = json!({ "startedAt": "2026-01-01T00:00:00.000Z" });
        }
        link
    }

    fn numbers(out: &Value) -> Vec<u64> {
        out["pullRequests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pr| pr["number"].as_u64().unwrap())
            .collect()
    }

    #[test]
    fn open_pull_requests_list_watched_first_then_newest_and_keep_five() {
        let day = |d: u32| format!("2026-02-{d:02}T00:00:00.000Z");
        // 1: old, unwatched. 2: watched, older than 3. 3: newest by snapshot. 4: no snapshot
        // time, so its link time counts. 5 and 6: fill the rest; 7: oldest of all.
        let links = Value::Array(vec![
            link(1, Some(&day(1)), &day(1), false),
            link(2, Some(&day(2)), &day(2), true),
            link(3, Some(&day(20)), &day(3), false),
            link(4, None, &day(15), false),
            link(5, Some(&day(10)), &day(10), false),
            link(6, Some(&day(9)), &day(9), false),
            link(7, Some("garbage"), &day(30), false),
        ]);
        let out = with_pull_requests(&links, true);
        assert_eq!(numbers(&out), vec![2, 3, 4, 5, 6]);
        assert_eq!(out["pullRequestCount"], 7);
        assert_eq!(out["openPullRequestCount"], 7);
        // A merged link counts as a link, not as an open one.
        let mut more = links.as_array().unwrap().clone();
        more.push(
            json!({ "host": "github.com", "repository": "a/b", "number": 8, "url": "u8",
                          "source": "agent", "snapshot": { "state": "closed" } }),
        );
        let out = with_pull_requests(&Value::Array(more), true);
        assert_eq!(
            (
                out["pullRequestCount"].as_u64(),
                out["openPullRequestCount"].as_u64()
            ),
            (Some(8), Some(7))
        );
        // Two watched links keep the newest first; ties keep their order.
        let links = json!([
            link(1, Some(&day(5)), &day(5), true),
            link(2, Some(&day(6)), &day(6), true),
            link(3, Some(&day(6)), &day(6), true),
        ]);
        assert_eq!(numbers(&with_pull_requests(&links, true)), vec![2, 3, 1]);
    }

    fn row(position: i64, kind: &str, title: Value, text: &str) -> Value {
        json!({ "position": position, "visibility": "visible", "sourceThreadId": "t",
                "sourceItemId": format!("i{position}"),
                "item": { "type": kind, "runId": "r", "status": "completed", "title": title,
                          "updatedAt": "2026-01-01T00:00:00.000Z", "text": text, "messageId": "m" } })
    }

    #[test]
    fn text_pages_count_utf16_units_and_keep_surrogate_pairs_whole() {
        // Three emoji: two UTF-16 units each.
        let r = row(1, "reasoning", Value::Null, "😀😀😀");
        let first = timeline_item(&r, &[], 3, 0);
        // A cut after one unit of the second emoji moves back to the pair's edge.
        assert_eq!(first["text"], "😀");
        assert_eq!(first["nextTextOffset"], 2);
        assert_eq!(first["textTruncated"], true);
        let second = timeline_item(&r, &[], 3, 2);
        assert_eq!(
            (second["text"].as_str(), second["nextTextOffset"].as_u64()),
            (Some("😀"), Some(4))
        );
        let last = timeline_item(&r, &[], 3, 4);
        assert_eq!(
            (last["text"].as_str(), last["textTruncated"].as_bool()),
            (Some("😀"), Some(false))
        );
        // One unit is not enough for a pair: the page takes the whole pair.
        assert_eq!(timeline_item(&r, &[], 1, 0)["text"], "😀");
        // A read past the end is empty, not truncated.
        let past = timeline_item(&r, &[], 3, 99);
        assert_eq!(
            (past["text"].as_str(), past["textTruncated"].as_bool()),
            (Some(""), Some(false))
        );
    }

    #[test]
    fn longest_fitting_is_the_t3_binary_search() {
        assert_eq!(longest_fitting(2, 100, |n| n <= 37), 37);
        assert_eq!(longest_fitting(2, 100, |_| false), 1);
        assert_eq!(longest_fitting(1, 0, |_| true), 0);
        assert_eq!(longest_fitting(2, 100, |_| true), 100);
    }

    #[test]
    fn an_oversized_item_is_cut_to_the_byte_budget() {
        // CJK text is three bytes per character: the budget counts bytes, not characters.
        let text = "漢".repeat(5_000);
        let r = row(1, "assistant_message", json!("title"), &text);
        let item = timeline_item_within(&r, &[], 5_000, 0, 2_000);
        assert!(json_bytes(&item) <= 2_000);
        assert!(
            json_bytes(&item) > 1_900,
            "the cut is the longest that fits"
        );
        assert_eq!(item["textTruncated"], true);
        let kept = item["text"].as_str().unwrap().chars().count();
        assert_eq!(item["nextTextOffset"], kept);
        // The next page starts where this one ended.
        assert_eq!(item["title"], "title");
        // A huge title shares the budget: it is cut to half, and the text keeps the rest.
        let r = row(1, "assistant_message", json!("T".repeat(10_000)), &text);
        let item = timeline_item_within(&r, &[], 5_000, 0, 2_000);
        assert!(json_bytes(&item) <= 2_000);
        let title_len = item["title"].as_str().unwrap().len();
        assert!(title_len > 500 && title_len < 1_000, "{title_len}");
        assert!(!item["text"].as_str().unwrap().is_empty());
        // An item that already fits stays whole.
        let small = row(1, "assistant_message", Value::Null, "short");
        assert_eq!(
            timeline_item_within(&small, &[], 500, 0, 2_000),
            timeline_item(&small, &[], 500, 0)
        );
    }
}
