//! Background work of a flavor with `deferFinalizeForBackgroundWork` and
//! `enablePostSettleContinuation` (Grok): background shell tasks and monitors outlive the
//! prompt, the turn finalizes once they end (after T3's 3 s debounce), and the agent's own
//! wake turn after the settle is buffered and replayed by a continuation turn that sends no
//! prompt. The rules follow `makeAcpAdapterV2` (`adapter.ts`): `emitTool`'s background part,
//! `hasDeferredBackgroundWork`, `scheduleDeferredFinalize`, `bufferPostSettleWake`,
//! `offerContinuationRun`, `applyLateBackgroundMutation`, `finishRegisteredBackgroundTool`, the
//! `applyBackgroundTaskMutation` extension callback and the continuation branch of
//! `startTurnUnlocked`.
//!
//! Bounds: per turn, the maps hold one entry per background tool of the turn and go with it.
//! Per session, the task id sets hold at most [`TASK_IDS_KEPT`] ids (T3: no bound), the ended
//! tombstones [`ENDED_TASKS_KEPT`] (as T3), and the wake buffer [`WAKE_FRAMES_KEPT`] frames
//! (T3: no bound); a frame past the bound is dropped and logged.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Value, json};

use super::{Mapper, Out, content_display_text};
use crate::flavor::BackgroundHooks;
use crate::grok_background::{Lifecycle, ReportKind, TaskStatus};
use crate::tools::{self, ToolState};
use conn_provider_support::ids::Env;

/// `endedDetachedBackgroundCommandLimit`.
const ENDED_DETACHED_KEPT: usize = 16;
/// `endedBackgroundTaskIdLimit`.
const ENDED_TASKS_KEPT: usize = 128;
/// Our bound on the running, handled and unreported task id sets.
const TASK_IDS_KEPT: usize = 256;
/// Our bound on the buffered wake frames.
const WAKE_FRAMES_KEPT: usize = 4096;
/// `markAwaitingBackgroundHydration`'s wait.
pub(crate) const HYDRATION_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
/// `markPendingInjectedReport`'s wait.
pub(crate) const INJECTED_REPORT_WAIT: std::time::Duration = std::time::Duration::from_secs(25);

/// A recorded background command end (`backgroundCommands` value).
#[derive(Clone, Debug)]
pub(super) struct CommandEnd {
    status: TaskStatus,
    output: Option<String>,
}

/// The background part of `ActiveAcpTurn`.
#[derive(Debug, Default)]
pub(super) struct TurnBackground {
    /// `backgroundCommands`, in insertion order: task id → its end once known.
    commands: Vec<(String, Option<CommandEnd>)>,
    /// `backgroundCommandTaskId` of each tool call.
    command_of_tool: HashMap<String, String>,
    /// `toolCallIdsByBackgroundTaskId`.
    tool_of_task: HashMap<String, String>,
    /// `persistentBackgroundTaskIds`.
    persistent: HashSet<String>,
    /// `awaitingBackgroundHydration`.
    awaiting_hydration: HashSet<String>,
    /// `pendingInjectedReport`.
    pending_injected_report: HashSet<String>,
    early_injected_report_observed: bool,
    pub(super) prompt_settled: bool,
    pub(super) prompt_settled_status: Option<String>,
    /// `backgroundFinalizeGeneration`.
    finalize_generation: u64,
    /// A provider continuation turn (no prompt; it replays the wake buffer).
    pub(super) continuation: bool,
}

impl TurnBackground {
    pub(super) fn new(continuation: bool) -> Self {
        Self {
            continuation,
            ..Self::default()
        }
    }

    fn command_end(&self, task_id: &str) -> Option<&Option<CommandEnd>> {
        self.commands
            .iter()
            .find(|(id, _)| id == task_id)
            .map(|(_, end)| end)
    }

    fn set_command_end(&mut self, task_id: &str, end: Option<CommandEnd>) {
        match self.commands.iter_mut().find(|(id, _)| id == task_id) {
            Some(entry) => entry.1 = end,
            None => self.commands.push((task_id.to_owned(), end)),
        }
    }
}

/// The session-wide background state of `makeAcpAdapterV2`.
#[derive(Debug, Default)]
pub(super) struct SessionBackground {
    /// `runningBackgroundTaskIds`.
    running: HashSet<String>,
    /// `endedBackgroundTaskIds`: tombstones, oldest first.
    ended: VecDeque<String>,
    /// `handledBackgroundTaskIdsInActiveTurn`.
    handled: HashSet<String>,
    /// `midTurnUnreportedCompletedTaskIds`.
    unreported: HashSet<String>,
    /// `wakeBuffer`: whole `session/update` params.
    wake_buffer: VecDeque<Value>,
    /// `continuationRequested`.
    continuation_requested: bool,
    /// `lastTurnRoute`: (thread id, provider thread id).
    route: Option<(String, String)>,
    /// `suppressPostSettleMonitorPrompt`.
    suppress_monitor_prompt: bool,
    /// `stoppedRunQuarantine`.
    pub(super) quarantined: bool,
    /// `continuationClosed`.
    closed: bool,
    /// `detachedBackgroundCommands`' keys: task id → the `seq` of the completed turn that owns
    /// its row, oldest first. Running ones stay; ended ones are bounded by
    /// [`ENDED_DETACHED_KEPT`], so a later authoritative end still corrects the row.
    detached: VecDeque<(String, u64)>,
}

