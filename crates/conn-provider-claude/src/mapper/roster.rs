//! Claude's background roster, as `ClaudeAdapterV2.ts` keeps it per native thread
//! (`pendingBackgroundTasksByNativeThread`, `applyBackgroundTaskRosterMessage`): background
//! Bash calls and Monitors (`local_bash` tasks) from `task_started`, `task_notification` and
//! `background_tasks_changed`, published on `providerThread.pendingBackgroundTasks` with a
//! `provider_thread.updated` (`emitRosterUpdate`).
//!
//! Not here (see the crate README): awaited tasks (`awaitBackgroundTasks`), owed wake tasks,
//! the scheduled wakeup entry, and background subagents in the roster.

use std::collections::VecDeque;

use serde_json::{Value, json};

use super::{Env, Mapper, Out, emit};
use crate::DRIVER;
use crate::ids;
use crate::protocol::{Block, Inbound, SystemMsg, UserContent};
use conn_provider::ProviderEvent;

/// Tasks in the roster at once.
const ROSTER_CAP: usize = 64;
/// Remembered task → tool call links and open Monitor calls (T3 keeps 64 links).
const LINK_CAP: usize = 64;

#[derive(Debug, Default)]
pub(crate) struct Roster {
    /// `OrchestrationV2PendingBackgroundTask` values, in arrival order.
    tasks: Vec<Value>,
    /// `toolUseIdsByTaskId`.
    task_tools: VecDeque<(String, String)>,
    /// Monitor calls with no task yet (`claudeMonitors.calls`).
    monitor_calls: VecDeque<String>,
    /// Tasks a Monitor call started (`claudeMonitors.tasks`).
    monitor_tasks: VecDeque<String>,
    /// Tasks as last listed (`lastKnownOpaqueTasks`): an empty roster can come before a
    /// task's notification, and the wake still names the task.
    known: VecDeque<Value>,
    /// Tasks whose end will wake Claude (`wakeEligibleBackgroundTasksByNativeThread`).
    wake_eligible: VecDeque<String>,
    /// Tasks whose end arrived while idle and waits for its continuation
    /// (`opaqueBackgroundTaskReplayTombstonesByNativeThread`).
    tombstones: VecDeque<String>,
    /// Tasks the agent said it waits on (`awaitedBackgroundTasksByNativeThread`).
    awaited: VecDeque<String>,
}

fn add_id(set: &mut VecDeque<String>, id: &str) {
    if set.iter().any(|t| t == id) {
        return;
    }
    set.push_back(id.to_string());
    while set.len() > LINK_CAP {
        set.pop_front();
    }
}

impl Roster {
    pub(crate) fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    /// A Monitor's task is running.
    pub(crate) fn has_monitor(&self) -> bool {
        self.tasks.iter().any(|t| t["kind"] == "monitor")
    }

    /// `consumeWakeEligibilityForBufferedNotification`: a wake-eligible task's end, seen while
    /// idle, stays owed until its continuation takes it in. Returns whether it was eligible.
    pub(crate) fn consume_wake(&mut self, task_id: &str) -> bool {
        let before = self.wake_eligible.len();
        self.wake_eligible.retain(|t| t != task_id);
        if self.wake_eligible.len() == before {
            return false;
        }
        add_id(&mut self.tombstones, task_id);
        true
    }

    /// `isKnownOpaqueBackgroundTaskOnNativeThread`.
    pub(crate) fn is_known(&self, task_id: &str) -> bool {
        self.tasks.iter().any(|t| t["taskId"] == task_id)
            || self.wake_eligible.iter().any(|t| t == task_id)
            || self.tombstones.iter().any(|t| t == task_id)
    }

    pub(crate) fn clear_tombstones(&mut self) {
        self.tombstones.clear();
    }

    /// A stopped or failed turn takes the owed wakes with it.
    pub(crate) fn forget_wakes(&mut self) {
        self.wake_eligible.clear();
        self.tombstones.clear();
    }

    /// `owedWakeTasksForNativeThread`: tasks the thread last showed that left the roster but
    /// whose wake has not run yet.
    fn owed(&self, previous: Option<&Value>) -> Vec<Value> {
        let listed = |id: &Value| self.tasks.iter().any(|t| &t["taskId"] == id);
        previous
            .and_then(|p| p["pendingBackgroundTasks"].as_array())
            .into_iter()
            .flatten()
            .filter(|task| !listed(&task["taskId"]))
            .filter(|task| {
                task["taskId"].as_str().is_some_and(|id| {
                    self.wake_eligible.iter().any(|t| t == id)
                        || self.tombstones.iter().any(|t| t == id)
                })
            })
            .cloned()
            .collect()
    }

