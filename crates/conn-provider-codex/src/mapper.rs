//! App-server notifications and requests → `ProviderEvent`s and JSON-RPC replies. Pure: no
//! I/O, no async; time and randomness come from [`Env`], so recordings replay exactly.
//!
//! Shapes follow `CodexAdapterV2.ts` (`registerRootTurn`, the `item/*` handlers, the
//! `build*Artifacts` helpers, the text coalescers, `finalizeCodexTurn`). One mapper serves one
//! session; turns are keyed by native turn id. Known differences are in the README.

use std::collections::{HashMap, HashSet, VecDeque};

/// How many ended turn ids the mapper remembers, so a late frame of an ended turn is not
/// taken for a new one.
const ENDED_TURNS_KEPT: usize = 64;

use conn_contract::{from_json, to_json};
use conn_provider::{ProviderError, ProviderEvent, RuntimeRequestResponse, TurnInput};
use conn_provider_support::ids::{self, Env, iso_from_ms};
use serde_json::{Map, Value, json};

use crate::protocol::{Inbound, reply, reply_error};

pub const DRIVER: &str = "codex";

/// What the session must do after feeding the mapper.
#[allow(clippy::large_enum_variant)] // Moved straight into a channel; boxing adds an allocation.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Event(ProviderEvent),
    /// One JSON line for the app-server's stdin.
    Write(String),
    /// Something the mapper skipped; the session logs each kind once.
    Skipped(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BufKind {
    Agent,
    Reasoning,
    Plan,
}

#[derive(Debug)]
struct Buf {
    kind: BufKind,
    turn: String,
    item: String,
    text: String,
    dirty: bool,
}

#[derive(Debug, Clone)]
struct ReasoningPart {
    key: String,
    turn: String,
    native_item: String,
    stream: &'static str,
    index: usize,
}

#[derive(Debug, Clone)]
struct RunningCommand {
    id: String,
    command: String,
    output: Option<String>,
    process_id: Option<String>,
}

/// One registered root turn (`ActiveCodexTurnContext`).
struct Turn {
    thread_id: String,
    run_id: String,
    run_ordinal: u32,
    turn_ordinal: u32,
    attempt_id: String,
    root_node_id: String,
    provider_thread_id: String,
    provider_session_id: Value,
    native_thread_id: String,
    native_turn_id: String,
    provider_turn_id: String,
    started_at: String,
    positions: HashMap<String, (u32, String)>,
    file_change_kinds: HashMap<String, Value>,
    message_phases: HashMap<String, String>,
    final_answer_ids: Vec<String>,
    completed_final_texts: HashSet<String>,
    running_commands: Vec<RunningCommand>,
    running_tools: Vec<Value>,
    running_compactions: Vec<String>,
    latest_failure: Option<(String, Option<String>, Value)>,
}

impl Turn {
    /// `resolveItemPosition`: ordinals are `turnOrdinal * 100 + n`, first seen first.
    fn position(&mut self, item: &str, started_at: String) -> (u32, String) {
        if let Some(p) = self.positions.get(item) {
            return p.clone();
        }
        let p = (
            self.turn_ordinal * 100 + self.positions.len() as u32 + 1,
            started_at,
        );
        self.positions.insert(item.to_owned(), p.clone());
        p
    }
}

struct UsageAcc {
    input: u64,
    cached: u64,
    cache_creation: Option<u64>,
    output: u64,
    reasoning: u64,
    observed: bool,
}

#[derive(Default)]
struct UsageState {
    baseline: Option<[Option<u64>; 5]>,
    active_turn: Option<String>,
    acc: HashMap<String, UsageAcc>,
}

/// The parts of a turn input the mapper keeps until the native turn id is known.
#[derive(Clone)]
struct PendingTurn {
    thread_id: String,
    run_id: String,
    run_ordinal: u32,
    turn_ordinal: u32,
    attempt_id: String,
    root_node_id: String,
    provider_thread_id: String,
    provider_session_id: Value,
    runtime_mode: String,
}

enum PendingKind {
    /// Modern approvals: `{"decision": ...}`. `allowance` is the kind remembered for the session.
    Decision {
        allowance: Option<&'static str>,
    },
    /// `execCommandApproval` / `applyPatchApproval`: the legacy review decisions.
    Legacy {
        allowance: &'static str,
    },
    Permissions {
        permissions: Value,
    },
    UserInput {
        question_ids: Vec<String>,
    },
}

struct Pending {
    native_id: Value,
    native_thread_id: String,
    kind: PendingKind,
}

pub struct Mapper<E: Env> {
    env: E,
    turns: HashMap<String, Turn>,
    /// Native thread id → the turn input whose `turn/start` is in flight.
    pending_turns: HashMap<String, PendingTurn>,
    requests: HashMap<String, Pending>,
    /// Plan item key → (native turn, plan id); pruned when the turn ends.
    plan_ids: HashMap<String, (String, String)>,
    bufs: Vec<Buf>,
    reasoning_parts: Vec<ReasoningPart>,
    thread_models: HashMap<String, String>,
    rerouted_turn_models: HashMap<String, String>,
    rerouted_threads: HashSet<String>,
    usage: HashMap<String, UsageState>,
    /// Native thread id → (runtime mode, kinds accepted for the session).
    allowances: HashMap<String, (String, HashSet<&'static str>)>,
    mcp_failures: HashMap<String, Vec<(String, String)>>,
    interrupting: HashSet<String>,
    ended_unfinished: HashSet<String>,
    /// The latest ended turns, newest last; at most [`ENDED_TURNS_KEPT`].
    ended: VecDeque<String>,
}

fn ref_strong(native: &str) -> Value {
    json!({"driver": DRIVER, "nativeId": native, "strength": "strong"})
}

fn trimmed(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Codex timestamps are seconds; `null` means now.
fn codex_time(env: &mut impl Env, seconds: &Value) -> String {
    match seconds.as_f64() {
        Some(s) => iso_from_ms((s * 1000.0) as u64),
        None => env.now(),
    }
}

fn ms_time(env: &mut impl Env, ms: &Value) -> String {
    match ms.as_u64() {
        Some(ms) => iso_from_ms(ms),
        None => env.now(),
    }
}

/// `codexItemStatus`: (node status, turn item status, completed).
fn item_status(status: &Value) -> (&'static str, &'static str, bool) {
    match status.as_str() {
        Some("completed") => ("completed", "completed", true),
        Some("failed") => ("failed", "failed", true),
        Some("declined") => ("cancelled", "cancelled", true),
        _ => ("running", "running", false),
    }
}

/// Decodes one event row into its contract type. Each variant decodes its own payload type,
/// the same instantiations the engine and the Claude crate use, so the internally tagged
/// `ProviderEvent` decoder (large in the binary) is never instantiated.
fn push_event(out: &mut Vec<Out>, mut value: Value) {
    fn take<T: serde::de::DeserializeOwned>(
        value: &mut Value,
        key: &str,
    ) -> Result<T, serde_json::Error> {
        from_json(value.get_mut(key).map(Value::take).unwrap_or(Value::Null))
    }
    let kind = value["type"].as_str().unwrap_or_default().to_owned();
    let event = match kind.as_str() {
        "provider_turn.updated" => take(&mut value, "threadId").and_then(|thread_id| {
            Ok(ProviderEvent::ProviderTurnUpdated {
                thread_id,
                provider_turn: take(&mut value, "providerTurn")?,
            })
        }),
        "node.updated" => take(&mut value, "node").map(|node| ProviderEvent::NodeUpdated { node }),
        "message.updated" => {
            take(&mut value, "message").map(|message| ProviderEvent::MessageUpdated { message })
        }
        "turn_item.updated" => take(&mut value, "turnItem")
            .map(|turn_item| ProviderEvent::TurnItemUpdated { turn_item }),
        "plan.updated" => take(&mut value, "plan").map(|plan| ProviderEvent::PlanUpdated { plan }),
        "runtime_request.updated" => take(&mut value, "threadId").and_then(|thread_id| {
            Ok(ProviderEvent::RuntimeRequestUpdated {
                thread_id,
                runtime_request: take(&mut value, "runtimeRequest")?,
            })
        }),
        "command_output.delta" => take(&mut value, "threadId").and_then(|thread_id| {
            Ok(ProviderEvent::CommandOutputDelta {
                thread_id,
                item_id: take(&mut value, "itemId")?,
                chunk: take(&mut value, "chunk")?,
            })
        }),
        "turn.terminal" => from_json(value).map(ProviderEvent::TurnTerminal),
        _ => {
            out.push(Out::Skipped(format!("event {kind}")));
            return;
        }
    };
    match event {
        Ok(event) => out.push(Out::Event(event)),
        Err(e) => out.push(Out::Skipped(format!(
            "event {kind} does not fit the contract: {e}"
        ))),
    }
}

impl<E: Env> Mapper<E> {
    pub fn new(env: E) -> Self {
        Self {
            env,
            turns: HashMap::new(),
            pending_turns: HashMap::new(),
            requests: HashMap::new(),
            plan_ids: HashMap::new(),
            bufs: Vec::new(),
            reasoning_parts: Vec::new(),
            thread_models: HashMap::new(),
            rerouted_turn_models: HashMap::new(),
            rerouted_threads: HashSet::new(),
            usage: HashMap::new(),
            allowances: HashMap::new(),
            mcp_failures: HashMap::new(),
            interrupting: HashSet::new(),
            ended_unfinished: HashSet::new(),
            ended: VecDeque::new(),
        }
    }

    // ---- turn lifecycle -------------------------------------------------------------------

    /// Called before `turn/start` goes out: a `turn/started` that beats the response registers
    /// the turn from this input.
    pub fn begin_turn(&mut self, native_thread_id: &str, input: &TurnInput) {
        let thread = to_json(&input.provider_thread);
        self.pending_turns.insert(
            native_thread_id.to_owned(),
            PendingTurn {
                thread_id: input.thread_id.as_str().to_owned(),
                run_id: input.run_id.as_str().to_owned(),
                run_ordinal: input.run_ordinal,
                turn_ordinal: input.provider_turn_ordinal,
                attempt_id: input.attempt_id.as_str().to_owned(),
                root_node_id: input.root_node_id.as_str().to_owned(),
                provider_thread_id: thread["id"].as_str().unwrap_or_default().to_owned(),
                provider_session_id: thread["providerSessionId"].clone(),
                runtime_mode: to_json(&input.runtime_policy.runtime_mode)
                    .as_str()
                    .unwrap_or("full-access")
                    .to_owned(),
            },
        );
    }

    /// `turn/start` failed: forget the pending input.
    pub fn abandon_turn(&mut self, native_thread_id: &str) {
        self.pending_turns.remove(native_thread_id);
    }

    /// The `turn/start` result. Registers the turn unless `turn/started` already did.
    pub fn turn_start_result(&mut self, native_thread_id: &str, result: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        let turn = &result["turn"];
        if let (Some(native_turn), Some(pending)) = (
            turn["id"].as_str(),
            self.pending_turns.remove(native_thread_id),
        ) {
            let started_at = codex_time(&mut self.env, &turn["startedAt"]);
            self.register(native_thread_id, native_turn, pending, started_at, &mut out);
        }
        out
    }

    fn register(
        &mut self,
        native_thread_id: &str,
        native_turn_id: &str,
        p: PendingTurn,
        started_at: String,
        out: &mut Vec<Out>,
    ) {
        if self.turns.contains_key(native_turn_id) {
            return;
        }
        let provider_turn_id = ids::provider_turn_id(DRIVER, native_turn_id);
        // `endSessionApprovalsOnModeChange`.
        let allowance = self
            .allowances
            .entry(native_thread_id.to_owned())
            .or_insert_with(|| (p.runtime_mode.clone(), HashSet::new()));
        if allowance.0 != p.runtime_mode {
            *allowance = (p.runtime_mode.clone(), HashSet::new());
        }
        // `beginTurnTokenUsage`.
        let usage = self.usage.entry(native_thread_id.to_owned()).or_default();
        if usage.active_turn.as_deref() != Some(native_turn_id) {
            usage.acc.clear();
            usage.active_turn = Some(native_turn_id.to_owned());
            usage
                .acc
                .insert(native_turn_id.to_owned(), UsageAcc::default());
        }
        let turn = Turn {
            thread_id: p.thread_id,
            run_id: p.run_id,
            run_ordinal: p.run_ordinal,
            turn_ordinal: p.turn_ordinal,
            attempt_id: p.attempt_id,
            root_node_id: p.root_node_id,
            provider_thread_id: p.provider_thread_id,
            provider_session_id: p.provider_session_id,
            native_thread_id: native_thread_id.to_owned(),
            native_turn_id: native_turn_id.to_owned(),
            provider_turn_id,
            started_at,
            positions: HashMap::new(),
            file_change_kinds: HashMap::new(),
            message_phases: HashMap::new(),
            final_answer_ids: Vec::new(),
            completed_final_texts: HashSet::new(),
            running_commands: Vec::new(),
            running_tools: Vec::new(),
            running_compactions: Vec::new(),
            latest_failure: None,
        };
        push_event(
            out,
            json!({
                "type": "provider_turn.updated",
                "threadId": turn.thread_id,
                "providerTurn": provider_turn_json(&turn, "running", None),
            }),
        );
        self.turns.insert(native_turn_id.to_owned(), turn);
        self.emit_mcp_failures(native_turn_id, out);
    }

    /// Whether a root turn on this native thread is running or starting.
    pub fn thread_busy(&self, native_thread_id: &str) -> bool {
        self.pending_turns.contains_key(native_thread_id)
            || self
                .turns
                .values()
                .any(|t| t.native_thread_id == native_thread_id)
    }

    /// The native turn behind a provider turn id, if it is running.
    pub fn native_turn(&self, provider_turn_id: &str) -> Option<String> {
        self.turns
            .values()
            .find(|t| t.provider_turn_id == provider_turn_id)
            .map(|t| t.native_turn_id.clone())
    }

    pub fn mark_interrupting(&mut self, native_turn_id: &str) {
        self.interrupting.insert(native_turn_id.to_owned());
    }

    pub fn is_active(&self, native_turn_id: &str) -> bool {
        self.turns.contains_key(native_turn_id)
    }

    /// Background terminal processes the turn started, for `thread/backgroundTerminals/terminate`.
    pub fn running_processes(&self, native_turn_id: &str) -> Vec<String> {
        self.turns
            .get(native_turn_id)
            .map(|t| {
                t.running_commands
                    .iter()
                    .filter_map(|c| c.process_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Ends a turn Codex did not finish after an interrupt.
    pub fn force_interrupted(&mut self, native_turn_id: &str) -> Vec<Out> {
        let mut out = Vec::new();
        let now = self.env.now();
        self.finalize(native_turn_id, "interrupted", now, None, None, &mut out);
        self.interrupting.remove(native_turn_id);
        out
    }

    /// The app-server is gone: every open turn ends. `expected` (a close) ends them as
    /// interrupted, a crash as failed.
    pub fn on_exit(&mut self, expected: bool, detail: &str) -> Vec<Out> {
        let mut out = Vec::new();
        self.pending_turns.clear();
        self.requests.clear();
        let open: Vec<String> = self.turns.keys().cloned().collect();
        for native in open {
            let now = self.env.now();
            if expected {
                self.finalize(&native, "interrupted", now, None, None, &mut out);
            } else {
                if let Some(turn) = self.turns.get_mut(&native) {
                    turn.latest_failure = Some((
                        detail.to_owned(),
                        Some("codex_process_exited".into()),
                        failure_json(
                            "transport_error",
                            detail,
                            Some("codex_process_exited"),
                            None,
                        ),
                    ));
                }
                self.finalize(&native, "failed", now, Some(detail), None, &mut out);
            }
        }
        out
    }

    // ---- inbound --------------------------------------------------------------------------

    pub fn handle(&mut self, inbound: Inbound) -> Vec<Out> {
        let mut out = Vec::new();
        match inbound {
            Inbound::Notification { method, params } => {
                // Thread-level frames do not adopt: a resumed thread reports the previous
                // turn's token usage before the new turn starts, and that turn id must not
                // bind the new turn (found by the conformance check, `provider_thread_resume`).
                if method != "turn/started" && !method.starts_with("thread/") {
                    self.adopt_pending(&params, &mut out);
                }
                self.notification(&method, &params, &mut out)
            }
            Inbound::Request { id, method, params } => {
                self.adopt_pending(&params, &mut out);
                self.server_request(id, &method, &params, &mut out)
            }
            Inbound::Response { .. } => {}
            Inbound::Invalid(detail) => out.push(Out::Skipped(format!("invalid frame: {detail}"))),
        }
        out
    }

    /// The `turn/start` answer reaches the session on another task, so a frame for the new
    /// turn can arrive first. A frame naming an unknown turn on a thread whose start is in
    /// flight registers that turn, as `turn/started` does (TS waits for the context instead).
    fn adopt_pending(&mut self, p: &Value, out: &mut Vec<Out>) {
        let native_turn = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
        let (Some(native_turn), Some(thread)) = (native_turn, p["threadId"].as_str()) else {
            return;
        };
        // A late frame of an ended turn (the interrupted command's `item/completed` after
        // the next `turn/start` went out) must not become the new turn.
        if self.turns.contains_key(native_turn) || self.ended.iter().any(|t| t == native_turn) {
            return;
        }
        if let Some(pending) = self.pending_turns.remove(thread) {
            let started_at = self.env.now();
            self.register(thread, native_turn, pending, started_at, out);
        }
    }

    fn notification(&mut self, method: &str, p: &Value, out: &mut Vec<Out>) {
        let turn_id = p["turnId"].as_str().unwrap_or_default();
        match method {
            "turn/started" => {
                let native_turn = p["turn"]["id"].as_str().unwrap_or_default();
                let thread = p["threadId"].as_str().unwrap_or_default();
                if !self.turns.contains_key(native_turn)
                    && let Some(pending) = self.pending_turns.remove(thread)
                {
                    let started_at = codex_time(&mut self.env, &p["turn"]["startedAt"]);
                    self.register(thread, native_turn, pending, started_at, out);
                }
            }
            "turn/completed" => self.turn_completed(p, out),
            "item/started" => self.item_started(turn_id, p, out),
            "item/completed" => self.item_completed(turn_id, p, out),
            "item/agentMessage/delta" => {
                if self.turns.contains_key(turn_id) {
                    self.append(BufKind::Agent, turn_id, p["itemId"].as_str(), &p["delta"]);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                self.append_reasoning(turn_id, p, "summary", &p["summaryIndex"])
            }
            "item/reasoning/textDelta" => {
                self.append_reasoning(turn_id, p, "content", &p["contentIndex"])
            }
            "item/plan/delta" => {
                if self.turns.contains_key(turn_id) {
                    self.append(BufKind::Plan, turn_id, p["itemId"].as_str(), &p["delta"]);
                }
            }
            "item/commandExecution/outputDelta" => {
                if let Some(turn) = self.turns.get(turn_id) {
                    let item = p["itemId"].as_str().unwrap_or_default();
                    push_event(
                        out,
                        json!({
                            "type": "command_output.delta",
                            "threadId": turn.thread_id,
                            "itemId": ids::turn_item_from_item(DRIVER, item),
                            "chunk": p["delta"],
                        }),
                    );
                }
            }
            "turn/plan/updated" => self.todo_list(turn_id, p, out),
            "thread/tokenUsage/updated" => self.token_usage(turn_id, p, out),
            "thread/settings/updated" => {
                let thread = p["threadId"].as_str().unwrap_or_default().to_owned();
                self.rerouted_threads.remove(&thread);
                if let Some(model) = trimmed(&p["threadSettings"]["model"]) {
                    self.thread_models.insert(thread, model);
                }
            }
            "model/rerouted" => {
                let thread = p["threadId"].as_str().unwrap_or_default().to_owned();
                if let Some(model) = trimmed(&p["toModel"]) {
                    self.rerouted_turn_models
                        .insert(turn_id.to_owned(), model.clone());
                    self.thread_models.insert(thread.clone(), model);
                }
                self.rerouted_threads.insert(thread);
            }
            "mcpServer/startupStatus/updated" => self.mcp_status(p, out),
            "error" => self.error(turn_id, p, out),
            "thread/started"
            | "thread/status/changed"
            | "thread/closed"
            | "account/updated"
            | "account/rateLimits/updated"
            | "remoteControl/status/changed"
            | "configWarning"
            | "warning"
            | "deprecationNotice"
            | "serverRequest/resolved"
            | "item/reasoning/summaryPartAdded"
            | "thread/name/updated"
            | "thread/readState/changed"
            | "skills/changed"
            | "hook/started"
            | "hook/completed" => {}
            other => out.push(Out::Skipped(format!("notification {other}"))),
        }
    }

    fn append(&mut self, kind: BufKind, turn: &str, item: Option<&str>, delta: &Value) {
        let (Some(item), Some(delta)) = (item, delta.as_str()) else {
            return;
        };
        if delta.is_empty() {
            return;
        }
        match self
            .bufs
            .iter_mut()
            .find(|b| b.kind == kind && b.turn == turn && b.item == item)
        {
            Some(buf) => {
                buf.text.push_str(delta);
                buf.dirty = true;
            }
            None => self.bufs.push(Buf {
                kind,
                turn: turn.to_owned(),
                item: item.to_owned(),
                text: delta.to_owned(),
                dirty: true,
            }),
        }
    }

    fn reasoning_key(
        &mut self,
        turn: &str,
        item: &str,
        stream: &'static str,
        index: usize,
    ) -> String {
        let key = json!([turn, item, stream, index]).to_string();
        if !self.reasoning_parts.iter().any(|p| p.key == key) {
            self.reasoning_parts.push(ReasoningPart {
                key: key.clone(),
                turn: turn.to_owned(),
                native_item: item.to_owned(),
                stream,
                index,
            });
        }
        key
    }

    fn append_reasoning(&mut self, turn_id: &str, p: &Value, stream: &'static str, index: &Value) {
        let delta = p["delta"].as_str().unwrap_or_default();
        if !self.turns.contains_key(turn_id) || delta.is_empty() {
            return;
        }
        let item = p["itemId"].as_str().unwrap_or_default();
        let key = self.reasoning_key(turn_id, item, stream, index.as_u64().unwrap_or(0) as usize);
        let now = self.env.now();
        if let Some(turn) = self.turns.get_mut(turn_id) {
            turn.position(&key, now);
        }
        self.append(BufKind::Reasoning, turn_id, Some(&key), &p["delta"]);
    }

    /// Emits a streaming update for every buffer with new text. `plans` also flushes plan
    /// text, which the TS adapter coalesces over 400 ms instead of 50 ms.
    pub fn flush(&mut self, plans: bool) -> Vec<Out> {
        let mut out = Vec::new();
        let dirty: Vec<(BufKind, String, String, String)> = self
            .bufs
            .iter_mut()
            .filter(|b| b.dirty && (plans || b.kind != BufKind::Plan))
            .map(|b| {
                b.dirty = false;
                (b.kind, b.turn.clone(), b.item.clone(), b.text.clone())
            })
            .collect();
        for (kind, turn, item, text) in dirty {
            self.emit_text(kind, &turn, &item, &text, false, &mut out);
        }
        out
    }

    pub fn has_dirty(&self, plans: bool) -> bool {
        self.bufs
            .iter()
            .any(|b| b.dirty && (plans || b.kind != BufKind::Plan))
    }

    /// The coalescer's `complete`: the final text wins over buffered text.
    fn complete_text(
        &mut self,
        kind: BufKind,
        turn: &str,
        item: &str,
        final_text: Option<&str>,
        emit_empty: bool,
        out: &mut Vec<Out>,
    ) -> String {
        let pos = self
            .bufs
            .iter()
            .position(|b| b.kind == kind && b.turn == turn && b.item == item);
        let buffered = pos.map(|i| self.bufs.remove(i).text);
        let text = final_text
            .map(str::to_owned)
            .or(buffered)
            .unwrap_or_default();
        if emit_empty || !text.is_empty() {
            self.emit_text(kind, turn, item, &text, true, out);
        }
        text
    }

    /// The coalescer's `flushTurn`: what is left for a turn goes out completed.
    fn flush_turn(&mut self, turn: &str, out: &mut Vec<Out>) {
        for kind in [BufKind::Agent, BufKind::Reasoning, BufKind::Plan] {
            let mut left = Vec::new();
            self.bufs.retain(|b| {
                let take = b.kind == kind && b.turn == turn;
                if take {
                    left.push((b.item.clone(), b.text.clone()));
                }
                !take
            });
            for (item, text) in left {
                self.emit_text(kind, turn, &item, &text, true, out);
            }
        }
    }

    fn emit_text(
        &mut self,
        kind: BufKind,
        turn_id: &str,
        item: &str,
        text: &str,
        completed: bool,
        out: &mut Vec<Out>,
    ) {
        match kind {
            BufKind::Agent => self.emit_agent(turn_id, item, text, completed, out),
            BufKind::Reasoning => self.emit_reasoning(turn_id, item, text, completed, out),
            BufKind::Plan => self.emit_plan(turn_id, item, text, completed, out),
        }
    }

    fn emit_agent(
        &mut self,
        turn_id: &str,
        item: &str,
        text: &str,
        completed: bool,
        out: &mut Vec<Out>,
    ) {
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let final_answer = turn.final_answer_ids.iter().any(|i| i == item);
        if final_answer {
            let first = turn.final_answer_ids.first().map(String::as_str);
            let completed_texts = &turn.completed_final_texts;
            let duplicate = completed
                && !completed_texts.is_empty()
                && (text.is_empty() || completed_texts.contains(text));
            let deferred = !completed && (!completed_texts.is_empty() || first != Some(item));
            if duplicate || deferred {
                return;
            }
        }
        let (node, message, turn_item) =
            agent_artifacts(&mut self.env, turn, item, text, completed);
        push_event(out, json!({"type": "node.updated", "node": node}));
        if completed {
            push_event(out, json!({"type": "message.updated", "message": message}));
        }
        push_event(
            out,
            json!({"type": "turn_item.updated", "turnItem": turn_item}),
        );
        if final_answer && completed {
            turn.completed_final_texts.insert(text.to_owned());
        }
    }

    fn emit_reasoning(
        &mut self,
        turn_id: &str,
        key: &str,
        text: &str,
        completed: bool,
        out: &mut Vec<Out>,
    ) {
        let Some(part) = self.reasoning_parts.iter().find(|p| p.key == key).cloned() else {
            return;
        };
        let interrupted = self.ended_unfinished.contains(turn_id);
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let (mut node, _, mut item) = agent_artifacts(&mut self.env, turn, key, text, completed);
        let native = ref_strong(&part.native_item);
        node["kind"] = json!("reasoning");
        node["nativeItemRef"] = native.clone();
        item["type"] = json!("reasoning");
        item["nativeItemRef"] = native;
        if let Some(object) = item.as_object_mut() {
            object.remove("messageId");
        }
        if interrupted {
            node["status"] = json!("interrupted");
            item["status"] = json!("interrupted");
        }
        push_event(out, json!({"type": "node.updated", "node": node}));
        push_event(out, json!({"type": "turn_item.updated", "turnItem": item}));
    }

    fn emit_plan(
        &mut self,
        turn_id: &str,
        item: &str,
        text: &str,
        completed: bool,
        out: &mut Vec<Out>,
    ) {
        let interrupted = self.ended_unfinished.contains(turn_id);
        let completed = completed && !interrupted;
        let plan_id = self.plan_id(turn_id, item);
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let now = self.env.now();
        let completed_at = completed.then(|| now.clone());
        let (ordinal, started_at) = turn.position(item, now.clone());
        let node_id = ids::node_from_item(DRIVER, item);
        let status = if completed { "completed" } else { "running" };
        let mut node = node_json(
            turn,
            &node_id,
            "plan",
            status,
            item,
            &started_at,
            completed_at.as_deref(),
        );
        node["runtimeRequestId"] = Value::Null;
        push_event(out, json!({"type": "node.updated", "node": node}));
        push_event(
            out,
            json!({"type": "plan.updated", "plan": {
                "id": plan_id, "threadId": turn.thread_id, "runId": turn.run_id,
                "nodeId": node_id, "kind": "proposed_plan", "status": "active", "markdown": text,
            }}),
        );
        let mut turn_item = item_json(
            turn,
            item,
            &node_id,
            ordinal,
            status,
            &started_at,
            completed_at.as_deref(),
            &now,
        );
        extend(
            &mut turn_item,
            json!({
                "type": "proposed_plan", "planId": plan_id, "markdown": text, "streaming": !completed,
            }),
        );
        push_event(
            out,
            json!({"type": "turn_item.updated", "turnItem": turn_item}),
        );
    }

    fn plan_id(&mut self, turn_id: &str, key: &str) -> String {
        if let Some((_, id)) = self.plan_ids.get(key) {
            return id.clone();
        }
        let Some(turn) = self.turns.get(turn_id) else {
            return String::new();
        };
        let id = ids::plan_id(
            &turn.thread_id,
            Some(&turn.run_id),
            DRIVER,
            &self.env.uuid(),
        );
        self.plan_ids
            .insert(key.to_owned(), (turn_id.to_owned(), id.clone()));
        id
    }

    fn item_started(&mut self, turn_id: &str, p: &Value, out: &mut Vec<Out>) {
        let item = &p["item"];
        let id = item["id"].as_str().unwrap_or_default().to_owned();
        let kind = item["type"].as_str().unwrap_or_default();
        let started = ms_time(&mut self.env, &p["startedAtMs"]);
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        match kind {
            "contextCompaction" => {
                turn.running_compactions.push(id.clone());
                let started_ms = started.clone();
                emit_compaction(turn, &id, "running", &started_ms, out);
                return;
            }
            "userMessage" => return,
            "subAgentActivity" | "collabAgentToolCall" => {
                out.push(Out::Skipped(format!("item {kind}")));
                return;
            }
            _ => {}
        }
        if kind != "reasoning" {
            turn.position(&id, started);
        }
        match kind {
            "fileChange" => {
                let kinds: Map<String, Value> = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| Some((c["path"].as_str()?.to_owned(), c["kind"].clone())))
                    .collect();
                turn.file_change_kinds.insert(id, Value::Object(kinds));
            }
            "agentMessage" => {
                let phase = item["phase"].as_str();
                if let Some(phase) = phase {
                    turn.message_phases.insert(id.clone(), phase.to_owned());
                }
                if phase.is_none_or(|p| p == "final_answer") && !turn.final_answer_ids.contains(&id)
                {
                    turn.final_answer_ids.push(id);
                }
            }
            "commandExecution" => {
                if !item_status(&item["status"]).2 {
                    turn.running_commands.retain(|c| c.id != id);
                    turn.running_commands.push(RunningCommand {
                        id: id.clone(),
                        command: item["command"].as_str().unwrap_or_default().to_owned(),
                        output: item["aggregatedOutput"].as_str().map(str::to_owned),
                        process_id: item["processId"].as_str().map(str::to_owned),
                    });
                }
                command_artifacts(&mut self.env, turn, item, out);
            }
            "mcpToolCall" | "dynamicToolCall" => {
                if !item_status(&item["status"]).2 {
                    turn.running_tools.retain(|t| t["id"] != item["id"]);
                    turn.running_tools.push(item.clone());
                }
                tool_artifacts(&mut self.env, turn, item, None, out);
            }
            "webSearch" => web_search_artifacts(&mut self.env, turn, item, false, out),
            "reasoning" | "plan" => {}
            other => out.push(Out::Skipped(format!("item {other}"))),
        }
    }

    fn item_completed(&mut self, turn_id: &str, p: &Value, out: &mut Vec<Out>) {
        let item = &p["item"];
        let id = item["id"].as_str().unwrap_or_default().to_owned();
        let kind = item["type"].as_str().unwrap_or_default();
        if !self.turns.contains_key(turn_id) {
            return;
        }
        match kind {
            "reasoning" => {
                for stream in ["summary", "content"] {
                    for (index, _) in item[stream].as_array().into_iter().flatten().enumerate() {
                        self.reasoning_key(turn_id, &id, stream, index);
                    }
                }
                let parts: Vec<ReasoningPart> = self
                    .reasoning_parts
                    .iter()
                    .filter(|p| p.turn == turn_id && p.native_item == id)
                    .cloned()
                    .collect();
                for part in parts {
                    let final_text = item[part.stream][part.index]
                        .as_str()
                        .filter(|s| !s.is_empty());
                    self.complete_text(
                        BufKind::Reasoning,
                        turn_id,
                        &part.key,
                        final_text,
                        false,
                        out,
                    );
                    self.reasoning_parts.retain(|p| p.key != part.key);
                }
            }
            "agentMessage" => {
                let phase = item["phase"].as_str();
                let final_answer = phase.is_none_or(|p| p == "final_answer");
                if let Some(turn) = self.turns.get_mut(turn_id) {
                    if let Some(phase) = phase {
                        turn.message_phases.insert(id.clone(), phase.to_owned());
                    }
                    if final_answer && !turn.final_answer_ids.contains(&id) {
                        turn.final_answer_ids.push(id.clone());
                    }
                }
                let text = item["text"].as_str().unwrap_or_default().to_owned();
                self.complete_text(BufKind::Agent, turn_id, &id, Some(&text), true, out);
                if let Some(turn) = self.turns.get_mut(turn_id) {
                    turn.final_answer_ids.retain(|i| *i != id);
                }
            }
            "plan" => {
                let text = item["text"].as_str().filter(|t| !t.is_empty());
                self.complete_text(BufKind::Plan, turn_id, &id, text, true, out);
            }
            _ => {
                let completed = ms_time(&mut self.env, &p["completedAtMs"]);
                let Some(turn) = self.turns.get_mut(turn_id) else {
                    return;
                };
                match kind {
                    "contextCompaction" => {
                        turn.running_compactions.retain(|c| *c != id);
                        emit_compaction(turn, &id, "completed", &completed, out);
                    }
                    "commandExecution" => {
                        turn.running_commands.retain(|c| c.id != id);
                        command_artifacts(&mut self.env, turn, item, out);
                    }
                    "mcpToolCall" | "dynamicToolCall" => {
                        turn.running_tools.retain(|t| t["id"] != item["id"]);
                        tool_artifacts(&mut self.env, turn, item, None, out);
                    }
                    "fileChange" => {
                        turn.file_change_kinds.remove(&id);
                        file_change_artifacts(&mut self.env, turn, item, out);
                    }
                    "webSearch" => web_search_artifacts(&mut self.env, turn, item, true, out),
                    "imageView" => {
                        let path = item["path"].clone();
                        let tool = json!({
                            "type": "dynamicToolCall", "id": id, "tool": "view_image",
                            "arguments": {"path": path}, "status": "completed",
                        });
                        tool_artifacts(&mut self.env, turn, &tool, Some(path), out);
                    }
                    "userMessage" => {}
                    other => out.push(Out::Skipped(format!("item {other}"))),
                }
            }
        }
    }

    fn todo_list(&mut self, turn_id: &str, p: &Value, out: &mut Vec<Out>) {
        if !self.turns.contains_key(turn_id) {
            return;
        }
        let native_item = format!("turn-plan:{turn_id}");
        let plan_id = self.plan_id(turn_id, &native_item);
        let steps: Vec<Value> = p["plan"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, step)| {
                let text = trimmed(&step["step"]).unwrap_or_else(|| format!("Step {}", i + 1));
                let status = match step["status"].as_str() {
                    Some("completed") => "completed",
                    Some("inProgress") => "running",
                    _ => "pending",
                };
                json!({"id": format!("step-{}", i + 1), "text": text, "status": status})
            })
            .collect();
        let explanation = trimmed(&p["explanation"]);
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let now = self.env.now();
        let (ordinal, started_at) = turn.position(&native_item, now.clone());
        let node_id = ids::node_from_item(DRIVER, &native_item);
        let node = node_json(
            turn,
            &node_id,
            "todo_list",
            "running",
            &native_item,
            &started_at,
            None,
        );
        let mut plan = json!({
            "id": plan_id, "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
            "kind": "todo_list", "status": "active", "steps": steps,
        });
        let mut turn_item = item_json(
            turn,
            &native_item,
            &node_id,
            ordinal,
            "running",
            &started_at,
            None,
            &now,
        );
        extend(
            &mut turn_item,
            json!({"type": "todo_list", "planId": plan_id, "steps": steps}),
        );
        if let Some(explanation) = explanation {
            plan["explanation"] = json!(explanation);
            turn_item["explanation"] = json!(explanation);
        }
        push_event(out, json!({"type": "node.updated", "node": node}));
        push_event(out, json!({"type": "plan.updated", "plan": plan}));
        push_event(
            out,
            json!({"type": "turn_item.updated", "turnItem": turn_item}),
        );
    }

    /// After a rollback the thread's usage totals start over (`turnTokenUsageByThread`).
    pub fn forget_usage(&mut self, native_thread_id: &str) {
        self.usage.remove(native_thread_id);
    }

    fn token_usage(&mut self, turn_id: &str, p: &Value, out: &mut Vec<Out>) {
        let thread = p["threadId"].as_str().unwrap_or_default();
        let usage = &p["tokenUsage"];
        accumulate_usage(
            self.usage.entry(thread.to_owned()).or_default(),
            turn_id,
            usage,
        );
        let now = self.env.now();
        let Some(turn) = self.turns.get(turn_id) else {
            return;
        };
        let last = &usage["last"];
        let n = |v: &Value| v.as_i64().unwrap_or(0).max(0);
        let mut provider_turn = provider_turn_json(turn, "running", None);
        provider_turn["tokenUsage"] = json!({
            "usedTokens": n(&last["totalTokens"]),
            "maxTokens": usage["modelContextWindow"],
            "inputTokens": n(&last["inputTokens"]),
            "cachedInputTokens": n(&last["cachedInputTokens"]),
            "outputTokens": n(&last["outputTokens"]),
            "reasoningOutputTokens": n(&last["reasoningOutputTokens"]),
            "updatedAt": now,
        });
        push_event(
            out,
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": provider_turn}),
        );
    }

    fn mcp_status(&mut self, p: &Value, out: &mut Vec<Out>) {
        let Some(thread) = p["threadId"].as_str() else {
            return;
        };
        let name = p["name"].as_str().unwrap_or_default().to_owned();
        let failures = self.mcp_failures.entry(thread.to_owned()).or_default();
        failures.retain(|(n, _)| *n != name);
        if p["status"] != "failed" {
            if failures.is_empty() {
                self.mcp_failures.remove(thread);
            }
            return;
        }
        let message =
            trimmed(&p["error"]).unwrap_or_else(|| format!("MCP server {name} failed to start."));
        failures.push((name, message));
        let active = self
            .turns
            .values()
            .find(|t| t.native_thread_id == thread)
            .map(|t| t.native_turn_id.clone());
        if let Some(native) = active {
            self.emit_mcp_failures(&native, out);
        }
    }

    fn emit_mcp_failures(&mut self, native_turn: &str, out: &mut Vec<Out>) {
        let Some(turn) = self.turns.get_mut(native_turn) else {
            return;
        };
        let Some(failures) = self.mcp_failures.remove(&turn.native_thread_id) else {
            return;
        };
        for (name, message) in failures {
            let item = format!("mcp-startup-failed:{}:{name}", turn.provider_turn_id);
            let now = self.env.now();
            let (ordinal, started_at) = turn.position(&item, now);
            let mut turn_item = item_json(
                turn,
                &item,
                &turn.root_node_id.clone(),
                ordinal,
                "completed",
                &started_at,
                Some(&started_at),
                &started_at,
            );
            turn_item["nativeItemRef"]["strength"] = json!("weak");
            extend(
                &mut turn_item,
                json!({
                    "type": "system_notice", "title": format!("MCP server {name} failed to start"),
                    "message": message,
                }),
            );
            push_event(
                out,
                json!({"type": "turn_item.updated", "turnItem": turn_item}),
            );
        }
    }

    fn error(&mut self, turn_id: &str, p: &Value, _out: &mut Vec<Out>) {
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        if p["willRetry"] == true {
            // Retry rows are not projected; the turn keeps running.
            return;
        }
        let error = &p["error"];
        let code = error_info_code(&error["codexErrorInfo"]);
        let message = error["message"].as_str().unwrap_or_default().to_owned();
        let shown = trimmed(&error["additionalDetails"]).unwrap_or_else(|| message.clone());
        let class = if usage_limit(code.as_deref(), &error["codexErrorInfo"]) {
            "usage_limit"
        } else {
            "provider_error"
        };
        turn.latest_failure = Some((
            message,
            code.clone(),
            failure_json(class, &shown, code.as_deref(), None),
        ));
    }

    fn turn_completed(&mut self, p: &Value, out: &mut Vec<Out>) {
        let native = p["turn"]["id"].as_str().unwrap_or_default().to_owned();
        if !self.turns.contains_key(&native) {
            return;
        }
        let mut status = match p["turn"]["status"].as_str() {
            Some("interrupted") => "interrupted",
            Some("failed") => "failed",
            Some("completed") => "completed",
            _ => "running",
        };
        if status == "completed" && self.interrupting.contains(&native) {
            status = "interrupted";
        }
        let completed_at = codex_time(&mut self.env, &p["turn"]["completedAt"]);
        let error = &p["turn"]["error"];
        let message = error["message"].as_str();
        let info = (!error["codexErrorInfo"].is_null()).then(|| error["codexErrorInfo"].clone());
        self.finalize(&native, status, completed_at, message, info, out);
        self.interrupting.remove(&native);
    }

    /// `finalizeCodexTurn` for a root turn.
    fn finalize(
        &mut self,
        native: &str,
        status: &str,
        completed_at: String,
        failure_message: Option<&str>,
        failure_info: Option<Value>,
        out: &mut Vec<Out>,
    ) {
        if !self.turns.contains_key(native) {
            return;
        }
        if status != "completed" {
            self.ended_unfinished.insert(native.to_owned());
        }
        self.flush_turn(native, out);
        self.reasoning_parts.retain(|p| p.turn != native);
        let terminal_status = match status {
            "completed" | "interrupted" | "failed" | "cancelled" => status,
            _ => "failed",
        };
        let model = self.reported_model(native);
        let Some(mut turn) = self.turns.remove(native) else {
            return;
        };
        for id in std::mem::take(&mut turn.running_compactions) {
            emit_compaction(&mut turn, &id, terminal_status, &completed_at, out);
        }
        let usage = complete_usage(
            self.usage.entry(turn.native_thread_id.clone()).or_default(),
            native,
            status == "completed",
            model.as_deref(),
        );
        let mut provider_turn = provider_turn_json(&turn, status, Some(&completed_at));
        provider_turn["turnTokenUsage"] = usage;
        if let Some(model) = &model {
            provider_turn["model"] = json!(model);
        }
        push_event(
            out,
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": provider_turn}),
        );
        if status == "interrupted" || status == "failed" {
            for command in std::mem::take(&mut turn.running_commands) {
                terminal_command(&mut turn, &command, status, &completed_at, out);
            }
        }
        let tool_status = if status == "interrupted" || status == "failed" {
            status
        } else {
            "cancelled"
        };
        let include_persistent = tool_status != "cancelled";
        for tool in std::mem::take(&mut turn.running_tools) {
            if !include_persistent && tool["arguments"]["persistent"] == true {
                continue;
            }
            let mut tool = tool.clone();
            tool["status"] = json!("completed");
            let (mut node, mut turn_item) = tool_rows(&mut self.env, &mut turn, &tool, None);
            node["status"] = json!(tool_status);
            node["completedAt"] = json!(completed_at);
            turn_item["status"] = json!(tool_status);
            turn_item["completedAt"] = json!(completed_at);
            turn_item["updatedAt"] = json!(completed_at);
            push_event(out, json!({"type": "node.updated", "node": node}));
            push_event(
                out,
                json!({"type": "turn_item.updated", "turnItem": turn_item}),
            );
        }
        let failure = (terminal_status == "failed").then(|| {
            let code = failure_info.as_ref().and_then(error_info_code);
            let class = if usage_limit(
                code.as_deref(),
                failure_info.as_ref().unwrap_or(&Value::Null),
            ) {
                "usage_limit"
            } else {
                "provider_error"
            };
            match &turn.latest_failure {
                Some((native_message, native_code, failure))
                    if failure_message.is_none_or(|m| m == native_message)
                        && (code.is_none() || code == *native_code) =>
                {
                    failure.clone()
                }
                _ => failure_json(class, failure_message.unwrap_or(""), code.as_deref(), None),
            }
        });
        // The turn is gone: drop what was kept for it.
        self.ended_unfinished.remove(native);
        self.interrupting.remove(native);
        self.rerouted_turn_models.remove(native);
        self.plan_ids.retain(|_, (turn_id, _)| turn_id != native);
        self.ended.push_back(native.to_owned());
        while self.ended.len() > ENDED_TURNS_KEPT {
            self.ended.pop_front();
        }
        push_event(
            out,
            json!({
                "type": "turn.terminal",
                "providerThreadId": turn.provider_thread_id,
                "providerTurnId": turn.provider_turn_id,
                "runOrdinal": turn.run_ordinal,
                "status": terminal_status,
                "failure": failure,
                "threadDisposition": "reusable",
            }),
        );
    }

    /// `reportedTurnModel`: a reroute names one turn; after one, the thread model is unknown
    /// until new settings arrive.
    fn reported_model(&mut self, native_turn: &str) -> Option<String> {
        if let Some(model) = self.rerouted_turn_models.remove(native_turn) {
            return Some(model);
        }
        let thread = &self.turns.get(native_turn)?.native_thread_id;
        if self.rerouted_threads.contains(thread) {
            return None;
        }
        self.thread_models.get(thread).cloned()
    }

    // ---- server requests ------------------------------------------------------------------

    fn server_request(&mut self, id: Value, method: &str, p: &Value, out: &mut Vec<Out>) {
        let turn_id = p["turnId"].as_str().unwrap_or_default();
        let thread_id = p["threadId"]
            .as_str()
            .or_else(|| p["conversationId"].as_str())
            .unwrap_or_default()
            .to_owned();
        let native_turn = if method == "execCommandApproval" || method == "applyPatchApproval" {
            self.turns
                .values()
                .find(|t| t.native_thread_id == thread_id)
                .map(|t| t.native_turn_id.clone())
        } else {
            self.turns.contains_key(turn_id).then(|| turn_id.to_owned())
        };
        let known = matches!(
            method,
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
                | "item/tool/requestUserInput"
                | "execCommandApproval"
                | "applyPatchApproval"
        );
        if method == "mcpServer/elicitation/request" {
            // Field-less forms only in TS; not projected here, so every elicitation is declined.
            out.push(Out::Write(reply(&id, json!({"action": "decline"}))));
            out.push(Out::Skipped("request mcpServer/elicitation/request".into()));
            return;
        }
        if !known {
            out.push(Out::Write(reply_error(
                &id,
                -32601,
                &format!("Conn Server does not handle {method}"),
            )));
            out.push(Out::Skipped(format!("request {method}")));
            return;
        }
        let Some(native_turn) = native_turn else {
            out.push(Out::Write(reply_error(
                &id,
                -32603,
                &format!("No active Codex turn for {method}"),
            )));
            return;
        };
        let allowed = |kind| {
            self.allowances
                .get(&thread_id)
                .is_some_and(|(_, kinds)| kinds.contains(kind))
        };
        let (request_kind, item_id, native_request, prompt, kind) = match method {
            "item/commandExecution/requestApproval" => {
                if allowed("command") {
                    out.push(Out::Write(reply(
                        &id,
                        json!({"decision": "acceptForSession"}),
                    )));
                    return;
                }
                let item = p["itemId"].as_str().unwrap_or_default().to_owned();
                let native = p["approvalId"].as_str().unwrap_or(&item).to_owned();
                let prompt = p["reason"]
                    .as_str()
                    .or(p["command"].as_str())
                    .map(str::to_owned);
                (
                    "command",
                    item,
                    native,
                    prompt,
                    PendingKind::Decision {
                        allowance: Some("command"),
                    },
                )
            }
            "item/fileChange/requestApproval" => {
                if allowed("file-change") {
                    out.push(Out::Write(reply(
                        &id,
                        json!({"decision": "acceptForSession"}),
                    )));
                    return;
                }
                let item = p["itemId"].as_str().unwrap_or_default().to_owned();
                let kinds = self
                    .turns
                    .get(&native_turn)
                    .and_then(|t| t.file_change_kinds.get(&item))
                    .cloned()
                    .unwrap_or(Value::Null);
                let prompt = file_change_prompt(&p["reason"], &p["grantRoot"], &kinds);
                (
                    "file-change",
                    item.clone(),
                    item,
                    prompt,
                    PendingKind::Decision {
                        allowance: Some("file-change"),
                    },
                )
            }
            "item/permissions/requestApproval" => {
                let item = p["itemId"].as_str().unwrap_or_default().to_owned();
                let kind = permissions_kind(&p["permissions"]);
                let prompt = p["reason"].as_str().map(str::to_owned);
                (
                    kind,
                    item.clone(),
                    item,
                    prompt,
                    PendingKind::Permissions {
                        permissions: p["permissions"].clone(),
                    },
                )
            }
            "execCommandApproval" => {
                if allowed("command") {
                    out.push(Out::Write(reply(
                        &id,
                        json!({"decision": "approved_for_session"}),
                    )));
                    return;
                }
                let item = p["callId"].as_str().unwrap_or_default().to_owned();
                let native = p["approvalId"].as_str().unwrap_or(&item).to_owned();
                let command: Vec<&str> = p["command"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let prompt = p["reason"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| command.join(" "));
                (
                    "command",
                    item,
                    native,
                    Some(prompt),
                    PendingKind::Legacy {
                        allowance: "command",
                    },
                )
            }
            "applyPatchApproval" => {
                if allowed("file-change") {
                    out.push(Out::Write(reply(
                        &id,
                        json!({"decision": "approved_for_session"}),
                    )));
                    return;
                }
                let item = p["callId"].as_str().unwrap_or_default().to_owned();
                let prompt = file_change_prompt(&p["reason"], &p["grantRoot"], &p["fileChanges"]);
                (
                    "file-change",
                    item.clone(),
                    item,
                    prompt,
                    PendingKind::Legacy {
                        allowance: "file-change",
                    },
                )
            }
            _ => {
                let item = p["itemId"].as_str().unwrap_or_default().to_owned();
                let ids = p["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| q["id"].as_str().map(str::to_owned))
                    .collect();
                (
                    "user_input",
                    item.clone(),
                    item,
                    None,
                    PendingKind::UserInput { question_ids: ids },
                )
            }
        };
        let Some(turn) = self.turns.get_mut(&native_turn) else {
            return;
        };
        let uuid = self.env.uuid();
        let request_id =
            ids::runtime_request_id(DRIVER, &turn.provider_turn_id, &native_request, &uuid);
        let now = self.env.now();
        let session = turn.provider_session_id.clone();
        let (node, item, request) = if request_kind == "user_input" {
            user_input_artifacts(
                turn,
                &item_id,
                &native_request,
                &request_id,
                &p["questions"],
                &session,
                &now,
            )
        } else {
            approval_artifacts(
                turn,
                &item_id,
                &native_request,
                &request_id,
                request_kind,
                prompt.as_deref(),
                &session,
                &now,
            )
        };
        push_event(out, json!({"type": "node.updated", "node": node}));
        push_event(out, json!({"type": "turn_item.updated", "turnItem": item}));
        push_event(
            out,
            json!({"type": "runtime_request.updated", "threadId": turn.thread_id, "runtimeRequest": request}),
        );
        self.requests.insert(
            request_id,
            Pending {
                native_id: id,
                native_thread_id: thread_id,
                kind,
            },
        );
    }

    /// The user's answer to a pending request, as the reply line for the app-server.
    pub fn respond(&mut self, input: &RuntimeRequestResponse) -> Result<Vec<Out>, ProviderError> {
        let request_id = input.request_id.as_str();
        let Some(pending) = self.requests.get(request_id) else {
            return Err(ProviderError::Failed {
                operation: "respond_to_runtime_request",
                detail: format!("No pending Codex runtime request {request_id}."),
            });
        };
        let decision = input
            .decision
            .as_ref()
            .and_then(|d| to_json(d).as_str().map(str::to_owned));
        let missing = |what: &str| ProviderError::Failed {
            operation: "respond_to_runtime_request",
            detail: format!("Codex request {request_id} requires {what}."),
        };
        let mut remember = None;
        let result = match &pending.kind {
            PendingKind::UserInput { question_ids } => {
                let answers = input.answers.as_ref().ok_or_else(|| missing("answers"))?;
                let answers = to_json(answers);
                let mut map = Map::new();
                for (id, value) in answers.as_object().into_iter().flatten() {
                    if question_ids.contains(id) {
                        map.insert(id.clone(), json!({ "answers": answer_strings(value) }));
                    }
                }
                json!({ "answers": map })
            }
            PendingKind::Decision { allowance } => {
                let decision = decision.ok_or_else(|| missing("an approval decision"))?;
                if matches!(decision.as_str(), "acceptForSession" | "acceptAlways") {
                    remember = *allowance;
                }
                let decision = if decision == "acceptAlways" {
                    "acceptForSession".to_owned()
                } else {
                    decision
                };
                json!({ "decision": decision })
            }
            PendingKind::Legacy { allowance } => {
                let decision = decision.ok_or_else(|| missing("an approval decision"))?;
                if matches!(decision.as_str(), "acceptForSession" | "acceptAlways") {
                    remember = Some(*allowance);
                }
                let legacy = match decision.as_str() {
                    "accept" => json!("approved"),
                    "acceptForSession" | "acceptAlways" => json!("approved_for_session"),
                    "cancel" => json!("abort"),
                    _ => json!({"denied": {"rejection": "User declined the request."}}),
                };
                json!({ "decision": legacy })
            }
            PendingKind::Permissions { permissions } => {
                let decision = decision.ok_or_else(|| missing("an approval decision"))?;
                match decision.as_str() {
                    "accept" => json!({"permissions": permissions, "scope": "turn"}),
                    "acceptForSession" => json!({"permissions": permissions, "scope": "session"}),
                    _ => json!({"permissions": {}, "scope": "turn"}),
                }
            }
        };
        let Some(pending) = self.requests.remove(request_id) else {
            return Ok(Vec::new());
        };
        if let Some(kind) = remember {
            self.allowances
                .entry(pending.native_thread_id.clone())
                .or_insert_with(|| ("".into(), HashSet::new()))
                .1
                .insert(kind);
        }
        Ok(vec![Out::Write(reply(&pending.native_id, result))])
    }
}

// ---- artifact builders ----------------------------------------------------------------------

fn extend(target: &mut Value, extra: Value) {
    if let (Some(target), Value::Object(extra)) = (target.as_object_mut(), extra) {
        target.extend(extra);
    }
}

fn provider_turn_json(turn: &Turn, status: &str, completed_at: Option<&str>) -> Value {
    json!({
        "id": turn.provider_turn_id,
        "providerThreadId": turn.provider_thread_id,
        "nodeId": turn.root_node_id,
        "runAttemptId": turn.attempt_id,
        "nativeTurnRef": ref_strong(&turn.native_turn_id),
        "ordinal": turn.turn_ordinal,
        "status": status,
        "startedAt": turn.started_at,
        "completedAt": completed_at,
    })
}

fn node_json(
    turn: &Turn,
    node_id: &str,
    kind: &str,
    status: &str,
    native_item: &str,
    started_at: &str,
    completed_at: Option<&str>,
) -> Value {
    json!({
        "id": node_id,
        "threadId": turn.thread_id,
        "runId": turn.run_id,
        "parentNodeId": turn.root_node_id,
        "rootNodeId": turn.root_node_id,
        "kind": kind,
        "status": status,
        "countsForRun": false,
        "providerThreadId": turn.provider_thread_id,
        "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": ref_strong(native_item),
        "runtimeRequestId": null,
        "checkpointScopeId": null,
        "startedAt": started_at,
        "completedAt": completed_at,
    })
}

#[allow(clippy::too_many_arguments)]
fn item_json(
    turn: &Turn,
    native_item: &str,
    node_id: &str,
    ordinal: u32,
    status: &str,
    started_at: &str,
    completed_at: Option<&str>,
    updated_at: &str,
) -> Value {
    json!({
        "id": ids::turn_item_from_item(DRIVER, native_item),
        "threadId": turn.thread_id,
        "runId": turn.run_id,
        "nodeId": node_id,
        "providerThreadId": turn.provider_thread_id,
        "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": ref_strong(native_item),
        "parentItemId": null,
        "ordinal": ordinal,
        "status": status,
        "title": null,
        "startedAt": started_at,
        "completedAt": completed_at,
        "updatedAt": updated_at,
    })
}

/// `buildAgentMessageArtifacts`: node, message and turn item.
fn agent_artifacts(
    env: &mut impl Env,
    turn: &mut Turn,
    item: &str,
    text: &str,
    completed: bool,
) -> (Value, Value, Value) {
    let now = env.now();
    let completed_at = completed.then(|| now.clone());
    let (ordinal, started_at) = turn.position(item, now.clone());
    let node_id = ids::node_from_item(DRIVER, item);
    let message_id = ids::message_from_item(DRIVER, item);
    let status = if completed { "completed" } else { "running" };
    let node = node_json(
        turn,
        &node_id,
        "assistant_message",
        status,
        item,
        &started_at,
        completed_at.as_deref(),
    );
    let message = json!({
        "createdBy": "agent", "creationSource": "provider", "id": message_id,
        "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
        "role": "assistant", "text": text, "attachments": [], "streaming": !completed,
        "createdAt": started_at, "updatedAt": now,
    });
    let mut turn_item = item_json(
        turn,
        item,
        &node_id,
        ordinal,
        status,
        &started_at,
        completed_at.as_deref(),
        &now,
    );
    turn_item["type"] = json!("assistant_message");
    if let Some(phase) = turn.message_phases.get(item) {
        turn_item["phase"] = json!(phase);
    }
    extend(
        &mut turn_item,
        json!({"messageId": message_id, "text": text, "streaming": !completed}),
    );
    (node, message, turn_item)
}

fn emit_compaction(turn: &mut Turn, item: &str, status: &str, at: &str, out: &mut Vec<Out>) {
    let (ordinal, started_at) = turn.position(item, at.to_owned());
    let title = match status {
        "running" => "Compacting context",
        "completed" => "Context compacted",
        "failed" => "Context compaction failed",
        _ => "Context compaction stopped",
    };
    let completed_at = (status != "running").then_some(at);
    let mut turn_item = item_json(
        turn,
        item,
        &turn.root_node_id.clone(),
        ordinal,
        status,
        &started_at,
        completed_at,
        at,
    );
    extend(
        &mut turn_item,
        json!({"type": "compaction", "driver": DRIVER, "title": title}),
    );
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

/// `buildCommandExecutionArtifacts`, without `completionWake`: Conn Server has no background
/// continuation, so it does not promise one.
fn command_artifacts(env: &mut impl Env, turn: &mut Turn, item: &Value, out: &mut Vec<Out>) {
    let id = item["id"].as_str().unwrap_or_default();
    let now = env.now();
    let (node_status, item_status, completed) = item_status(&item["status"]);
    let completed_at = completed.then(|| now.clone());
    let (ordinal, started_at) = turn.position(id, now.clone());
    let node_id = ids::node_from_item(DRIVER, id);
    let node = node_json(
        turn,
        &node_id,
        "tool_call",
        node_status,
        id,
        &started_at,
        completed_at.as_deref(),
    );
    let mut turn_item = item_json(
        turn,
        id,
        &node_id,
        ordinal,
        item_status,
        &started_at,
        completed_at.as_deref(),
        &now,
    );
    extend(
        &mut turn_item,
        json!({"type": "command_execution", "input": item["command"]}),
    );
    if item["aggregatedOutput"].is_string() {
        turn_item["output"] = item["aggregatedOutput"].clone();
    }
    if item["exitCode"].is_number() {
        turn_item["exitCode"] = item["exitCode"].clone();
    }
    push_event(out, json!({"type": "node.updated", "node": node}));
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

fn terminal_command(
    turn: &mut Turn,
    command: &RunningCommand,
    status: &str,
    at: &str,
    out: &mut Vec<Out>,
) {
    let (ordinal, started_at) = turn.position(&command.id, at.to_owned());
    let node_id = ids::node_from_item(DRIVER, &command.id);
    let node = node_json(
        turn,
        &node_id,
        "tool_call",
        status,
        &command.id,
        &started_at,
        Some(at),
    );
    let mut turn_item = item_json(
        turn,
        &command.id,
        &node_id,
        ordinal,
        status,
        &started_at,
        Some(at),
        at,
    );
    extend(
        &mut turn_item,
        json!({"type": "command_execution", "input": command.command}),
    );
    if let Some(output) = &command.output {
        turn_item["output"] = json!(output);
    }
    push_event(out, json!({"type": "node.updated", "node": node}));
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

/// `buildDynamicToolArtifacts` with a plain projection: tool name, input, output. TS also adds
/// MCP presentation (titles, icons, surfaces) and app references.
fn tool_artifacts(
    env: &mut impl Env,
    turn: &mut Turn,
    item: &Value,
    viewed_image: Option<Value>,
    out: &mut Vec<Out>,
) {
    let (node, turn_item) = tool_rows(env, turn, item, viewed_image);
    push_event(out, json!({"type": "node.updated", "node": node}));
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

/// The node and turn item of a dynamic or MCP tool call.
fn tool_rows(
    env: &mut impl Env,
    turn: &mut Turn,
    item: &Value,
    viewed_image: Option<Value>,
) -> (Value, Value) {
    let id = item["id"].as_str().unwrap_or_default();
    let now = env.now();
    let (node_status, item_status, completed) = item_status(&item["status"]);
    let completed_at = completed.then(|| now.clone());
    let (ordinal, started_at) = turn.position(id, now.clone());
    let node_id = ids::node_from_item(DRIVER, id);
    let tool_name = if item["type"] == "mcpToolCall" {
        format!(
            "{}.{}",
            item["server"].as_str().unwrap_or_default(),
            item["tool"].as_str().unwrap_or_default()
        )
    } else {
        [
            trimmed(&item["namespace"]),
            item["tool"].as_str().map(str::to_owned),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(".")
    };
    let output = if item["type"] == "mcpToolCall" {
        match (&item["result"], item["error"]["message"].as_str()) {
            (Value::Null, None) => None,
            (result, None) => Some(
                json!({"content": result["content"], "structuredContent": result["structuredContent"]}),
            ),
            (Value::Null, Some(error)) => Some(json!({ "error": error })),
            (result, Some(error)) => Some(json!({"error": error, "result": result})),
        }
    } else if item["contentItems"].is_array() {
        Some(item["contentItems"].clone())
    } else if item["success"] == false {
        Some(json!({"success": false}))
    } else {
        None
    };
    let node = node_json(
        turn,
        &node_id,
        "tool_call",
        node_status,
        id,
        &started_at,
        completed_at.as_deref(),
    );
    let mut turn_item = item_json(
        turn,
        id,
        &node_id,
        ordinal,
        item_status,
        &started_at,
        completed_at.as_deref(),
        &now,
    );
    extend(
        &mut turn_item,
        json!({"type": "dynamic_tool", "toolName": tool_name, "input": item["arguments"]}),
    );
    if let Some(output) = output {
        turn_item["output"] = output;
    }
    if let Some(path) = viewed_image {
        turn_item["viewedImagePath"] = path;
    }
    (node, turn_item)
}

fn file_change_artifacts(env: &mut impl Env, turn: &mut Turn, item: &Value, out: &mut Vec<Out>) {
    let Some(first) = item["changes"].as_array().and_then(|c| c.first()) else {
        return;
    };
    let id = item["id"].as_str().unwrap_or_default();
    let now = env.now();
    let (node_status, item_status, completed) = item_status(&item["status"]);
    let completed_at = completed.then(|| now.clone());
    let (ordinal, started_at) = turn.position(id, now.clone());
    let node_id = ids::node_from_item(DRIVER, id);
    let changes: Vec<Value> = item["changes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let op = &c["kind"]["type"];
            match c["kind"]["move_path"].as_str().filter(|_| op == "update") {
                Some(to) => json!({"operation": op, "path": to, "oldPath": c["path"]}),
                None => json!({"operation": op, "path": c["path"]}),
            }
        })
        .collect();
    let node = node_json(
        turn,
        &node_id,
        "tool_call",
        node_status,
        id,
        &started_at,
        completed_at.as_deref(),
    );
    let mut turn_item = item_json(
        turn,
        id,
        &node_id,
        ordinal,
        item_status,
        &started_at,
        completed_at.as_deref(),
        &now,
    );
    extend(
        &mut turn_item,
        json!({
            "type": "file_change", "fileName": first["path"], "diffStr": first["diff"], "changes": changes,
        }),
    );
    push_event(out, json!({"type": "node.updated", "node": node}));
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

fn web_search_artifacts(
    env: &mut impl Env,
    turn: &mut Turn,
    item: &Value,
    completed: bool,
    out: &mut Vec<Out>,
) {
    let id = item["id"].as_str().unwrap_or_default();
    let now = env.now();
    let completed_at = completed.then(|| now.clone());
    let (ordinal, started_at) = turn.position(id, now.clone());
    let node_id = ids::node_from_item(DRIVER, id);
    let status = if completed { "completed" } else { "running" };
    let action = &item["action"];
    let mut candidates: Vec<&Value> = Vec::new();
    match action["type"].as_str() {
        Some("search") => {
            candidates.extend(action["queries"].as_array().into_iter().flatten());
            candidates.extend([&action["query"], &item["query"]]);
        }
        Some("openPage") => candidates.extend([&action["url"], &item["query"]]),
        Some("findInPage") => {
            candidates.extend([&action["pattern"], &action["url"], &item["query"]])
        }
        _ => candidates.push(&item["query"]),
    }
    let patterns: Vec<String> = candidates.into_iter().filter_map(trimmed).collect();
    let node = node_json(
        turn,
        &node_id,
        "tool_call",
        status,
        id,
        &started_at,
        completed_at.as_deref(),
    );
    let mut turn_item = item_json(
        turn,
        id,
        &node_id,
        ordinal,
        status,
        &started_at,
        completed_at.as_deref(),
        &now,
    );
    turn_item["type"] = json!("web_search");
    if !patterns.is_empty() {
        turn_item["patterns"] = json!(patterns);
    }
    push_event(out, json!({"type": "node.updated", "node": node}));
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": turn_item}),
    );
}

#[allow(clippy::too_many_arguments)]
fn approval_artifacts(
    turn: &mut Turn,
    item_id: &str,
    native_request: &str,
    request_id: &str,
    kind: &str,
    prompt: Option<&str>,
    session: &Value,
    now: &str,
) -> (Value, Value, Value) {
    let (ordinal, _) = turn.position(
        &format!("{item_id}:approval:{native_request}"),
        now.to_owned(),
    );
    let node_id = ids::approval_node(request_id);
    let node = json!({
        "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
        "parentNodeId": ids::node_from_item(DRIVER, item_id), "rootNodeId": turn.root_node_id,
        "kind": "approval_request", "status": "waiting", "countsForRun": false,
        "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": ref_strong(item_id), "runtimeRequestId": request_id,
        "checkpointScopeId": null, "startedAt": now, "completedAt": null,
    });
    let request = runtime_request_json(
        turn,
        request_id,
        &node_id,
        native_request,
        kind,
        json!({"type": "live", "providerSessionId": session}),
        now,
    );
    let mut turn_item = json!({
        "id": ids::approval_turn_item(request_id), "threadId": turn.thread_id, "runId": turn.run_id,
        "nodeId": node_id, "providerThreadId": turn.provider_thread_id,
        "providerTurnId": turn.provider_turn_id, "nativeItemRef": ref_strong(item_id),
        "parentItemId": null, "ordinal": ordinal, "status": "waiting", "title": null,
        "startedAt": now, "completedAt": null, "updatedAt": now, "type": "approval_request",
        "requestId": request_id, "requestKind": kind,
    });
    if let Some(prompt) = prompt {
        turn_item["prompt"] = json!(prompt);
    }
    (node, turn_item, request)
}

fn runtime_request_json(
    turn: &Turn,
    request_id: &str,
    node_id: &str,
    native_request: &str,
    kind: &str,
    capability: Value,
    now: &str,
) -> Value {
    json!({
        "id": request_id, "nodeId": node_id, "providerTurnId": turn.provider_turn_id,
        "nativeRequestRef": ref_strong(native_request), "kind": kind, "status": "pending",
        "responseCapability": capability, "createdAt": now, "resolvedAt": null,
    })
}

fn user_input_artifacts(
    turn: &mut Turn,
    item_id: &str,
    native_request: &str,
    request_id: &str,
    questions: &Value,
    session: &Value,
    now: &str,
) -> (Value, Value, Value) {
    let text = |v: &Value, fallback: String| trimmed(v).unwrap_or(fallback);
    let questions: Vec<Value> = questions
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, q)| {
            let options: Vec<Value> = q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(j, o)| {
                    let label = text(&o["label"], format!("Option {}", j + 1));
                    let description = trimmed(&o["description"])
                        .or_else(|| o["label"].as_str().map(str::to_owned))
                        .unwrap_or_default();
                    json!({"label": label, "description": description})
                })
                .collect();
            json!({
                "id": text(&q["id"], format!("question-{}", i + 1)),
                "header": text(&q["header"], "Question".into()),
                "question": text(&q["question"], "Choose an answer.".into()),
                "options": options,
            })
        })
        .collect();
    let (ordinal, _) = turn.position(item_id, now.to_owned());
    let node_id = ids::node_from_item(DRIVER, item_id);
    let mut node = node_json(
        turn,
        &node_id,
        "user_input_request",
        "waiting",
        item_id,
        now,
        None,
    );
    node["runtimeRequestId"] = json!(request_id);
    let request = runtime_request_json(
        turn,
        request_id,
        &node_id,
        native_request,
        "user_input",
        json!({"type": "live", "providerSessionId": session}),
        now,
    );
    let mut turn_item = item_json(turn, item_id, &node_id, ordinal, "waiting", now, None, now);
    extend(
        &mut turn_item,
        json!({"type": "user_input_request", "requestId": request_id, "questions": questions}),
    );
    (node, turn_item, request)
}

/// `codexFileChangeApprovalPrompt`: the reason, else the changed paths, else the grant root.
fn file_change_prompt(reason: &Value, grant_root: &Value, kinds: &Value) -> Option<String> {
    if let Some(reason) = trimmed(reason) {
        return Some(reason);
    }
    let mut entries: Vec<(&String, &Value)> = kinds.as_object().into_iter().flatten().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    if !entries.is_empty() {
        let described: Vec<String> = entries
            .iter()
            .take(20)
            .map(|(path, change)| {
                let kind = change["type"].as_str().unwrap_or_default();
                match change["move_path"].as_str().filter(|_| kind == "update") {
                    Some(to) => format!("{kind} {path} -> {to}"),
                    None => format!("{kind} {path}"),
                }
            })
            .collect();
        let more = entries.len() - described.len();
        let text = described.join("\n");
        return Some(if more > 0 {
            format!("{text}\n+{more} more")
        } else {
            text
        });
    }
    trimmed(grant_root)
}

/// `providerRequestKindFromPermissions`.
fn permissions_kind(permissions: &Value) -> &'static str {
    let fs = &permissions["fileSystem"];
    let requests = |access: &str| {
        fs[access].as_array().is_some_and(|a| !a.is_empty())
            || fs["entries"]
                .as_array()
                .is_some_and(|e| e.iter().any(|x| x["access"] == access))
    };
    if requests("write") {
        "file-change"
    } else if requests("read") {
        "file-read"
    } else {
        "command"
    }
}

fn answer_strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| i.to_string())
            })
            .collect(),
        Value::String(s) => vec![s.clone()],
        Value::Null => vec![],
        other => vec![other.to_string()],
    }
}

fn error_info_code(info: &Value) -> Option<String> {
    match info {
        Value::String(s) => Some(s.clone()),
        Value::Object(map) => map.keys().next().cloned(),
        _ => None,
    }
}

fn usage_limit(code: Option<&str>, info: &Value) -> bool {
    matches!(code, Some("usageLimitExceeded" | "rateLimitExceeded"))
        || info["responseTooManyFailedAttempts"]["httpStatusCode"] == 429
}

fn failure_json(class: &str, message: &str, code: Option<&str>, retryable: Option<bool>) -> Value {
    let message = if message.trim().is_empty() {
        "Provider turn failed."
    } else {
        message
    };
    let message: String = message.chars().take(4096).collect();
    let code: Option<String> = code.map(|c| c.chars().take(128).collect());
    json!({"class": class, "message": message, "code": code, "retryable": retryable})
}

// ---- token usage (`CodexTurnTokenUsage.ts`) --------------------------------------------------

/// `[input, cached, cacheWrite, output, reasoning]` from a usage breakdown.
fn breakdown(v: &Value) -> [Option<u64>; 5] {
    [
        v["inputTokens"].as_u64(),
        v["cachedInputTokens"].as_u64(),
        v["cacheWriteInputTokens"].as_u64(),
        v["outputTokens"].as_u64(),
        v["reasoningOutputTokens"].as_u64(),
    ]
}

fn accumulate_usage(state: &mut UsageState, turn_id: &str, usage: &Value) {
    let current = breakdown(&usage["total"]);
    if state.active_turn.as_deref() != Some(turn_id) {
        state.baseline = Some(current);
        return;
    }
    let last = breakdown(&usage["last"]);
    let g = |a: [Option<u64>; 5], i: usize| a[i].unwrap_or(0);
    let delta: [Option<u64>; 5] = match state.baseline {
        Some(prev) if [0, 1, 3, 4].iter().all(|&i| g(current, i) >= g(prev, i)) => {
            let cache = match (current[2], prev[2]) {
                (Some(c), Some(p)) if c >= p => Some(c - p),
                _ => None,
            };
            [
                Some(g(current, 0) - g(prev, 0)),
                Some(g(current, 1) - g(prev, 1)),
                cache,
                Some(g(current, 3) - g(prev, 3)),
                Some(g(current, 4) - g(prev, 4)),
            ]
        }
        _ => last,
    };
    state.baseline = Some(current);
    let acc = state.acc.entry(turn_id.to_owned()).or_default();
    if [0, 1, 3, 4].iter().any(|&i| g(delta, i) > 0) {
        acc.observed = true;
    }
    acc.input += g(delta, 0);
    acc.cached += g(delta, 1);
    acc.output += g(delta, 3);
    acc.reasoning += g(delta, 4);
    acc.cache_creation = match (delta[2], acc.cache_creation) {
        (None, _) => None,
        (Some(d), Some(c)) => Some(c + d),
        (Some(_), None) => None,
    };
}

fn complete_usage(
    state: &mut UsageState,
    turn_id: &str,
    completed: bool,
    model: Option<&str>,
) -> Value {
    let acc = state.acc.remove(turn_id);
    if state.active_turn.as_deref() == Some(turn_id) {
        state.active_turn = None;
    }
    let mut out = match acc.filter(|a| a.observed) {
        None => {
            json!({"usageStatus": "unavailable", "usageScope": "main_agent", "hasSubagents": false})
        }
        Some(a) => {
            let mut v = json!({
                "usageStatus": if completed { "complete" } else { "partial" },
                "usageScope": "main_agent",
                "inputTokens": a.input,
                "cachedInputTokens": a.cached.min(a.input),
                "outputTokens": a.output,
                "reasoningTokens": a.reasoning.min(a.output),
                "hasSubagents": false,
            });
            if let Some(c) = a.cache_creation {
                v["cacheCreationTokens"] = json!(c.min(a.input));
            }
            v
        }
    };
    if let Some(model) = model {
        out["models"] = json!([model]);
    }
    out
}

impl Default for UsageAcc {
    fn default() -> Self {
        Self {
            input: 0,
            cached: 0,
            cache_creation: Some(0),
            output: 0,
            reasoning: 0,
            observed: false,
        }
    }
}