/// A timer the session runs for the mapper; it comes back through [`Mapper::timer_fired`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Timer {
    /// `scheduleDeferredFinalize` (the debounce is the session's).
    Finalize { turn: u64, generation: u64 },
    /// `markAwaitingBackgroundHydration` (60 s).
    Hydration { turn: u64, task_id: String },
    /// `markPendingInjectedReport` (25 s).
    InjectedReport { turn: u64, task_id: String },
}

/// What `bufferPostSettleWake` decided.
#[derive(Debug, Default, Clone, Copy)]
struct WakeOutcome {
    #[expect(
        dead_code,
        reason = "read by the subagent carryover rules, not built yet"
    )]
    buffered: bool,
    offer: bool,
    stop: bool,
}

fn insert_bounded(set: &mut HashSet<String>, id: &str) -> bool {
    if set.contains(id) {
        return true;
    }
    if set.len() >= TASK_IDS_KEPT {
        return false;
    }
    set.insert(id.to_owned());
    true
}

/// `toolStatus` of a tool state: `pending`, `running` or a terminal status.
fn open(tool: &ToolState) -> bool {
    matches!(
        tools::item_status(tool.status.as_deref()),
        "pending" | "running"
    )
}

/// `toolOutputText`.
fn output_text(tool: &ToolState) -> String {
    tools::tool_output_text(tool)
}

impl<E: Env> Mapper<E> {
    fn hooks(&self) -> Option<BackgroundHooks> {
        self.flavor.background
    }

    /// The session's ACP session id (`activeSessionId`).
    pub(crate) fn set_root_session(&mut self, session_id: &str) {
        self.root_session = Some(session_id.to_owned());
    }

    pub(super) fn is_root(&self, session_id: &str) -> bool {
        self.root_session.as_deref() == Some(session_id)
    }

    // ---- task sets -------------------------------------------------------------------------

    /// `setBackgroundTaskRunning`.
    fn set_task_running(&mut self, task_id: &str, running: bool) {
        if running {
            if self.bg.ended.iter().any(|id| id == task_id) {
                return;
            }
            if !insert_bounded(&mut self.bg.running, task_id) {
                self.skip("a background task past the bound");
            }
        } else {
            self.bg.running.remove(task_id);
        }
    }

    /// `markBackgroundTaskEnded`.
    fn mark_task_ended(&mut self, task_id: &str) {
        if !self.bg.ended.iter().any(|id| id == task_id) {
            if self.bg.ended.len() >= ENDED_TASKS_KEPT {
                self.bg.ended.pop_front();
            }
            self.bg.ended.push_back(task_id.to_owned());
        }
        self.set_task_running(task_id, false);
    }

    /// `applyBackgroundTaskMutationRunning`.
    fn apply_task_running(&mut self, task_id: &str, status: TaskStatus) {
        if status == TaskStatus::Running {
            self.set_task_running(task_id, true);
        } else {
            self.mark_task_ended(task_id);
        }
    }

    fn mark_handled(&mut self, task_id: &str) {
        insert_bounded(&mut self.bg.handled, task_id);
        self.bg.unreported.remove(task_id);
    }

    fn task_ended(&self, task_id: &str) -> bool {
        self.bg.ended.iter().any(|id| id == task_id)
    }

    /// Tool states of a `tool_call` / `tool_call_update`, normalized by the flavor.
    fn tool_states(&self, update: &Value) -> Vec<ToolState> {
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if kind != "tool_call" && kind != "tool_call_update" {
            return Vec::new();
        }
        let fallback = (kind == "tool_call").then_some("pending");
        tools::parse_tool_call(update, fallback)
            .map(|tool| match self.flavor.normalize_tool {
                Some(normalize) => normalize(tool),
                None => tool,
            })
            .into_iter()
            .collect()
    }

    /// `trackRunningBackgroundTools`.
    fn track_running_background_tools(&mut self, update: &Value) {
        let Some(hooks) = self.hooks() else { return };
        for tool in self.tool_states(update) {
            if let Some(task_id) = (hooks.task_id)(&tool) {
                self.set_task_running(&task_id, open(&tool));
            }
        }
    }

    // ---- deferred finalize -----------------------------------------------------------------

    /// `hasDeferredBackgroundWork`.
    pub(super) fn has_deferred_work(&self) -> bool {
        let Some(turn) = self.turn.as_ref() else {
            return false;
        };
        let bg = &turn.bg;
        if !bg.awaiting_hydration.is_empty() || !bg.pending_injected_report.is_empty() {
            return true;
        }
        // Commands are as often a dev server as a wait; only their wake follows up.
        bg.tool_of_task.iter().any(|(task_id, tool_call_id)| {
            !bg.persistent.contains(task_id)
                && bg.command_end(task_id).is_none()
                && turn.tools.get(tool_call_id).is_some_and(open)
        }) || self.subagents_block_settlement()
    }

    /// `rearmDeferredFinalize`.
    pub(super) fn rearm_deferred_finalize(&mut self, out: &mut Vec<Out>) {
        if self.hooks().is_none() {
            return;
        }
        let settled = self.turn.as_ref().is_some_and(|t| t.bg.prompt_settled);
        if !settled || self.has_deferred_work() {
            return;
        }
        self.schedule_deferred_finalize(out);
    }

