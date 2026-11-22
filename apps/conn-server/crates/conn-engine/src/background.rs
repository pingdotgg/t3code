//! `derivePendingBackgroundWork` (`packages/shared/src/orchestrationV2PendingBackgroundWork.ts`):
//! the work a thread still has running after its latest run settled. The shell row carries it
//! as `pendingBackgroundTasks`; `/mcp` reads it for the live-caller rule and its thread views.
//!
//! The sources, in T3's order: the rosters providers report on their provider threads
//! (`pendingBackgroundTasks`), then background turn items that are still running (commands,
//! dynamic tools, subagents), then pull request watches.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

/// `BACKGROUND_TURN_ITEM_TYPES`.
pub(crate) const BACKGROUND_ITEM_TYPES: [&str; 3] =
    ["command_execution", "dynamic_tool", "subagent"];
/// `isOrchestrationV2WorkActive`.
pub(crate) const ACTIVE_WORK_STATUSES: [&str; 3] = ["pending", "running", "waiting"];
/// `SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES`.
const SETTLED_RUN_STATUSES: [&str; 5] =
    ["cancelled", "completed", "failed", "interrupted", "waiting"];
/// `PULL_REQUEST_WATCH_TASK_ID`.
pub(crate) const PULL_REQUEST_WATCH_TASK_ID: &str = "pull-request-watch:";

/// What `derivePendingBackgroundWork` reads.
pub(crate) struct BackgroundInput<'a> {
    /// The latest run that started.
    pub latest_run: Option<&'a Value>,
    /// A run is `preparing`, `starting` or `running`.
    pub has_active_run: bool,
    pub provider_threads: &'a [Value],
    /// Turn items; only background types in an active status count.
    pub turn_items: &'a [Value],
    pub active_provider_thread_id: Option<&'a str>,
    /// Ids of rolled-back runs: their items hold nothing.
    pub rolled_back_run_ids: &'a HashSet<String>,
    pub pull_requests: &'a [Value],
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn trimmed(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|t| !t.is_empty())
}

/// `pendingBackgroundTurnItems`.
pub(crate) fn pending_background_items<'a>(
    turn_items: &'a [Value],
    rolled_back_run_ids: &HashSet<String>,
) -> impl Iterator<Item = &'a Value> {
    turn_items.iter().filter(move |item| {
        let ty = str_of(item, "type").unwrap_or_default();
        let persistent =
            ty == "dynamic_tool" && item.pointer("/input/persistent") == Some(&Value::Bool(true));
        BACKGROUND_ITEM_TYPES.contains(&ty)
            && ACTIVE_WORK_STATUSES.contains(&str_of(item, "status").unwrap_or_default())
            && !persistent
            && str_of(item, "runId").is_none_or(|run| !rolled_back_run_ids.contains(run))
    })
}

/// `descriptionFromTurnItem`.
fn item_description(item: &Value) -> Option<String> {
    if let Some(title) = trimmed(str_of(item, "title")) {
        return Some(title.to_owned());
    }
    let field = match str_of(item, "type") {
        Some("command_execution") => "input",
        Some("dynamic_tool") => "toolName",
        Some("subagent") => "prompt",
        _ => return None,
    };
    trimmed(str_of(item, field)).map(str::to_owned)
}

/// `pendingTaskFromTurnItem`. `owner` is the instance of the item's provider thread.
fn task_from_item(task_id: &str, item: &Value, owner: Option<&Value>) -> Value {
    let mut task = Map::new();
    task.insert("taskId".into(), json!(task_id));
    if let Some(description) = item_description(item) {
        task.insert("description".into(), json!(description));
    }
    let kind = match str_of(item, "type") {
        Some("subagent") => {
            if let Some(owner) = owner {
                task.insert("providerInstanceId".into(), owner.clone());
            }
            if let Some(child) = item.get("childThreadId").filter(|c| c.is_string()) {
                task.insert("childThreadId".into(), child.clone());
            }
            "subagent"
        }
        Some("command_execution") if item.get("monitor") == Some(&Value::Bool(true)) => "monitor",
        Some("command_execution") => "command",
        _ => "background_task",
    };
    task.insert("kind".into(), json!(kind));
    Value::Object(task)
}