    /// `awaitBackgroundTasks`: the given ids that are on the roster, marked or unmarked.
    pub(crate) fn set_awaited(&mut self, task_ids: &[String], awaited: bool) -> Vec<String> {
        let mut matched: Vec<String> = Vec::new();
        for id in task_ids {
            if !matched.contains(id) && self.tasks.iter().any(|t| t["taskId"] == id.as_str()) {
                matched.push(id.clone());
            }
        }
        for id in &matched {
            if awaited {
                add_id(&mut self.awaited, id);
            } else {
                self.awaited.retain(|t| t != id);
            }
        }
        matched
    }

    /// What the provider thread lists: the roster (awaited ones marked), then the owed wakes
    /// (`publishedPendingBackgroundTasks`).
    pub(crate) fn published(&self, previous: Option<&Value>, scheduled: bool) -> Value {
        let mut tasks: Vec<Value> = self
            .tasks
            .iter()
            .map(|task| {
                let mut task = task.clone();
                if task["taskId"]
                    .as_str()
                    .is_some_and(|id| self.awaited.iter().any(|a| a == id))
                {
                    task["awaited"] = json!(true);
                }
                task
            })
            .collect();
        if scheduled {
            tasks.push(super::wakes::scheduled_wakeup_task());
        }
        tasks.extend(self.owed(previous));
        json!(tasks)
    }

    /// `rememberOpaqueTasks`.
    fn remember(&mut self, task: &Value) {
        self.known.retain(|k| k["taskId"] != task["taskId"]);
        self.known.push_back(task.clone());
        while self.known.len() > LINK_CAP {
            self.known.pop_front();
        }
        if let Some(id) = task["taskId"].as_str() {
            add_id(&mut self.wake_eligible, id);
        }
    }

    /// The task a notification ends, from the roster or as last known; it is forgotten then.
    pub(crate) fn wake_task(&mut self, task_id: &str) -> Option<Value> {
        let listed = self.tasks.iter().find(|t| t["taskId"] == task_id).cloned();
        let at = self.known.iter().position(|k| k["taskId"] == task_id);
        let known = at.and_then(|at| self.known.remove(at));
        listed.or(known)
    }

    #[cfg(test)]
    pub(crate) fn sizes(&self) -> usize {
        self.known.len()
            + self.awaited.len()
            + self.wake_eligible.len()
            + self.tombstones.len()
            + self.tasks.len()
            + self.task_tools.len()
            + self.monitor_calls.len()
            + self.monitor_tasks.len()
    }

    /// A new CLI process starts with no roster (`resetBackgroundTaskStateForNativeThreadProcess`).
    pub(crate) fn clear(&mut self) -> bool {
        let had = !self.tasks.is_empty();
        self.tasks.clear();
        self.monitor_tasks.clear();
        self.awaited.clear();
        had
    }

    fn link(&mut self, task_id: &str, tool_use_id: &str) {
        self.task_tools.retain(|(t, _)| t != task_id);
        self.task_tools
            .push_back((task_id.to_string(), tool_use_id.to_string()));
        while self.task_tools.len() > LINK_CAP {
            self.task_tools.pop_front();
        }
    }

    fn tool_of(&self, task_id: &str) -> Option<String> {
        self.task_tools
            .iter()
            .find(|(t, _)| t == task_id)
            .map(|(_, tool)| tool.clone())
            .or_else(|| {
                self.tasks
                    .iter()
                    .find(|t| t["taskId"] == task_id)
                    .and_then(|t| t["nativeItemId"].as_str().map(str::to_string))
            })
    }

    /// `isClaudeMonitorTask`: a task is a Monitor's when a Monitor call started it.
    fn is_monitor(&mut self, task_id: &str, tool_use_id: Option<&str>) -> bool {
        if self.monitor_tasks.iter().any(|t| t == task_id) {
            return true;
        }
        let Some(tool) = tool_use_id else {
            return false;
        };
        let Some(at) = self.monitor_calls.iter().position(|c| c == tool) else {
            return false;
        };
        self.monitor_calls.remove(at);
        self.monitor_tasks.push_back(task_id.to_string());
        while self.monitor_tasks.len() > LINK_CAP {
            self.monitor_tasks.pop_front();
        }
        true
    }