    /// `scheduleDeferredFinalize`.
    fn schedule_deferred_finalize(&mut self, out: &mut Vec<Out>) {
        if self.hooks().is_none() || self.has_deferred_work() {
            return;
        }
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if !turn.bg.prompt_settled || turn.interrupted {
            return;
        }
        turn.bg.finalize_generation += 1;
        out.push(Out::Timer(Timer::Finalize {
            turn: turn.seq,
            generation: turn.bg.finalize_generation,
        }));
    }

    /// A timer the session ran for this mapper.
    pub(crate) fn timer_fired(&mut self, timer: Timer) -> Vec<Out> {
        let mut out = Vec::new();
        let current = self.turn.as_ref().map(|t| t.seq);
        match timer {
            Timer::Finalize { turn, generation } => {
                let Some(t) = self.turn.as_ref() else {
                    return out;
                };
                if current != Some(turn) || t.interrupted || t.bg.finalize_generation != generation
                {
                    return out;
                }
                if self.has_deferred_work() {
                    return out;
                }
                let status =
                    t.bg.prompt_settled_status
                        .clone()
                        .unwrap_or_else(|| "completed".into());
                // The 50 ms text flush is due long before the 3 s debounce; T3's test clock
                // fires it on the same advance.
                out = self.flush_text();
                // So is the 400 ms subagent flush.
                out.extend(self.flush_subagent_text());
                out.extend(self.finalize(&status, None));
            }
            Timer::Hydration { turn, task_id } => {
                if current != Some(turn) {
                    return out;
                }
                let Some(t) = self.turn.as_mut() else {
                    return out;
                };
                if !t.bg.awaiting_hydration.remove(&task_id) {
                    return out;
                }
                let tool =
                    t.bg.tool_of_task
                        .get(&task_id)
                        .and_then(|id| t.tools.get(id))
                        .cloned();
                if let Some(mut tool) = tool.filter(open) {
                    tool.status = Some("completed".into());
                    self.tool_updated(tool, None, &mut out);
                }
                self.rearm_deferred_finalize(&mut out);
            }
            Timer::InjectedReport { turn, task_id } => {
                if current != Some(turn) {
                    return out;
                }
                let removed = self
                    .turn
                    .as_mut()
                    .is_some_and(|t| t.bg.pending_injected_report.remove(&task_id));
                if removed {
                    self.rearm_deferred_finalize(&mut out);
                }
            }
        }
        out
    }