/// `nativeTaskIdFromTurnItem`.
fn item_task_id(item: &Value) -> String {
    item.pointer("/nativeItemRef/nativeId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .or_else(|| str_of(item, "id"))
        .unwrap_or_default()
        .to_owned()
}

/// `pullRequestWatchTasks`.
fn pull_request_watch_tasks(pull_requests: &[Value]) -> Vec<Value> {
    pull_requests
        .iter()
        .filter(|link| {
            link.get("watch").is_some_and(|w| !w.is_null())
                && str_of(link, "source") != Some("stack-dismissed")
                && link.pointer("/snapshot/state").and_then(Value::as_str) != Some("merged")
        })
        .map(|link| {
            let number = &link["number"];
            let mut task = json!({
                "taskId": format!(
                    "{PULL_REQUEST_WATCH_TASK_ID}{}/{}#{number}",
                    str_of(link, "host").unwrap_or_default().to_lowercase(),
                    str_of(link, "repository").unwrap_or_default().to_lowercase(),
                ),
                "description": format!("Watching pull request #{number}"),
                "kind": "monitor",
            });
            if link.pointer("/watch/checksPending") != Some(&Value::Bool(false))
                && let Some(task) = task.as_object_mut()
            {
                task.insert("awaited".into(), json!(true));
            }
            task
        })
        .collect()
}

/// `derivePendingBackgroundWork`.
pub(crate) fn derive_pending_background_work(input: &BackgroundInput<'_>) -> Vec<Value> {
    if input.has_active_run {
        return vec![];
    }
    let Some(latest_run) = input.latest_run else {
        return pull_request_watch_tasks(input.pull_requests);
    };
    if !SETTLED_RUN_STATUSES.contains(&str_of(latest_run, "status").unwrap_or_default()) {
        return vec![];
    }
    let mut tasks: Vec<Value> = Vec::new();
    let has = |tasks: &[Value], id: &str| tasks.iter().any(|t| str_of(t, "taskId") == Some(id));
    let provider_threads = input.provider_threads.iter().filter(|thread| {
        input
            .active_provider_thread_id
            .is_none_or(|active| str_of(thread, "id") == Some(active))
    });
    for provider_thread in provider_threads {
        let roster = provider_thread
            .get("pendingBackgroundTasks")
            .and_then(Value::as_array);
        for task in roster.into_iter().flatten() {
            let Some(task_id) = str_of(task, "taskId").filter(|id| !id.is_empty()) else {
                continue;
            };
            if has(&tasks, task_id) {
                continue;
            }
            let mut named = task.as_object().cloned().unwrap_or_default();
            named.remove("description");
            if str_of(task, "kind") == Some("subagent") {
                named.insert(
                    "providerInstanceId".into(),
                    provider_thread["providerInstanceId"].clone(),
                );
            }
            if let Some(description) = trimmed(str_of(task, "description")) {
                named.insert("description".into(), json!(description));
            }
            tasks.push(Value::Object(named));
        }
    }
    for item in pending_background_items(input.turn_items, input.rolled_back_run_ids) {
        let task_id = item_task_id(item);
        if has(&tasks, &task_id) {
            continue;
        }
        let owner = str_of(item, "providerThreadId").and_then(|id| {
            input
                .provider_threads
                .iter()
                .find(|t| str_of(t, "id") == Some(id))
                .map(|t| &t["providerInstanceId"])
                .filter(|v| v.is_string())
        });
        let task = task_from_item(&task_id, item, owner);
        tasks.push(task);
    }
    for task in pull_request_watch_tasks(input.pull_requests) {
        let id = str_of(&task, "taskId").unwrap_or_default().to_owned();
        tasks.retain(|t| str_of(t, "taskId") != Some(&id));
        tasks.push(task);
    }
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        latest_run: Option<&'a Value>,
        provider_threads: &'a [Value],
        turn_items: &'a [Value],
        empty: &'a HashSet<String>,
    ) -> BackgroundInput<'a> {
        BackgroundInput {
            latest_run,
            has_active_run: false,
            provider_threads,
            turn_items,
            active_provider_thread_id: None,
            rolled_back_run_ids: empty,
            pull_requests: &[],
        }
    }

    #[test]
    fn a_settled_run_reports_running_background_items_and_rosters() {
        let empty = HashSet::new();
        let run = json!({"id": "r1", "status": "completed"});
        let threads = [json!({
            "id": "pt1", "providerInstanceId": "claudeAgent",
            "pendingBackgroundTasks": [{"taskId": "a1", "kind": "subagent", "description": "  sub  "}],
        })];
        let items = [
            json!({"id": "i1", "type": "command_execution", "status": "running", "title": null,
                   "input": " sleep 9 ", "runId": "r1", "providerThreadId": "pt1",
                   "nativeItemRef": {"nativeId": "toolu_1"}}),
            json!({"id": "i2", "type": "command_execution", "status": "completed", "title": null}),
            json!({"id": "i3", "type": "subagent", "status": "running", "title": null,
                   "prompt": "go", "childThreadId": "c1", "providerThreadId": "pt1"}),
        ];
        let tasks = derive_pending_background_work(&input(Some(&run), &threads, &items, &empty));
        assert_eq!(
            tasks,
            [
                json!({"taskId": "a1", "kind": "subagent", "providerInstanceId": "claudeAgent", "description": "sub"}),
                json!({"taskId": "toolu_1", "description": "sleep 9", "kind": "command"}),
                json!({"taskId": "i3", "description": "go", "providerInstanceId": "claudeAgent", "childThreadId": "c1", "kind": "subagent"}),
            ]
        );
        // A running run holds nothing as background work yet.
        let running = json!({"id": "r1", "status": "running"});
        assert!(
            derive_pending_background_work(&input(Some(&running), &threads, &items, &empty))
                .is_empty()
        );
    }
}