    fn upsert(&mut self, task: Value) {
        if let Some(slot) = self
            .tasks
            .iter_mut()
            .find(|t| t["taskId"] == task["taskId"])
        {
            *slot = task.clone();
        } else if self.tasks.len() < ROSTER_CAP {
            self.tasks.push(task.clone());
        } else {
            return;
        }
        self.remember(&task);
    }

    fn remove(&mut self, task_id: &str) -> bool {
        let before = self.tasks.len();
        self.tasks.retain(|t| t["taskId"] != task_id);
        self.monitor_tasks.retain(|t| t != task_id);
        self.awaited.retain(|t| t != task_id);
        self.tasks.len() != before
    }

    /// `trackClaudeMonitorCalls`: Monitor calls open; their tool results close them.
    pub(crate) fn track_monitor_calls(&mut self, message: &Inbound) {
        let (started, returned): (Vec<&str>, Vec<&str>) = match message {
            Inbound::Assistant(m) => (
                m.message
                    .content
                    .iter()
                    .filter_map(|b| match b {
                        Block::ToolUse { id, name, .. } if name == "Monitor" => Some(id.as_str()),
                        _ => None,
                    })
                    .collect(),
                tool_results(&m.message.content),
            ),
            Inbound::User(m) => match &m.message.content {
                UserContent::Blocks(blocks) => (Vec::new(), tool_results(blocks)),
                UserContent::Text(_) => return,
            },
            _ => return,
        };
        for id in started {
            let linked = self
                .task_tools
                .iter()
                .any(|(t, tool)| tool == id && self.monitor_tasks.iter().any(|m| m == t));
            if !linked && !self.monitor_calls.iter().any(|c| c == id) {
                self.monitor_calls.push_back(id.to_string());
                while self.monitor_calls.len() > LINK_CAP {
                    self.monitor_calls.pop_front();
                }
            }
        }
        for id in returned {
            self.monitor_calls.retain(|c| c != id);
        }
    }
}

fn tool_results(content: &[Block]) -> Vec<&str> {
    content
        .iter()
        .filter_map(|b| match b {
            Block::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
            _ => None,
        })
        .collect()
}