    fn mark_awaiting_hydration(&mut self, task_id: &str, out: &mut Vec<Out>) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if turn.bg.awaiting_hydration.insert(task_id.to_owned()) {
            out.push(Out::Timer(Timer::Hydration {
                turn: turn.seq,
                task_id: task_id.to_owned(),
            }));
        }
    }

    fn mark_pending_injected_report(&mut self, task_id: &str, out: &mut Vec<Out>) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if !turn.bg.prompt_settled {
            return;
        }
        if turn.bg.pending_injected_report.insert(task_id.to_owned()) {
            out.push(Out::Timer(Timer::InjectedReport {
                turn: turn.seq,
                task_id: task_id.to_owned(),
            }));
        }
    }

    // ---- tools -----------------------------------------------------------------------------

    /// `emitTool`'s background part, between the merge and the persist rule. Returns the tool
    /// to store and emit (a recorded command end replaces a replayed start ACK).
    pub(super) fn background_tool(
        &mut self,
        mut tool: ToolState,
        previous: Option<&ToolState>,
        projected: Option<&str>,
        out: &mut Vec<Out>,
    ) -> (ToolState, bool) {
        let Some(hooks) = self.hooks() else {
            return (tool, false);
        };
        let task_id = (hooks.task_id)(&tool);
        let Some(turn) = self.turn.as_mut() else {
            return (tool, false);
        };
        let command_task_id = if (hooks.is_command)(&tool) {
            task_id.clone()
        } else {
            previous.and_then(|p| turn.bg.command_of_tool.get(&p.tool_call_id).cloned())
        };
        if let Some(command) = &command_task_id {
            if turn.bg.command_end(command).is_none() {
                turn.bg.set_command_end(command, None);
            }
            turn.bg
                .command_of_tool
                .insert(tool.tool_call_id.clone(), command.clone());
        }
        let end = if turn.bg.prompt_settled {
            command_task_id
                .as_deref()
                .and_then(|c| turn.bg.command_end(c).cloned().flatten())
        } else {
            None
        };
        if let Some(end) = end {
            if task_id.is_some()
                && let Some(output) = &end.output
            {
                tool = tools::set_output_text(tool, output);
            }
            tool.status = Some(end.status.tool_status().into());
        }
        turn.tools.insert(tool.tool_call_id.clone(), tool.clone());
        if let Some(task_id) = &task_id {
            turn.bg
                .tool_of_task
                .insert(task_id.clone(), tool.tool_call_id.clone());
            if (hooks.is_persistent)(&tool) {
                turn.bg.persistent.insert(task_id.clone());
            }
            let status = projected.unwrap_or_else(|| tools::item_status(tool.status.as_deref()));
            let running = matches!(status, "pending" | "running");
            let settled = turn.bg.prompt_settled;
            self.set_task_running(task_id, running);
            if !settled && !running {
                self.mark_handled(task_id);
            }
        }
        if projected.is_some() {
            return (tool, false);
        }
        let mut hydrated_monitor = false;
        for completion in (hooks.completions)(&tool) {
            self.apply_task_running(&completion.task_id, completion.status);
            if completion.status != TaskStatus::Running {
                self.mark_handled(&completion.task_id);
                if let Some(turn) = self.turn.as_mut() {
                    turn.bg.awaiting_hydration.remove(&completion.task_id);
                }
            }
            let Some(turn) = self.turn.as_ref() else {
                break;
            };
            // The completed turn that owns a detached command's row takes its end.
            let owner = (!turn.bg.tool_of_task.contains_key(&completion.task_id))
                .then(|| self.detached_turn_of(&completion.task_id))
                .flatten();
            let found = match owner {
                Some(seq) => self
                    .with_detached(seq, |m| {
                        m.hydrate_target(&completion, &tool.tool_call_id, out)
                    })
                    .unwrap_or(false),
                None => self.hydrate_target(&completion, &tool.tool_call_id, out),
            };
            if found {
                hydrated_monitor = true;
            }
        }
        (tool, hydrated_monitor)
    }

    /// `emitTool`'s subagent part: a spawn or hydration tool becomes the subagent, not a
    /// tool row. Returns `true` when the tool is not emitted.
    pub(super) fn subagent_tool(
        &mut self,
        tool: &ToolState,
        hydrated_monitor: bool,
        out: &mut Vec<Out>,
    ) -> bool {
        let Some(hooks) = self.hooks() else {
            return false;
        };
        // Monitor TaskOutput resembles subagent hydration; it invents no subagent.
        if hydrated_monitor {
            return false;
        }
        let Some(update) = (hooks.subagent)(tool) else {
            return false;
        };
        let suppress = update.suppress_normal_tool;
        self.emit_subagent(update, out);
        if suppress {
            self.rearm_deferred_finalize(out);
        }
        suppress
    }

    /// `acpCompletedTurnShouldTerminalizeTool`'s background part: background tools stay open
    /// when the turn completes.
    pub(super) fn is_background_tool(&self, tool: &ToolState) -> bool {
        self.hooks().is_some_and(|hooks| {
            (hooks.task_id)(tool).is_some() || (hooks.subagent)(tool).is_some()
        })
    }

    /// `finishRegisteredBackgroundTool`: a structured task end, once the prompt settled.
    fn finish_registered_background_tool(
        &mut self,
        task_id: &str,
        status: TaskStatus,
        output: Option<String>,
        out: &mut Vec<Out>,
    ) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if !turn.bg.prompt_settled {
            return;
        }
        let Some(tool) = turn
            .bg
            .tool_of_task
            .get(task_id)
            .and_then(|id| turn.tools.get(id))
            .cloned()
        else {
            return;
        };
        if !open(&tool) && turn.bg.command_end(task_id).is_none() {
            return;
        }
        turn.bg.awaiting_hydration.remove(task_id);
        let mut finished = tool;
        finished.status = Some(status.tool_status().into());
        if let Some(output) = &output {
            finished = tools::set_output_text(finished, output);
        }
        let projected = match status {
            TaskStatus::Failed => "failed",
            _ => "completed",
        };
        self.tool_updated(finished, Some(projected), out);
        self.rearm_deferred_finalize(out);
    }

    // ---- prompt settle and turn start ------------------------------------------------------

    /// The prompt settled on a flavor that defers finalize: the turn stays open while
    /// background work runs. Returns `true` when the turn must not finalize now.
    pub(super) fn settle_with_background(&mut self, status: &str, out: &mut Vec<Out>) -> bool {
        if self.hooks().is_none() {
            return false;
        }
        let Some(turn) = self.turn.as_mut() else {
            return false;
        };
        if turn.interrupted {
            return false;
        }
        turn.bg.prompt_settled = true;
        turn.bg.prompt_settled_status = Some(status.to_owned());
        let ends: Vec<(String, CommandEnd)> = turn
            .bg
            .commands
            .iter()
            .filter_map(|(id, end)| end.clone().map(|end| (id.clone(), end)))
            .collect();
        for (task_id, end) in ends {
            self.finish_registered_background_tool(&task_id, end.status, end.output, out);
        }
        if self.turn.is_some() && self.has_deferred_work() {
            self.close_texts(out);
            return true;
        }
        false
    }

    /// `startTurnUnlocked`'s wake buffer rules at a turn start. Returns whether a
    /// continuation was requested before.
    pub(super) fn background_turn_start(
        &mut self,
        thread_id: &str,
        provider_thread_id: &str,
        continuation: bool,
        app_owned: bool,
    ) -> bool {
        self.bg.route = Some((thread_id.to_owned(), provider_thread_id.to_owned()));
        self.bg.suppress_monitor_prompt = false;
        self.bg.handled.clear();
        if !app_owned {
            self.bg.unreported.clear();
        }
        let was_requested = self.bg.continuation_requested;
        let preserve = !continuation && was_requested && !self.bg.wake_buffer.is_empty();
        if !continuation && !app_owned && !preserve {
            self.bg.wake_buffer.clear();
        }
        if !preserve {
            self.bg.continuation_requested = false;
        }
        self.bg.quarantined = false;
        was_requested
    }

    /// The continuation branch of `startTurnUnlocked`: the buffered wake frames go through
    /// the normal update handler, the turn counts as settled, and it finalizes (or defers).
    pub(super) fn drain_continuation(&mut self, was_requested: bool, out: &mut Vec<Out>) {
        self.bg.continuation_requested = false;
        let root = self.root_session.clone().unwrap_or_default();
        let drained: Vec<Value> = self
            .bg
            .wake_buffer
            .drain(..)
            .filter(|params| params["sessionId"].as_str() == Some(root.as_str()))
            .collect();
        let count = drained.len();
        for params in drained {
            out.extend(self.session_update(&params));
        }
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        turn.bg.prompt_settled = true;
        turn.bg.prompt_settled_status = Some("completed".into());
        if count == 0 && !was_requested {
            out.extend(self.finalize("completed", None));
            return;
        }
        if self.has_deferred_work() {
            self.rearm_deferred_finalize(out);
        } else {
            self.schedule_deferred_finalize(out);
        }
    }

    /// After `finalizeTurn`: offer a continuation for wake traffic, and forget unreported
    /// ends.
    pub(super) fn background_after_finalize(&mut self, status: &str, out: &mut Vec<Out>) {
        if self.hooks().is_none() {
            return;
        }
        if status == "completed"
            && !self.bg.quarantined
            && self.bg.running.is_empty()
            && (!self.bg.wake_buffer.is_empty() || !self.bg.unreported.is_empty())
        {
            self.offer_continuation(out);
        }
        if status != "completed" || self.bg.running.is_empty() {
            self.bg.unreported.clear();
        }
    }

    /// `quarantineStoppedRun`: a stopped run's frames wake nothing.
    pub(super) fn quarantine(&mut self) {
        self.bg.quarantined = true;
        self.bg.wake_buffer.clear();
        self.bg.continuation_requested = false;
        self.bg.running.clear();
        self.bg.unreported.clear();
        self.bg.route = None;
        self.bg.detached.clear();
        self.detached_turns.clear();
    }

    /// `continuationClosed`: the session closed.
    pub(crate) fn close_background(&mut self) {
        self.bg.closed = true;
        self.bg.wake_buffer.clear();
        self.bg.detached.clear();
        self.detached_turns.clear();
    }

    // ---- continuation ----------------------------------------------------------------------

    /// `offerContinuationRun`: asks the engine for one continuation turn.
    fn offer_continuation(&mut self, out: &mut Vec<Out>) -> bool {
        if self.hooks().is_none()
            || self.bg.closed
            || self.bg.quarantined
            || self.bg.continuation_requested
        {
            return false;
        }
        let Some((thread_id, provider_thread_id)) = self.bg.route.clone() else {
            return false;
        };
        self.bg.continuation_requested = true;
        self.event(
            json!({"type": "continuation.requested", "threadId": thread_id, "providerThreadId": provider_thread_id, "detail": null}),
            out,
        );
        true
    }

    fn buffer_wake(&mut self, params: &Value) {
        if self.bg.wake_buffer.len() >= WAKE_FRAMES_KEPT {
            self.skip("a wake frame past the bound");
            return;
        }
        self.bg.wake_buffer.push_back(params.clone());
    }

    /// `acpRootSessionUpdateIngestsOutput`.
    fn ingests_output(&self, update: &Value) -> bool {
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" | "agent_thought_chunk" => {
                content_display_text(&update["content"]).is_some_and(|t| !t.is_empty())
            }
            "agent_message" | "agent_thought" => update["content"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|c| content_display_text(c).is_some_and(|t| !t.is_empty())),
            "tool_call" | "tool_call_update" => !self.tool_states(update).is_empty(),
            "plan" => true,
            "plan_update" => update["plan"]["planId"]
                .as_str()
                .is_some_and(|id| !id.trim().is_empty()),
            "plan_removed" => update["planId"]
                .as_str()
                .is_some_and(|id| !id.trim().is_empty()),
            "compaction_update" => tools::compaction_tool(update).is_some(),
            "compaction_summary_chunk" => {
                update["compactionId"].is_string()
                    && content_display_text(&update["content"]).is_some()
            }
            _ => false,
        }
    }

    /// `acpPostSettleWakeEvidence`.
    fn wake_evidence(&self, params: &Value) -> bool {
        let update = &params["update"];
        if !self.ingests_output(update) {
            return false;
        }
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if (kind == "user_message_chunk" || kind == "agent_message_chunk")
            && update["content"]["type"] == "text"
        {
            let text = update["content"]["text"].as_str().unwrap_or("");
            if self
                .hooks()
                .is_some_and(|hooks| !(hooks.text_mutations)(text).is_empty())
            {
                return false;
            }
            if kind == "agent_message_chunk" && text.trim().is_empty() {
                return false;
            }
            if crate::grok_background::is_monitor_chatter(text) {
                return false;
            }
        }
        true
    }

    /// `acpPostSettleContinuationOfferEvidence`: still-running tool updates offer nothing.
    fn offer_evidence(&self, params: &Value) -> bool {
        if !self.wake_evidence(params) {
            return false;
        }
        let update = &params["update"];
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                content_display_text(&update["content"]).is_some_and(|t| !t.trim().is_empty())
            }
            "tool_call" | "tool_call_update" => self
                .tool_states(update)
                .iter()
                .any(|tool| matches!(tool.status.as_deref(), Some("completed" | "failed"))),
            _ => false,
        }
    }

    /// `bufferPostSettleWake`.
    fn buffer_post_settle_wake(&mut self, params: &Value) -> WakeOutcome {
        let Some(hooks) = self.hooks() else {
            return WakeOutcome::default();
        };
        if self.bg.quarantined {
            return WakeOutcome {
                stop: true,
                ..WakeOutcome::default()
            };
        }
        let session_id = params["sessionId"].as_str().unwrap_or("");
        if !self.is_root(session_id) || !self.wake_evidence(params) {
            return WakeOutcome::default();
        }
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        let mut handled_tool = false;
        if kind == "tool_call" || kind == "tool_call_update" {
            self.track_running_background_tools(update);
            for tool in self.tool_states(update) {
                if (hooks.task_id)(&tool).is_some_and(|id| self.bg.handled.contains(&id)) {
                    handled_tool = true;
                }
                for completion in (hooks.completions)(&tool) {
                    handled_tool = handled_tool || self.bg.handled.contains(&completion.task_id);
                    self.apply_task_running(&completion.task_id, completion.status);
                }
            }
        }
        let running = !self.bg.running.is_empty();
        let chatter = !self.bg.handled.is_empty()
            && (kind == "agent_message_chunk" || kind == "agent_thought_chunk");
        let should_buffer =
            !running || (kind != "agent_message_chunk" && kind != "agent_thought_chunk");
        let mut buffered = false;
        if !handled_tool && !chatter && should_buffer {
            self.buffer_wake(params);
            buffered = true;
        }
        let stop = WakeOutcome {
            buffered,
            offer: false,
            stop: true,
        };
        if !self.offer_evidence(params) || running {
            return stop;
        }
        if handled_tool {
            if !self.bg.continuation_requested {
                self.bg.wake_buffer.clear();
            }
            return stop;
        }
        if chatter {
            return stop;
        }
        WakeOutcome {
            buffered,
            offer: true,
            stop: true,
        }
    }

    /// `handleSessionUpdate` with no active turn (`context === null`).
    pub(super) fn idle_update(&mut self, params: &Value, out: &mut Vec<Out>) {
        if self.bg.quarantined {
            return;
        }
        let outcome = self.buffer_post_settle_wake(params);
        if outcome.offer {
            self.offer_continuation(out);
        }
        if outcome.stop {
            return;
        }
        let Some(hooks) = self.hooks() else { return };
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if matches!(
            kind,
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"
        ) && update["content"]["type"] == "text"
        {
            let text = update["content"]["text"].as_str().unwrap_or("");
            let session_id = params["sessionId"].as_str().unwrap_or("").to_owned();
            for mutation in (hooks.text_mutations)(text) {
                self.apply_late_background_mutation(
                    &session_id,
                    &mutation.task_id,
                    mutation.status,
                    out,
                );
            }
        }
        // T3 also records the text in its loaded history snapshot; this server keeps none.
    }

    /// The post-settle wake check of `handleSessionUpdate`. Returns `true` when the
    /// notification is handled.
    pub(super) fn settled_wake(&mut self, params: &Value, out: &mut Vec<Out>) -> bool {
        let Some(hooks) = self.hooks() else {
            return false;
        };
        let Some(turn) = self.turn.as_ref() else {
            return false;
        };
        if !turn.bg.prompt_settled || turn.bg.continuation || !(hooks.is_wake)(params) {
            return false;
        }
        if self.has_deferred_work() {
            self.buffer_wake(params);
            return true;
        }
        let status = turn
            .bg
            .prompt_settled_status
            .clone()
            .unwrap_or_else(|| "completed".into());
        out.extend(self.finalize(&status, None));
        let wake = self.buffer_post_settle_wake(params);
        if wake.offer {
            self.offer_continuation(out);
        }
        true
    }

    /// The in-turn `handleSessionUpdate` filters for finalized background turns: monitor
    /// chatter is suppressed. Returns `true` when the notification is dropped.
    pub(super) fn suppressed_chatter(&self, kind: &str) -> bool {
        self.bg.suppress_monitor_prompt
            && (kind == "agent_message_chunk" || kind == "agent_thought_chunk")
    }

    /// `agent_message_chunk`'s injected report rules, before the text is appended.
    pub(super) fn injected_report_on_message(&mut self) {
        let unreported = !self.bg.unreported.is_empty();
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if !turn.bg.pending_injected_report.is_empty() {
            let reported: Vec<String> = turn.bg.pending_injected_report.drain().collect();
            for id in reported {
                self.bg.unreported.remove(&id);
            }
        } else if turn.assistant.current.is_none() && turn.bg.prompt_settled && unreported {
            turn.bg.early_injected_report_observed = true;
        }
    }

    /// `user_message_chunk` in a turn: monitor events and ends in the agent's text.
    pub(super) fn user_text_mutations(&mut self, text: &str, out: &mut Vec<Out>) {
        let Some(hooks) = self.hooks() else { return };
        let mutations = (hooks.text_mutations)(text);
        let terminal: Vec<String> = mutations
            .iter()
            .filter(|m| m.status != TaskStatus::Running)
            .map(|m| m.task_id.clone())
            .collect();
        let early = self
            .turn
            .as_ref()
            .is_some_and(|t| t.bg.early_injected_report_observed);
        let report_before_notice = early && !terminal.is_empty();
        if report_before_notice {
            if let Some(turn) = self.turn.as_mut() {
                turn.bg.early_injected_report_observed = false;
            }
            for id in &terminal {
                self.bg.unreported.remove(id);
            }
        }
        for mutation in mutations {
            let previous = self.turn.as_ref().and_then(|t| {
                t.bg.tool_of_task
                    .get(&mutation.task_id)
                    .and_then(|id| t.tools.get(id))
                    .cloned()
            });
            if let Some(mut previous) = previous {
                if mutation.status != TaskStatus::Running {
                    self.mark_awaiting_hydration(&mutation.task_id, out);
                }
                previous.status = Some("inProgress".into());
                let next = tools::append_output_text(previous, &mutation.append_output);
                self.tool_updated(next, None, out);
            }
            self.apply_task_running(&mutation.task_id, mutation.status);
            if mutation.status != TaskStatus::Running && !report_before_notice {
                self.mark_pending_injected_report(&mutation.task_id, out);
            }
        }
    }

    // ---- lifecycle notifications -----------------------------------------------------------

    /// `applyLateBackgroundMutation`.
    fn apply_late_background_mutation(
        &mut self,
        session_id: &str,
        task_id: &str,
        status: TaskStatus,
        out: &mut Vec<Out>,
    ) {
        let already_ended = self.task_ended(task_id);
        self.apply_task_running(task_id, status);
        if status == TaskStatus::Running {
            if already_ended {
                // `acpPostSettleMonitorPromptShouldSuppress`: a monitor event for an ended task.
                self.bg.suppress_monitor_prompt = true;
            }
            return;
        }
        if !already_ended {
            self.bg.suppress_monitor_prompt = false;
        }
        if let Some(turn) = self.turn.as_ref() {
            if !turn.bg.prompt_settled
                && !self.bg.handled.contains(task_id)
                && turn.bg.tool_of_task.contains_key(task_id)
            {
                insert_bounded(&mut self.bg.unreported, task_id);
            }
            return;
        }
        if self.is_root(session_id)
            && self.bg.running.is_empty()
            && (!self.bg.wake_buffer.is_empty() || !self.bg.unreported.is_empty())
        {
            self.offer_continuation(out);
        }
    }

    /// The `applyBackgroundTaskMutation` extension callback (`x.ai/task_*`).
    pub(crate) fn apply_background_task_mutation(&mut self, life: Lifecycle) -> Vec<Out> {
        let mut out = Vec::new();
        if self.hooks().is_none() || self.bg.quarantined || !self.is_root(&life.session_id) {
            return out;
        }
        // `backgroundCommandTurn`: a detached command's completed turn, else the live one.
        let detached = self.detached_turn_of(&life.task_id);
        let (status, output) = match detached {
            Some(seq) => self
                .with_detached(seq, |m| m.record_command_end(&life))
                .unwrap_or((life.status, life.output.clone())),
            None => self.record_command_end(&life),
        };
        // T3 records a wake report here for the continuation's notification; the engine's
        // continuation request carries none (see the crate README).
        self.apply_late_background_mutation(&life.session_id, &life.task_id, status, &mut out);
        if status != TaskStatus::Running {
            match detached {
                Some(seq) => {
                    self.with_detached(seq, |m| {
                        m.finish_registered_background_tool(&life.task_id, status, output, &mut out)
                    });
                }
                None => {
                    self.finish_registered_background_tool(&life.task_id, status, output, &mut out)
                }
            }
        }
        out
    }

    /// A command's end, recorded on the turn that owns its row: the reported output, else the
    /// known one; a missing exit code cannot undo a known failure.
    fn record_command_end(&mut self, life: &Lifecycle) -> (TaskStatus, Option<String>) {
        let mut status = life.status;
        let mut output = life.output.clone();
        if status != TaskStatus::Running
            && let Some(turn) = self.turn.as_mut()
            && (life.report == Some(ReportKind::Command)
                || turn.bg.command_end(&life.task_id).is_some())
        {
            let previous = turn.bg.command_end(&life.task_id).cloned().flatten();
            let tool_output = turn
                .bg
                .tool_of_task
                .get(&life.task_id)
                .and_then(|id| turn.tools.get(id))
                .map(output_text);
            output = life
                .output
                .clone()
                .or_else(|| previous.as_ref().and_then(|p| p.output.clone()))
                .or(tool_output);
            if previous
                .as_ref()
                .is_some_and(|p| p.status == TaskStatus::Failed)
            {
                status = TaskStatus::Failed;
            }
            turn.bg.set_command_end(
                &life.task_id,
                Some(CommandEnd {
                    status,
                    output: output.clone(),
                }),
            );
        }
        (status, output)
    }

    #[cfg(test)]
    pub(crate) fn background_state_empty(&self) -> bool {
        self.bg.wake_buffer.is_empty() && !self.bg.continuation_requested
    }
}

// ---- detached background commands ------------------------------------------------------------

impl<E: Env> Mapper<E> {
    /// `emitTool`'s hydration of a background task's row from another tool's completion.
    /// Returns whether the task has a row in the turn.
    fn hydrate_target(
        &mut self,
        completion: &crate::grok_background::TaskMutation,
        tool_call_id: &str,
        out: &mut Vec<Out>,
    ) -> bool {
        let Some(turn) = self.turn.as_mut() else {
            return false;
        };
        let Some(target) = turn
            .bg
            .tool_of_task
            .get(&completion.task_id)
            .and_then(|id| turn.tools.get(id))
            .cloned()
        else {
            return false;
        };
        if target.tool_call_id == tool_call_id {
            return true;
        }
        let mut hydrated = target;
        hydrated.status = Some(completion.status.tool_status().into());
        if !completion.append_output.is_empty() {
            let current = output_text(&hydrated);
            hydrated = if crate::grok_background::is_monitor_end_notice(&current)
                || current.trim().is_empty()
            {
                tools::set_output_text(hydrated, &completion.append_output)
            } else {
                tools::append_output_text(hydrated, &completion.append_output)
            };
        }
        // A start ACK can reopen this row; keep the end for the settle.
        if completion.status != TaskStatus::Running
            && matches!(turn.bg.command_end(&completion.task_id), Some(None))
        {
            turn.bg.set_command_end(
                &completion.task_id,
                Some(CommandEnd {
                    status: completion.status,
                    output: Some(output_text(&hydrated)),
                }),
            );
        }
        self.tool_updated(hydrated, None, out);
        true
    }