fn text(value: Option<&Value>) -> Option<&str> {
    value?.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// `claudePendingBackgroundTask`.
fn pending_task(
    task_id: &str,
    monitor: bool,
    description: Option<&str>,
    parent_task_id: Option<&Value>,
    tool_use_id: Option<&str>,
) -> Value {
    let mut task = json!({"taskId": task_id, "kind": if monitor { "monitor" } else { "command" }});
    if let Some(description) = description.filter(|d| !d.trim().is_empty()) {
        task["description"] = json!(description);
    }
    if let Some(parent) = text(parent_task_id) {
        task["parentTaskId"] = json!(parent);
    }
    if let Some(tool) = tool_use_id {
        task["nativeItemId"] = json!(tool);
    }
    task
}

impl<E: Env> Mapper<E> {
    /// `applyBackgroundTaskRosterMessage` for one system frame. Returns whether the frame was
    /// a roster frame (`background_tasks_changed` is nothing else).
    pub(super) fn apply_roster(&mut self, msg: &SystemMsg, out: &mut Vec<Out>) -> bool {
        let changed = match msg.subtype.as_str() {
            "background_tasks_changed" => {
                let Some(entries) = msg.tasks.as_ref().and_then(Value::as_array) else {
                    return true;
                };
                let listed: Vec<&str> = entries
                    .iter()
                    .filter_map(|e| e.get("task_id").and_then(Value::as_str))
                    .collect();
                self.roster
                    .monitor_tasks
                    .retain(|t| listed.contains(&t.as_str()));
                let mut next = Vec::new();
                for entry in entries {
                    let Some(task_id) = text(entry.get("task_id")) else {
                        continue;
                    };
                    if entry.get("task_type").and_then(Value::as_str) != Some("local_bash") {
                        continue;
                    }
                    let monitor = self.roster.monitor_tasks.iter().any(|t| t == task_id);
                    let tool = self.roster.tool_of(task_id);
                    let mut task = pending_task(
                        task_id,
                        monitor,
                        entry.get("description").and_then(Value::as_str),
                        entry.get("parent_task_id"),
                        tool.as_deref(),
                    );
                    // `replacePendingBackgroundTasks` keeps what it knew of a listed task.
                    if let Some(previous) =
                        self.roster.tasks.iter().find(|t| t["taskId"] == task_id)
                        && let (Some(prev), Some(new)) =
                            (previous.as_object(), task.as_object_mut())
                    {
                        for (key, value) in prev {
                            new.entry(key.clone()).or_insert_with(|| value.clone());
                        }
                    }
                    next.push(task);
                }
                next.truncate(ROSTER_CAP);
                for task in &next {
                    self.roster.remember(task);
                }
                // T3 sends the thread for every such frame, changed or not.
                let tasks = &next;
                self.roster
                    .awaited
                    .retain(|a| tasks.iter().any(|t| t["taskId"] == a.as_str()));
                self.roster.tasks = next;
                true
            }
            "task_started" if msg.task_type.as_deref() == Some("local_bash") => {
                let Some(task_id) = msg.task_id.as_deref() else {
                    return false;
                };
                let tool = msg
                    .tool_use_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty());
                if let Some(tool) = tool {
                    self.roster.link(task_id, tool);
                }
                if msg.is_backgrounded == Some(false) {
                    return false;
                }
                let monitor = self.roster.is_monitor(task_id, tool);
                let mut task = pending_task(
                    task_id,
                    monitor,
                    msg.description.as_deref(),
                    msg.parent_task_id.as_ref(),
                    tool,
                );
                // The launching command's row, when it is a command of the running turn.
                if let (Some(turn), Some(tool)) = (&self.turn, tool)
                    && let Some(call) = turn.tools.get(tool)
                    && super::classify_tool(&call.name).0 == "command_execution"
                    && let Some(command) = text(call.input.get("command"))
                {
                    task["itemId"] = json!(ids::turn_item_from_item(DRIVER, tool));
                    task["sourceThreadId"] = json!(turn.thread_id);
                    task["command"] = json!(command);
                }
                self.roster.upsert(task);
                true
            }
            "task_notification" => {
                let Some(task_id) = msg.task_id.as_deref() else {
                    return false;
                };
                self.roster.monitor_tasks.retain(|t| t != task_id);
                self.roster.task_tools.retain(|(t, _)| t != task_id);
                self.roster.wake_eligible.retain(|t| t != task_id);
                self.roster.remove(task_id)
            }
            _ => return false,
        };
        if changed {
            self.emit_roster(out);
        }
        msg.subtype == "background_tasks_changed"
    }

    /// `awaitBackgroundTasks` for the session's native thread. Returns the matched ids.
    pub(crate) fn await_background_tasks(
        &mut self,
        provider_thread: &Value,
        task_ids: &[String],
        awaited: bool,
    ) -> (Vec<String>, Vec<Out>) {
        let mut out = Vec::new();
        if provider_thread["nativeThreadRef"]["nativeId"]
            .as_str()
            .is_none()
        {
            return (Vec::new(), out);
        }
        let matched = self.roster.set_awaited(task_ids, awaited);
        if !matched.is_empty() {
            self.emit_roster(&mut out);
        }
        (matched, out)
    }

    /// `emitRosterUpdate`: the provider thread with the roster. Idle with no turn running;
    /// with one, `active` in place of `idle`.
    pub(super) fn emit_roster(&mut self, out: &mut Vec<Out>) {
        let base = match &self.turn {
            Some(turn) => Some(turn.provider_thread.clone()),
            None => self.last_provider_thread.clone(),
        };
        let Some(mut thread) = base else {
            return;
        };
        let status = if self.turn.is_none() {
            json!("idle")
        } else if thread["status"] == "idle" {
            json!("active")
        } else {
            thread["status"].clone()
        };
        thread["providerSessionId"] = json!(self.provider_session_id);
        thread["status"] = status;
        thread["pendingBackgroundTasks"] = self.roster.published(
            self.last_provider_thread.as_ref(),
            self.scheduled.due.is_some(),
        );
        thread["updatedAt"] = json!(self.env.now());
        self.last_provider_thread = Some(thread.clone());
        emit(
            out,
            |v| ProviderEvent::ProviderThreadUpdated { provider_thread: v },
            thread,
        );
    }
}