    /// A tool that started a background command (`backgroundCommandTaskId`).
    pub(super) fn is_command_tool(&self, tool: &ToolState) -> bool {
        self.turn
            .as_ref()
            .is_some_and(|t| t.bg.command_of_tool.contains_key(&tool.tool_call_id))
    }

    /// `detachBackgroundCommands`: a completed turn keeps the rows of its background commands,
    /// so their output and end still land on its run.
    pub(super) fn detach_background_commands(&mut self, turn: super::Turn) {
        if self.hooks().is_none() || self.bg.quarantined || turn.bg.commands.is_empty() {
            return;
        }
        let seq = turn.seq;
        for (task_id, _) in &turn.bg.commands {
            self.bg.detached.retain(|(id, _)| id != task_id);
            self.bg.detached.push_back((task_id.clone(), seq));
        }
        self.detached_turns.push(turn);
        // Ended commands beyond the bound go, oldest first; running ones stay.
        let ended: Vec<String> = self
            .bg
            .detached
            .iter()
            .filter(|(task_id, seq)| !self.detached_command_open(task_id, *seq))
            .map(|(task_id, _)| task_id.clone())
            .collect();
        let drop = ended.len().saturating_sub(ENDED_DETACHED_KEPT);
        for task_id in ended.iter().take(drop) {
            self.bg.detached.retain(|(id, _)| id != task_id);
        }
        let detached = &self.bg.detached;
        self.detached_turns
            .retain(|turn| detached.iter().any(|(_, seq)| *seq == turn.seq));
    }

    fn detached_command_open(&self, task_id: &str, seq: u64) -> bool {
        self.detached_turns
            .iter()
            .find(|turn| turn.seq == seq)
            .and_then(|turn| {
                let id = turn.bg.tool_of_task.get(task_id)?;
                turn.tools.get(id)
            })
            .is_some_and(open)
    }

    /// The completed turn that owns a background command's row.
    pub(super) fn detached_turn_of(&self, task_id: &str) -> Option<u64> {
        self.bg
            .detached
            .iter()
            .rev()
            .find(|(id, _)| id == task_id)
            .map(|(_, seq)| *seq)
    }

    /// Runs `f` with a detached turn as the turn, then puts both back.
    pub(super) fn with_detached<R>(
        &mut self,
        seq: u64,
        f: impl FnOnce(&mut Self) -> R,
    ) -> Option<R> {
        let at = self.detached_turns.iter().position(|t| t.seq == seq)?;
        let turn = self.detached_turns.remove(at);
        let live = self.turn.replace(turn);
        let result = f(self);
        if let Some(turn) = std::mem::replace(&mut self.turn, live) {
            self.detached_turns.insert(at, turn);
        }
        Some(result)
    }

    /// `projectDetachedBackgroundCommand`: output and replays for a detached command land on
    /// its row, not in the wake buffer.
    pub(super) fn project_detached_command(
        &mut self,
        session_id: &str,
        kind: &str,
        update: &Value,
        out: &mut Vec<Out>,
    ) -> bool {
        if kind != "tool_call" && kind != "tool_call_update" {
            return false;
        }
        let Some(tool_call_id) = update["toolCallId"].as_str() else {
            return false;
        };
        if self
            .turn
            .as_ref()
            .is_some_and(|t| t.tools.contains_key(tool_call_id))
        {
            return false;
        }
        if self.root_session.as_deref() != Some(session_id) {
            return false;
        }
        let Some(seq) = self
            .detached_turns
            .iter()
            .find(|t| t.bg.command_of_tool.contains_key(tool_call_id))
            .map(|t| t.seq)
        else {
            return false;
        };
        let fallback = (kind == "tool_call").then_some("pending");
        let Some(state) = tools::parse_tool_call(update, fallback) else {
            return true;
        };
        self.with_detached(seq, |m| m.tool_updated(state, None, out));
        true
    }
}
