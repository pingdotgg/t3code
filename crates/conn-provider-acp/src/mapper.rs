//! The turn state machine of one ACP session: agent frames in, `ProviderEvent`s and replies
//! out. Pure (time and uuids come from an [`Env`]), so the recorded transcripts drive it
//! exactly. The rules follow `makeAcpAdapterV2` (`packages/provider-acp/src/server/adapter.ts`)
//! for the parts listed in the README; the rest is skipped and logged once per kind.
//!
//! State is per turn: [`Mapper::finalize`] drops the turn, its text, tools and ordinals. Across
//! turns the mapper keeps one provider thread row and the pending runtime requests (each one
//! removed when answered or when its turn ends).

use std::collections::{HashMap, HashSet, VecDeque};

use conn_contract::to_json;
use conn_provider::{ProviderEvent, TurnInput};
use conn_provider_support::ids::{self, Env, encode_component, join_id};
use serde_json::{Map, Value, json};

use crate::flavor::Flavor;
use crate::ordered::{J, obj};
use crate::protocol::RequestId;
use crate::tools::{self, ToolState};

/// What the mapper asks its session to do.
#[derive(Debug)]
#[expect(
    clippy::large_enum_variant,
    reason = "each out moves once into the delivery"
)]
pub(crate) enum Out {
    Event(ProviderEvent),
    /// A reply to an agent request.
    Reply {
        id: RequestId,
        result: J,
    },
    /// The turn's text changed after its first emission: flush it in 50 ms
    /// (`ACP_TEXT_FLUSH_INTERVAL`).
    ScheduleFlush,
}

/// `ActiveTextStream` kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextKind {
    User,
    Assistant,
    Reasoning,
}

impl TextKind {
    fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Reasoning => "reasoning",
        }
    }
}

#[derive(Clone, Debug)]
struct Segment {
    native_item_id: String,
    started_at: String,
    source_message_id: Option<String>,
    text: String,
    emitted: bool,
    dirty: bool,
}

#[derive(Debug, Default)]
struct TextStream {
    current: Option<Segment>,
    next_segment: u32,
    closed_named: HashMap<String, Segment>,
}

/// One running turn (`ActiveAcpTurn`, the parts this crate serves).
#[derive(Debug)]
struct Turn {
    thread_id: String,
    run_id: String,
    run_ordinal: u32,
    provider_turn_ordinal: u32,
    root_node_id: String,
    attempt_id: String,
    provider_thread: Value,
    provider_turn_id: String,
    native_thread_id: String,
    native_turn_id: String,
    started_at: String,
    item_ordinals: HashMap<String, u32>,
    user: TextStream,
    assistant: TextStream,
    reasoning: TextStream,
    tools: HashMap<String, ToolState>,
    tool_started_at: HashMap<String, String>,
    tool_skips: HashMap<String, u32>,
    /// Native plan id → (plan id, started at, latest plan).
    plans: HashMap<String, (String, String, Option<Value>)>,
    interrupted: bool,
    native_metadata: Value,
    context_usage: Value,
    /// `isCompactionMessage`: the turn's message is exactly `/compact` with no attachments.
    compaction_message: bool,
    /// `isCompactCommand`: `/compact`, optionally with preservation instructions.
    compact_command: bool,
}

/// How many compaction ids a session remembers (`completedCompactionIds`); older ones fall out.
const COMPACTION_IDS_KEPT: usize = 128;

/// A runtime request waiting for the user (`pendingRuntimeRequests`).
#[derive(Debug, Clone)]
pub(crate) struct PendingRequest {
    pub agent_id: RequestId,
    pub kind: Pending,
}

#[derive(Debug, Clone)]
pub(crate) enum Pending {
    /// A permission: the agent's `(optionId, kind)` choices.
    Approval(Vec<(String, String)>),
    /// Grok's `ask_user_question`: its params, for the answer's shape.
    XAiQuestion(Value),
}

/// How a prompt settled.
#[derive(Debug, Clone)]
pub(crate) enum PromptOutcome {
    /// `stopReason` from the reply (or Grok's `prompt_complete`).
    Stopped(String),
    /// The request failed: T3's `makeProviderFailure` of the error.
    Failed { message: String, code: Option<i64> },
}

pub(crate) struct Mapper<E: Env> {
    env: E,
    flavor: &'static Flavor,
    instance_id: String,
    provider_session_id: String,
    turn: Option<Turn>,
    /// The session's provider thread row, once `ensure_thread` made it.
    provider_thread: Option<Value>,
    native_metadata: Option<Value>,
    context_usage: Option<Value>,
    pending: HashMap<String, PendingRequest>,
    logged: HashSet<String>,
    /// `compactionMarkers`: set when the session compacted, so the next prompt resends T3's
    /// instructions and runtime notes. Each mark is a new number, so a late prompt success
    /// cannot clear a later compaction.
    compaction_marker: Option<u64>,
    marker_seq: u64,
    /// `completedCompactionIds`: an agent may patch a completed compaction again.
    completed_compactions: VecDeque<String>,
}

impl<E: Env> std::fmt::Debug for Mapper<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mapper")
            .field("instance_id", &self.instance_id)
            .finish_non_exhaustive()
    }
}

impl<E: Env> Mapper<E> {
    pub(crate) fn new(
        env: E,
        flavor: &'static Flavor,
        instance_id: &str,
        provider_session_id: &str,
    ) -> Self {
        Self {
            env,
            flavor,
            instance_id: instance_id.to_owned(),
            provider_session_id: provider_session_id.to_owned(),
            turn: None,
            provider_thread: None,
            native_metadata: None,
            context_usage: None,
            pending: HashMap::new(),
            logged: HashSet::new(),
            compaction_marker: None,
            marker_seq: 0,
            completed_compactions: VecDeque::new(),
        }
    }

    // ---- compaction ----------------------------------------------------------------------

    /// `markSessionCompacted`. With an id, each compaction marks the session once.
    pub(crate) fn mark_compacted(&mut self, compaction_id: Option<&str>) {
        if let Some(id) = compaction_id {
            if self.completed_compactions.iter().any(|known| known == id) {
                return;
            }
            if self.completed_compactions.len() >= COMPACTION_IDS_KEPT {
                self.completed_compactions.pop_front();
            }
            self.completed_compactions.push_back(id.to_owned());
        }
        self.marker_seq += 1;
        self.compaction_marker = Some(self.marker_seq);
    }

    /// The current compaction marker, read when a prompt is built.
    pub(crate) fn compaction_marker(&self) -> Option<u64> {
        self.compaction_marker
    }

    /// A prompt that carried T3's instructions succeeded: the compaction it saw is handled,
    /// unless a newer one came since.
    pub(crate) fn clear_compaction_marker(&mut self, observed: Option<u64>) {
        if observed.is_some() && self.compaction_marker == observed {
            self.compaction_marker = None;
        }
    }

    /// A new runtime starts without compaction state (`restartRuntimeAfterTeardownIfRequired`).
    pub(crate) fn reset_compaction(&mut self) {
        self.compaction_marker = None;
        self.completed_compactions.clear();
    }

    fn driver(&self) -> &'static str {
        self.flavor.driver
    }

    /// `acpScopedNativeId` (item identity version 2).
    fn scoped(&self, native_id: &str) -> String {
        format!(
            "provider-instance:{}:{native_id}",
            encode_component(&self.instance_id)
        )
    }

    fn node_id(&self, native_item_id: &str) -> String {
        ids::node_from_item(self.driver(), &self.scoped(native_item_id))
    }

    fn message_id(&self, native_item_id: &str) -> String {
        ids::message_from_item(self.driver(), &self.scoped(native_item_id))
    }

    fn turn_item_id(&self, native_item_id: &str) -> String {
        ids::turn_item_from_item(self.driver(), &self.scoped(native_item_id))
    }

    pub(crate) fn has_turn(&self) -> bool {
        self.turn.is_some()
    }

    pub(crate) fn turn_interrupted(&self) -> bool {
        self.turn.as_ref().is_some_and(|turn| turn.interrupted)
    }

    pub(crate) fn current_provider_turn_id(&self) -> Option<&str> {
        self.turn
            .as_ref()
            .map(|turn| turn.provider_turn_id.as_str())
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Skipped input, logged once per kind so a chatty agent cannot fill the log.
    pub(crate) fn skip(&mut self, kind: &str) {
        if self.logged.len() < 64 && self.logged.insert(kind.to_owned()) {
            eprintln!("acp {}: skipped {kind}", self.flavor.driver);
        }
    }

    fn event(&mut self, value: Value, out: &mut Vec<Out>) {
        match serde_json::from_value::<ProviderEvent>(value) {
            Ok(event) => out.push(Out::Event(event)),
            Err(error) => {
                let kind = format!("an event that does not decode ({error})");
                self.skip(&kind);
            }
        }
    }

    // ---- threads -------------------------------------------------------------------------

    /// `makeProviderThread` for `ensureThread`.
    pub(crate) fn make_provider_thread(&mut self, app_thread_id: &str, session_id: &str) -> Value {
        let now = self.env.now();
        let id = join_id(
            "provider-thread",
            &[
                "provider",
                self.driver(),
                "provider-instance",
                &self.instance_id,
                "native-thread",
                session_id,
            ],
        );
        let thread = json!({
            "id": id,
            "driver": self.driver(),
            "providerInstanceId": self.instance_id,
            "providerSessionId": self.provider_session_id,
            "appThreadId": app_thread_id,
            "ownerNodeId": null,
            "nativeThreadRef": {"driver": self.driver(), "nativeId": session_id, "strength": "strong"},
            "nativeConversationHeadRef": null,
            "status": "idle",
            "firstRunOrdinal": null,
            "lastRunOrdinal": null,
            "handoffIds": [],
            "forkedFrom": null,
            "contextUsage": null,
            "nativeMetadata": {"itemIdentityVersion": 2},
            "createdAt": now,
            "updatedAt": now,
        });
        self.provider_thread = Some(thread.clone());
        thread
    }

    // ---- turns ---------------------------------------------------------------------------

    /// `startTurnUnlocked` up to the prompt: the running turn and the active thread.
    /// `user_text` is the message text the prompt carries (`/compact` normalized).
    pub(crate) fn begin_turn(
        &mut self,
        input: &TurnInput,
        session_id: &str,
        user_text: &str,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        let started_at = self.env.now();
        let native_turn_id = format!("{session_id}:turn:{}", input.provider_turn_ordinal);
        let provider_turn_id = ids::provider_turn_id(self.driver(), &self.scoped(&native_turn_id));
        let provider_thread = to_json(&input.provider_thread);
        let thread_metadata = provider_thread
            .get("nativeMetadata")
            .cloned()
            .unwrap_or(Value::Null);
        let native_metadata = match (&self.native_metadata, thread_metadata) {
            (Some(remembered), Value::Object(mut base)) => {
                if let Value::Object(extra) = remembered {
                    for (k, v) in extra {
                        base.insert(k.clone(), v.clone());
                    }
                }
                Value::Object(base)
            }
            (Some(remembered), _) => remembered.clone(),
            (None, other) => other,
        };
        if !native_metadata.is_null() {
            self.native_metadata = Some(native_metadata.clone());
        }
        let context_usage = self.context_usage.clone().unwrap_or_else(|| {
            provider_thread
                .get("contextUsage")
                .cloned()
                .unwrap_or(Value::Null)
        });
        let no_attachments = input.message.attachments.is_empty();
        let trimmed = user_text.trim();
        let compaction_message = no_attachments && trimmed == "/compact";
        let compact_command = no_attachments
            && trimmed
                .strip_prefix("/compact")
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
        let turn = Turn {
            thread_id: input.thread_id.as_str().to_owned(),
            run_id: input.run_id.as_str().to_owned(),
            run_ordinal: input.run_ordinal,
            provider_turn_ordinal: input.provider_turn_ordinal,
            root_node_id: input.root_node_id.as_str().to_owned(),
            attempt_id: input.attempt_id.as_str().to_owned(),
            provider_thread,
            provider_turn_id,
            native_thread_id: session_id.to_owned(),
            native_turn_id,
            started_at,
            item_ordinals: HashMap::new(),
            user: TextStream::default(),
            assistant: TextStream::default(),
            reasoning: TextStream::default(),
            tools: HashMap::new(),
            tool_started_at: HashMap::new(),
            tool_skips: HashMap::new(),
            plans: HashMap::new(),
            interrupted: false,
            native_metadata,
            context_usage,
            compaction_message,
            compact_command,
        };
        let running = self.provider_turn_payload(&turn, "running", None);
        self.event(
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": running}),
            &mut out,
        );
        let mut thread = turn.provider_thread.clone();
        set(
            &mut thread,
            "providerSessionId",
            json!(self.provider_session_id),
        );
        set(&mut thread, "status", json!("active"));
        set(&mut thread, "contextUsage", turn.context_usage.clone());
        set(&mut thread, "nativeMetadata", turn.native_metadata.clone());
        set(&mut thread, "updatedAt", json!(turn.started_at));
        self.provider_thread = Some(thread.clone());
        self.event(
            json!({"type": "provider_thread.updated", "providerThread": thread}),
            &mut out,
        );
        self.turn = Some(turn);
        out
    }

    fn provider_turn_payload(
        &self,
        turn: &Turn,
        status: &str,
        completed_at: Option<&str>,
    ) -> Value {
        let mut payload = json!({
            "id": turn.provider_turn_id,
            "providerThreadId": turn.provider_thread["id"],
            "nodeId": turn.root_node_id,
            "runAttemptId": turn.attempt_id,
            "nativeTurnRef": {"driver": self.driver(), "nativeId": turn.native_turn_id, "strength": "weak"},
            "ordinal": turn.provider_turn_ordinal,
            "status": status,
            "startedAt": turn.started_at,
            "completedAt": completed_at,
        });
        if status != "running" && status != "pending" {
            // `acpPerTurnPromptUsage` without per-turn counters: unavailable.
            set(
                &mut payload,
                "turnTokenUsage",
                json!({"usageScope": "main_agent", "usageStatus": "unavailable", "hasSubagents": false}),
            );
        }
        payload
    }

    fn resolve_ordinal(turn: &mut Turn, native_item_id: &str) -> u32 {
        if let Some(existing) = turn.item_ordinals.get(native_item_id) {
            return *existing;
        }
        let size = u32::try_from(turn.item_ordinals.len()).unwrap_or(u32::MAX - 1);
        let ordinal = turn
            .provider_turn_ordinal
            .saturating_mul(100)
            .saturating_add(size)
            .saturating_add(1);
        turn.item_ordinals
            .insert(native_item_id.to_owned(), ordinal);
        ordinal
    }

    // ---- text ----------------------------------------------------------------------------

    fn stream(turn: &mut Turn, kind: TextKind) -> &mut TextStream {
        match kind {
            TextKind::User => &mut turn.user,
            TextKind::Assistant => &mut turn.assistant,
            TextKind::Reasoning => &mut turn.reasoning,
        }
    }

    /// `emitTextSegment`. `flush` is a delayed flush: it emits only unsent text.
    fn emit_text(&mut self, kind: TextKind, completed: bool, flush: bool, out: &mut Vec<Out>) {
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        let segment = {
            let stream = Self::stream(&mut turn, kind);
            let Some(segment) = stream.current.as_mut() else {
                self.turn = Some(turn);
                return;
            };
            if flush && !segment.dirty {
                self.turn = Some(turn);
                return;
            }
            let emits_node = completed || !segment.emitted;
            segment.emitted = true;
            segment.dirty = false;
            (segment.clone(), emits_node)
        };
        let (segment, emits_node) = segment;
        let ordinal = Self::resolve_ordinal(&mut turn, &segment.native_item_id);
        let node_id = self.node_id(&segment.native_item_id);
        let turn_item_id = self.turn_item_id(&segment.native_item_id);
        let native_ref = json!({"driver": self.driver(), "nativeId": segment.native_item_id, "strength": "weak"});
        let completed_at = if completed { json!(now) } else { Value::Null };
        let status = if completed { "completed" } else { "running" };
        if kind != TextKind::User && emits_node {
            self.event(
                json!({"type": "node.updated", "node": {
                    "id": node_id,
                    "threadId": turn.thread_id,
                    "runId": turn.run_id,
                    "parentNodeId": turn.root_node_id,
                    "rootNodeId": turn.root_node_id,
                    "kind": if kind == TextKind::Assistant { "assistant_message" } else { "reasoning" },
                    "status": status,
                    "countsForRun": false,
                    "providerThreadId": turn.provider_thread["id"],
                    "providerTurnId": turn.provider_turn_id,
                    "nativeItemRef": native_ref,
                    "runtimeRequestId": null,
                    "checkpointScopeId": null,
                    "startedAt": segment.started_at,
                    "completedAt": completed_at,
                }}),
                out,
            );
        }
        if kind == TextKind::Reasoning {
            self.event(
                json!({"type": "turn_item.updated", "turnItem": {
                    "id": turn_item_id,
                    "threadId": turn.thread_id,
                    "runId": turn.run_id,
                    "nodeId": node_id,
                    "providerThreadId": turn.provider_thread["id"],
                    "providerTurnId": turn.provider_turn_id,
                    "nativeItemRef": native_ref,
                    "parentItemId": null,
                    "ordinal": ordinal,
                    "status": status,
                    "title": null,
                    "startedAt": segment.started_at,
                    "completedAt": completed_at,
                    "updatedAt": now,
                    "type": "reasoning",
                    "text": segment.text,
                    "streaming": !completed,
                }}),
                out,
            );
            self.turn = Some(turn);
            return;
        }
        let message_id = self.message_id(&segment.native_item_id);
        let message_node_id = if kind == TextKind::User {
            turn.root_node_id.clone()
        } else {
            node_id.clone()
        };
        self.event(
            json!({"type": "message.updated", "message": {
                "createdBy": if kind == TextKind::User { "user" } else { "agent" },
                "creationSource": "provider",
                "id": message_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "nodeId": message_node_id,
                "role": kind.label(),
                "text": segment.text,
                "attachments": [],
                "streaming": !completed,
                "createdAt": segment.started_at,
                "updatedAt": now,
            }}),
            out,
        );
        let item = if kind == TextKind::User {
            json!({
                "createdBy": "user",
                "creationSource": "provider",
                "id": turn_item_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "nodeId": message_node_id,
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "nativeItemRef": native_ref,
                "parentItemId": null,
                "ordinal": ordinal,
                "status": status,
                "title": null,
                "startedAt": segment.started_at,
                "completedAt": completed_at,
                "updatedAt": now,
                "type": "user_message",
                "messageId": message_id,
                "inputIntent": "turn_start",
                "text": segment.text,
                "attachments": [],
            })
        } else {
            json!({
                "id": turn_item_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "nodeId": node_id,
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "nativeItemRef": native_ref,
                "parentItemId": null,
                "ordinal": ordinal,
                "status": status,
                "title": null,
                "startedAt": segment.started_at,
                "completedAt": completed_at,
                "updatedAt": now,
                "type": "assistant_message",
                "messageId": message_id,
                "text": segment.text,
                "streaming": !completed,
            })
        };
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
        self.turn = Some(turn);
    }

    /// `publishTextSegment`: the first text emits at once, later text on the next flush.
    fn publish_text(&mut self, kind: TextKind, out: &mut Vec<Out>) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let Some(segment) = Self::stream(turn, kind).current.as_mut() else {
            return;
        };
        if !segment.emitted {
            self.emit_text(kind, false, false, out);
            return;
        }
        if segment.dirty {
            return;
        }
        segment.dirty = true;
        out.push(Out::ScheduleFlush);
    }

    /// A delayed flush of every dirty stream (the session's 50 ms timer).
    pub(crate) fn flush_text(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        for kind in [TextKind::User, TextKind::Reasoning, TextKind::Assistant] {
            self.emit_text(kind, false, true, &mut out);
        }
        out
    }

    fn close_text(&mut self, kind: TextKind, out: &mut Vec<Out>) {
        let has_segment = self
            .turn
            .as_mut()
            .is_some_and(|turn| Self::stream(turn, kind).current.is_some());
        if !has_segment {
            return;
        }
        self.emit_text(kind, true, false, out);
        if let Some(turn) = self.turn.as_mut() {
            let stream = Self::stream(turn, kind);
            if let Some(segment) = stream.current.take()
                && let Some(source) = segment.source_message_id.clone()
            {
                // Bounded by the agent's message ids within one turn; dropped with the turn.
                stream.closed_named.insert(source, segment);
            }
        }
    }

    fn close_texts(&mut self, out: &mut Vec<Out>) {
        self.close_text(TextKind::User, out);
        self.close_text(TextKind::Reasoning, out);
        self.close_text(TextKind::Assistant, out);
    }

    /// `appendText`.
    fn append_text(
        &mut self,
        kind: TextKind,
        text: &str,
        message_id: Option<&str>,
        out: &mut Vec<Out>,
    ) {
        if text.is_empty() || self.turn.is_none() {
            return;
        }
        for other in [TextKind::User, TextKind::Reasoning, TextKind::Assistant] {
            if other != kind {
                self.close_text(other, out);
            }
        }
        let source = message_id.filter(|id| !id.is_empty()).map(str::to_owned);
        let switches = self.turn.as_mut().is_some_and(|turn| {
            let stream = Self::stream(turn, kind);
            matches!((&stream.current, &source), (Some(current), Some(source))
                if current.source_message_id.as_ref().is_some_and(|id| id != source))
        });
        if switches {
            self.close_text(kind, out);
        }
        let now = self.env.now();
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let native_turn_id = turn.native_turn_id.clone();
        let stream = Self::stream(turn, kind);
        match stream.current.as_mut() {
            None => {
                let reopened = source
                    .as_ref()
                    .and_then(|id| stream.closed_named.get(id).cloned());
                let segment = match reopened {
                    Some(closed) => Segment {
                        emitted: false,
                        dirty: false,
                        ..closed
                    },
                    None => {
                        let native_item_id = match &source {
                            None => {
                                format!("{native_turn_id}:{}:{}", kind.label(), stream.next_segment)
                            }
                            Some(id) => format!("{native_turn_id}:{}:message:{id}", kind.label()),
                        };
                        stream.next_segment += 1;
                        Segment {
                            native_item_id,
                            started_at: now,
                            source_message_id: source,
                            text: String::new(),
                            emitted: false,
                            dirty: false,
                        }
                    }
                };
                stream.current = Some(segment);
            }
            Some(segment) => {
                if segment.source_message_id.is_none() && source.is_some() {
                    segment.source_message_id = source;
                }
            }
        }
        if let Some(segment) = stream.current.as_mut() {
            segment.text.push_str(text);
        }
        self.publish_text(kind, out);
    }

    // ---- agent frames --------------------------------------------------------------------

    /// One `session/update` notification (or a flavor's mirror of one).
    pub(crate) fn session_update(&mut self, params: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        let session_id = params["sessionId"].as_str().unwrap_or("").to_owned();
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        // Turn projection misses compactions that finish while idle or after settlement.
        if kind == "compaction_update"
            && update["status"] == "completed"
            && let Some(id) = update["compactionId"].as_str()
        {
            self.mark_compacted(Some(&format!("{session_id}\u{0}{id}")));
        }
        match kind {
            "compaction_update" => {
                if let Some(state) = tools::compaction_tool(update) {
                    self.tool_updated(state, None, &mut out);
                }
            }
            "compaction_summary_chunk" => {
                if let (Some(text), Some(id)) = (
                    content_display_text(&update["content"]),
                    update["compactionId"].as_str(),
                ) {
                    let tool_call_id = format!("acp-compaction:{id}");
                    let previous = self
                        .turn
                        .as_ref()
                        .and_then(|turn| turn.tools.get(&tool_call_id).cloned())
                        .unwrap_or_else(|| tools::compaction_placeholder(&tool_call_id));
                    let appended = tools::append_output_text(previous, &text);
                    self.tool_updated(appended, None, &mut out);
                }
            }
            "usage_update" | "session_info_update" => {
                self.session_state_update(&session_id, kind, update, &mut out);
            }
            "agent_message_chunk" => {
                if let Some(text) = content_display_text(&update["content"]) {
                    let message_id = update["messageId"].as_str().map(str::to_owned);
                    self.append_text(TextKind::Assistant, &text, message_id.as_deref(), &mut out);
                }
            }
            "agent_thought_chunk" => {
                if update["content"]["type"] == "text"
                    && let Some(text) = update["content"]["text"].as_str()
                {
                    let text = text.to_owned();
                    self.append_text(TextKind::Reasoning, &text, None, &mut out);
                }
            }
            "tool_call" | "tool_call_update" => {
                let fallback = (kind == "tool_call").then_some("pending");
                if let Some(state) = tools::parse_tool_call(update, fallback) {
                    self.tool_updated(state, None, &mut out);
                }
            }
            "plan" => {
                let steps: Vec<(String, String)> = update["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, e)| {
                        let text = e["content"].as_str().unwrap_or("").trim().to_owned();
                        let text = if text.is_empty() {
                            format!("Step {}", i + 1)
                        } else {
                            text
                        };
                        (text, plan_step_status(&e["status"]))
                    })
                    .collect();
                self.emit_plan("legacy", PlanUpdate::Items(steps), &mut out);
            }
            "plan_update" => {
                let plan = &update["plan"];
                let id = plan["planId"].as_str().unwrap_or("").trim().to_owned();
                if !id.is_empty() {
                    let content = match plan["type"].as_str() {
                        Some("items") if plan["entries"].is_array() => PlanUpdate::Items(
                            plan["entries"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .enumerate()
                                .filter_map(|(i, e)| {
                                    let text = e["content"].as_str()?.trim().to_owned();
                                    let text = if text.is_empty() {
                                        format!("Step {}", i + 1)
                                    } else {
                                        text
                                    };
                                    let status = if e["status"].is_string() {
                                        e["status"].clone()
                                    } else {
                                        json!("pending")
                                    };
                                    Some((text, plan_step_status(&status)))
                                })
                                .collect(),
                        ),
                        Some("markdown") if plan["content"].is_string() => {
                            PlanUpdate::Markdown(plan["content"].as_str().unwrap_or("").to_owned())
                        }
                        Some("file") if plan["uri"].is_string() => PlanUpdate::Markdown(format!(
                            "Plan file: {}",
                            plan["uri"].as_str().unwrap_or("")
                        )),
                        other => PlanUpdate::Markdown(format!(
                            "[Unsupported ACP plan content: {}]",
                            other.unwrap_or("undefined")
                        )),
                    };
                    self.emit_plan(&id, content, &mut out);
                }
            }
            "plan_removed" => {
                let id = update["planId"].as_str().unwrap_or("").trim().to_owned();
                if !id.is_empty() {
                    self.emit_plan(&id, PlanUpdate::Removed, &mut out);
                }
            }
            "available_commands_update" | "current_mode_update" | "config_option_update" => {}
            "user_message_chunk" => {}
            other => {
                let label = format!("session/update {other}");
                self.skip(&label);
            }
        }
        out
    }

    fn session_state_update(
        &mut self,
        session_id: &str,
        kind: &str,
        update: &Value,
        out: &mut Vec<Out>,
    ) {
        if kind == "usage_update" {
            let mut usage = Map::new();
            usage.insert("usedTokens".into(), update["used"].clone());
            if update["size"].as_f64().is_some_and(|size| size > 0.0) {
                usage.insert("maxTokens".into(), update["size"].clone());
            }
            if let Some(cost) = update.get("cost").filter(|c| c.is_object()) {
                let currency: String = cost["currency"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(32)
                    .collect();
                if !currency.is_empty() {
                    usage.insert(
                        "cost".into(),
                        json!({"amount": cost["amount"], "currency": currency}),
                    );
                }
            }
            let usage = Value::Object(usage);
            self.context_usage = Some(usage.clone());
            if let Some(turn) = self.turn.as_mut()
                && turn.native_thread_id == session_id
            {
                turn.context_usage = usage;
            }
        } else {
            let mut metadata = match &self.native_metadata {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            if update.get("title") == Some(&Value::Null) {
                metadata.insert("title".into(), Value::Null);
            } else if let Some(title) = update["title"].as_str() {
                let title: String = title.trim().chars().take(1024).collect();
                if !title.is_empty() {
                    metadata.insert("title".into(), json!(title));
                }
            }
            if update.get("updatedAt") == Some(&Value::Null) {
                metadata.insert("updatedAt".into(), Value::Null);
            } else if let Some(at) = update["updatedAt"].as_str() {
                let at: String = at.trim().chars().take(128).collect();
                if !at.is_empty() {
                    metadata.insert("updatedAt".into(), json!(at));
                }
            }
            let metadata = Value::Object(metadata);
            self.native_metadata = Some(metadata.clone());
            if let Some(turn) = self.turn.as_mut()
                && turn.native_thread_id == session_id
            {
                turn.native_metadata = metadata;
            }
        }
        let now = self.env.now();
        let Some(thread) = self.provider_thread.as_mut() else {
            return;
        };
        if thread["nativeThreadRef"]["nativeId"] != session_id {
            return;
        }
        let usage = self
            .context_usage
            .clone()
            .unwrap_or_else(|| thread["contextUsage"].clone());
        let metadata = self
            .native_metadata
            .clone()
            .unwrap_or_else(|| thread["nativeMetadata"].clone());
        set(thread, "contextUsage", usage);
        set(thread, "nativeMetadata", metadata);
        set(thread, "updatedAt", json!(now));
        let thread = thread.clone();
        self.event(
            json!({"type": "provider_thread.updated", "providerThread": thread}),
            out,
        );
    }

    // ---- tools ---------------------------------------------------------------------------

    /// A tool call's state changed (`emitTool` for the root turn): merged with what the
    /// turn knows, normalized by the flavor, and emitted unless nothing visible changed.
    fn tool_updated(&mut self, incoming: ToolState, projected: Option<&str>, out: &mut Vec<Out>) {
        let Some(turn) = self.turn.as_mut() else {
            self.skip("a tool update with no turn running");
            return;
        };
        // Named segments stay open across a tool; unnamed ones close.
        let close_assistant = turn
            .assistant
            .current
            .as_ref()
            .is_some_and(|s| s.source_message_id.is_none());
        let close_reasoning = turn
            .reasoning
            .current
            .as_ref()
            .is_some_and(|s| s.source_message_id.is_none());
        if close_assistant {
            self.close_text(TextKind::Assistant, out);
        }
        if close_reasoning {
            self.close_text(TextKind::Reasoning, out);
        }
        self.close_text(TextKind::User, out);
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let key = incoming.tool_call_id.clone();
        let previous = turn.tools.get(&key).cloned();
        let merged = tools::merge(previous.as_ref(), incoming);
        let reported = merged.status.clone();
        let tool = match self.flavor.normalize_tool {
            Some(normalize) => normalize(merged),
            None => merged,
        };
        turn.tools.insert(key.clone(), tool.clone());
        if projected.is_none() {
            let skipped = turn.tool_skips.get(&key).copied().unwrap_or(0);
            let persist = matches!(reported.as_deref(), Some("completed" | "failed"))
                || previous.as_ref().is_none_or(|p| {
                    p.status != tool.status
                        || p.title != tool.title
                        || tools::visible_output_changed(p, &tool)
                })
                || skipped + 1 >= 10;
            turn.tool_skips
                .insert(key, if persist { 0 } else { skipped + 1 });
            if !persist {
                return;
            }
        }
        // `stoppedToolStatus`: after Stop a failure shows as the interruption it was.
        let stopped =
            (turn.interrupted && tool.status.as_deref() == Some("failed")).then_some("interrupted");
        self.emit_tool(&tool, previous.as_ref(), projected.or(stopped), out);
    }

    /// `emitTool` for the root turn: the tool's node and turn item.
    fn emit_tool(
        &mut self,
        tool: &ToolState,
        _previous: Option<&ToolState>,
        projected: Option<&str>,
        out: &mut Vec<Out>,
    ) {
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        let item_native = format!("{}:tool:{}", turn.native_thread_id, tool.tool_call_id);
        let node_id = self.node_id(&item_native);
        let turn_item_id = self.turn_item_id(&item_native);
        let native_ref =
            json!({"driver": self.driver(), "nativeId": tool.tool_call_id, "strength": "strong"});
        let status = projected
            .map(str::to_owned)
            .unwrap_or_else(|| tools::item_status(tool.status.as_deref()).to_owned());
        let started_at = turn
            .tool_started_at
            .entry(tool.tool_call_id.clone())
            .or_insert_with(|| now.clone())
            .clone();
        let ordinal = Self::resolve_ordinal(&mut turn, &item_native);
        let completed_at = tools::completed_at(&status, &now);
        self.event(
            json!({"type": "node.updated", "node": {
                "id": node_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "parentNodeId": turn.root_node_id,
                "rootNodeId": turn.root_node_id,
                "kind": "tool_call",
                "status": tools::node_status(&status),
                "countsForRun": true,
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "nativeItemRef": native_ref,
                "runtimeRequestId": null,
                "checkpointScopeId": null,
                "startedAt": started_at,
                "completedAt": completed_at,
            }}),
            out,
        );
        let base = json!({
            "id": turn_item_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": node_id,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "parentItemId": null,
            "ordinal": ordinal,
            "status": status,
            "title": tool.title.clone().map_or(Value::Null, Value::String),
            "startedAt": started_at,
            "completedAt": completed_at,
            "updatedAt": now,
        });
        let item = if let Some(compaction_id) = tool.tool_call_id.strip_prefix("acp-compaction:") {
            let mut item = base;
            set(&mut item, "type", json!("compaction"));
            set(&mut item, "driver", json!(self.driver()));
            let raw_output = tool
                .data
                .get("rawOutput")
                .or_else(|| tool.data.get("content"));
            if let Some(summary) = raw_output.and_then(tools::text_from_unknown) {
                set(&mut item, "summary", json!(summary));
            }
            if let Some(used) = turn
                .context_usage
                .get("usedTokens")
                .filter(|v| !v.is_null())
            {
                set(&mut item, "beforeTokenCount", used.clone());
            }
            if status == "completed" {
                turn.context_usage = Value::Null;
                self.context_usage = None;
                // A completion projected at turn end must not swallow the agent's later one.
                let key = format!("{}\u{0}{compaction_id}", turn.native_thread_id);
                self.mark_compacted(projected.is_none().then_some(key.as_str()));
            }
            item
        } else {
            tools::project_turn_item(tool, &status, base)
        };
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
        self.turn = Some(turn);
    }

    /// `terminalizeOpenForegroundTools` / `terminalizeOpenRunOwnedItems`: open tools end with
    /// the turn.
    fn terminalize_open_tools(&mut self, status: &str, out: &mut Vec<Out>) {
        let open: Vec<ToolState> = self
            .turn
            .as_ref()
            .map(|turn| {
                let mut tools: Vec<&ToolState> = turn
                    .tools
                    .values()
                    .filter(|tool| {
                        matches!(
                            tools::item_status(tool.status.as_deref()),
                            "pending" | "running" | "waiting"
                        )
                    })
                    .collect();
                // Map order is arbitrary; T3 walks insertion order. Ordinals record it.
                tools.sort_by_key(|tool| {
                    turn.item_ordinals
                        .get(&format!(
                            "{}:tool:{}",
                            turn.native_thread_id, tool.tool_call_id
                        ))
                        .copied()
                        .unwrap_or(u32::MAX)
                });
                tools.into_iter().cloned().collect()
            })
            .unwrap_or_default();
        for tool in open {
            self.emit_tool(&tool, None, Some(status), out);
        }
    }

    // ---- plans ---------------------------------------------------------------------------

    /// `emitPlan`.
    fn emit_plan(&mut self, native_plan_id: &str, update: PlanUpdate, out: &mut Vec<Out>) {
        if self.turn.is_none() {
            self.skip("a plan with no turn running");
            return;
        }
        self.close_texts(out);
        let removed = matches!(update, PlanUpdate::Removed);
        let exists = self
            .turn
            .as_ref()
            .is_some_and(|t| t.plans.contains_key(native_plan_id));
        if removed && !exists {
            return;
        }
        let now = self.env.now();
        let uuid = self.env.uuid();
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        let native_item_id = format!(
            "{}:plan:{}",
            turn.native_turn_id,
            encode_component(native_plan_id)
        );
        let ordinal = Self::resolve_ordinal(&mut turn, &native_item_id);
        let node_id = self.node_id(&native_item_id);
        let turn_item_id = self.turn_item_id(&native_item_id);
        let (plan_id, started_at, latest) =
            turn.plans.get(native_plan_id).cloned().unwrap_or_else(|| {
                (
                    ids::plan_id(&turn.thread_id, Some(&turn.run_id), self.driver(), &uuid),
                    now.clone(),
                    None,
                )
            });
        let base = json!({"id": plan_id, "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id});
        let plan = match update {
            PlanUpdate::Removed => {
                let Some(mut latest) = latest else {
                    self.turn = Some(turn);
                    return;
                };
                set(&mut latest, "status", json!("superseded"));
                latest
            }
            PlanUpdate::Items(entries) => {
                let any = !entries.is_empty();
                let steps: Vec<Value> = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, (_, status))| status != "cancelled")
                    .map(|(i, (text, status))| {
                        json!({
                            "id": format!("acp-step-{}", i + 1),
                            "text": text,
                            "status": match status.as_str() {
                                "inProgress" => "running",
                                "completed" => "completed",
                                _ => "pending",
                            },
                        })
                    })
                    .collect();
                let completed = any && steps.iter().all(|s| s["status"] == "completed");
                let mut plan = base;
                set(
                    &mut plan,
                    "status",
                    json!(if completed { "completed" } else { "active" }),
                );
                set(&mut plan, "kind", json!("todo_list"));
                set(&mut plan, "steps", Value::Array(steps));
                plan
            }
            PlanUpdate::Markdown(markdown) => {
                let mut plan = base;
                set(&mut plan, "status", json!("active"));
                set(&mut plan, "kind", json!("proposed_plan"));
                set(&mut plan, "markdown", json!(markdown));
                plan
            }
        };
        turn.plans.insert(
            native_plan_id.to_owned(),
            (plan_id.clone(), started_at.clone(), Some(plan.clone())),
        );
        let completed = plan["status"] == "completed" || plan["status"] == "superseded";
        let todo = plan["kind"] == "todo_list";
        let native_ref =
            json!({"driver": self.driver(), "nativeId": native_item_id, "strength": "weak"});
        let completed_at = if completed { json!(now) } else { Value::Null };
        let status = if completed { "completed" } else { "running" };
        self.event(
            json!({"type": "node.updated", "node": {
                "id": node_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "parentNodeId": turn.root_node_id,
                "rootNodeId": turn.root_node_id,
                "kind": if todo { "todo_list" } else { "plan" },
                "status": status,
                "countsForRun": false,
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "nativeItemRef": native_ref,
                "runtimeRequestId": null,
                "checkpointScopeId": null,
                "startedAt": started_at,
                "completedAt": completed_at,
            }}),
            out,
        );
        self.event(json!({"type": "plan.updated", "plan": plan}), out);
        let mut item = json!({
            "id": turn_item_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": node_id,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "parentItemId": null,
            "ordinal": ordinal,
            "status": status,
            "title": null,
            "startedAt": started_at,
            "completedAt": completed_at,
            "updatedAt": now,
        });
        if todo {
            set(&mut item, "type", json!("todo_list"));
            set(&mut item, "planId", json!(plan_id));
            set(&mut item, "steps", plan["steps"].clone());
        } else {
            set(&mut item, "type", json!("proposed_plan"));
            set(&mut item, "planId", json!(plan_id));
            set(&mut item, "markdown", plan["markdown"].clone());
            set(&mut item, "streaming", json!(!completed));
        }
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
        self.turn = Some(turn);
    }

    // ---- permissions ---------------------------------------------------------------------

    /// The tool kind the turn already tracks for a call (Kiro omits it on the permission).
    pub(crate) fn tracked_tool_kind(&self, tool_call_id: &str) -> Option<String> {
        self.turn
            .as_ref()
            .and_then(|turn| turn.tools.get(tool_call_id))
            .and_then(|tool| tool.kind.clone())
    }

    /// `withTrackedPermissionToolCall`: fills title, kind and input from the tracked call.
    pub(crate) fn with_tracked_tool(&self, params: &Value) -> Value {
        let mut params = params.clone();
        let Some(turn) = self.turn.as_ref() else {
            return params;
        };
        let Some(id) = params["toolCall"]["toolCallId"].as_str() else {
            return params;
        };
        let Some(tracked) = turn.tools.get(id) else {
            return params;
        };
        let tool = &mut params["toolCall"];
        if tool.get("title").is_none()
            && let Some(title) = tracked.data.get("title").and_then(Value::as_str)
        {
            tool["title"] = json!(title);
        }
        if tool.get("kind").is_none() && tracked.kind.as_deref() == Some("execute") {
            tool["kind"] = json!("execute");
        }
        if tool.get("rawInput").is_none()
            && let Some(raw) = tracked.data.get("rawInput")
        {
            tool["rawInput"] = raw.clone();
        }
        params
    }

    /// `session/request_permission` that T3 asks the user about (`beginApprovalRequest`).
    /// `params` already carries the tracked tool's fields.
    pub(crate) fn permission_request(&mut self, id: RequestId, params: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        let options = permission_options(params);
        if self.turn.is_none() {
            out.push(Out::Reply {
                id,
                result: obj().with("outcome", obj().with("outcome", "cancelled")),
            });
            return out;
        }
        self.close_texts(&mut out);
        let uuid = self.env.uuid();
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return out;
        };
        let tool_call = &params["toolCall"];
        let native_request_id = tool_call["toolCallId"].as_str().unwrap_or("").to_owned();
        // `parsePermissionRequest`.
        let parsed = tools::parse_tool_call(tool_call, Some("pending"));
        let kind = tool_call["kind"]
            .as_str()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let detail = parsed
            .as_ref()
            .and_then(|t| {
                t.command
                    .clone()
                    .or_else(|| t.title.clone())
                    .or_else(|| t.detail.clone())
            })
            .or_else(|| params["sessionId"].as_str().map(|s| format!("Session {s}")));
        let request_kind = tools::request_kind(kind);
        let request_id = ids::runtime_request_id(
            self.driver(),
            &turn.provider_turn_id,
            &native_request_id,
            &uuid,
        );
        let node_id = ids::approval_node(&request_id);
        let turn_item_id = ids::approval_turn_item(&request_id);
        let ordinal_key = format!("{}:approval:{native_request_id}", turn.native_turn_id);
        let ordinal = Self::resolve_ordinal(&mut turn, &ordinal_key);
        let native_ref =
            json!({"driver": self.driver(), "nativeId": native_request_id, "strength": "weak"});
        let runtime_request = json!({
            "id": request_id,
            "nodeId": node_id,
            "providerTurnId": turn.provider_turn_id,
            "nativeRequestRef": native_ref,
            "kind": request_kind,
            "status": "pending",
            "responseCapability": {"type": "live", "providerSessionId": self.provider_session_id},
            "createdAt": now,
            "resolvedAt": null,
        });
        let node = json!({
            "id": node_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "parentNodeId": turn.root_node_id,
            "rootNodeId": turn.root_node_id,
            "kind": "approval_request",
            "status": "waiting",
            "countsForRun": false,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "runtimeRequestId": request_id,
            "checkpointScopeId": null,
            "startedAt": now,
            "completedAt": null,
        });
        let mut turn_item = json!({
            "id": turn_item_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": node_id,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "parentItemId": null,
            "ordinal": ordinal,
            "status": "waiting",
            "title": null,
            "startedAt": now,
            "completedAt": null,
            "updatedAt": now,
            "type": "approval_request",
            "requestId": request_id,
            "requestKind": request_kind,
        });
        if let Some(detail) = detail {
            turn_item["prompt"] = json!(detail);
        }
        turn_item["options"] = (self.flavor.approval_options)(&options);
        self.event(json!({"type": "node.updated", "node": node}), &mut out);
        self.event(
            json!({"type": "runtime_request.updated", "threadId": turn.thread_id, "runtimeRequest": runtime_request}),
            &mut out,
        );
        self.event(
            json!({"type": "turn_item.updated", "turnItem": turn_item}),
            &mut out,
        );
        self.pending.insert(
            request_id,
            PendingRequest {
                agent_id: id,
                kind: Pending::Approval(options),
            },
        );
        self.turn = Some(turn);
        out
    }

    /// Answers a pending runtime request. `None` when no such request is pending, or when an
    /// approval comes without a decision. The orchestrator resolves the request rows itself.
    pub(crate) fn respond(
        &mut self,
        request_id: &str,
        decision: Option<&str>,
        answers: Option<&Value>,
    ) -> Option<Vec<Out>> {
        let pending = self.pending.get(request_id)?;
        let result = match &pending.kind {
            Pending::Approval(options) => match select_option(options, decision?) {
                Some(option) => selected(&option),
                None => obj().with("outcome", obj().with("outcome", "cancelled")),
            },
            Pending::XAiQuestion(params) => match answers {
                Some(answers) => crate::grok::question_response(params, answers),
                None => obj().with("outcome", "cancelled"),
            },
        };
        let pending = self.pending.remove(request_id)?;
        Some(vec![Out::Reply {
            id: pending.agent_id,
            result,
        }])
    }

    /// `beginUserInputRequest`: a question the user answers.
    pub(crate) fn user_input_request(
        &mut self,
        id: RequestId,
        native_item_id: &str,
        native_request_id: &str,
        questions: Value,
        kind: Pending,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        if self.turn.is_none() {
            // `activeContext` fails: the agent gets an error reply.
            self.skip("a question with no turn running");
            return out;
        }
        self.close_texts(&mut out);
        let uuid = self.env.uuid();
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return out;
        };
        let request_id = ids::runtime_request_id(
            self.driver(),
            &turn.provider_turn_id,
            native_request_id,
            &uuid,
        );
        let node_id = self.node_id(native_item_id);
        let turn_item_id = self.turn_item_id(native_item_id);
        let native_ref =
            json!({"driver": self.driver(), "nativeId": native_item_id, "strength": "weak"});
        let ordinal = Self::resolve_ordinal(&mut turn, native_item_id);
        let runtime_request = json!({
            "id": request_id,
            "nodeId": node_id,
            "providerTurnId": turn.provider_turn_id,
            "nativeRequestRef": {"driver": self.driver(), "nativeId": native_request_id, "strength": "weak"},
            "kind": "user_input",
            "status": "pending",
            "responseCapability": {"type": "live", "providerSessionId": self.provider_session_id},
            "createdAt": now,
            "resolvedAt": null,
        });
        let node = json!({
            "id": node_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "parentNodeId": turn.root_node_id,
            "rootNodeId": turn.root_node_id,
            "kind": "user_input_request",
            "status": "waiting",
            "countsForRun": false,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "runtimeRequestId": request_id,
            "checkpointScopeId": null,
            "startedAt": now,
            "completedAt": null,
        });
        let turn_item = json!({
            "id": turn_item_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": node_id,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "parentItemId": null,
            "ordinal": ordinal,
            "status": "waiting",
            "title": null,
            "startedAt": now,
            "completedAt": null,
            "updatedAt": now,
            "type": "user_input_request",
            "requestId": request_id,
            "questions": questions,
        });
        self.event(json!({"type": "node.updated", "node": node}), &mut out);
        self.event(
            json!({"type": "runtime_request.updated", "threadId": turn.thread_id, "runtimeRequest": runtime_request}),
            &mut out,
        );
        self.event(
            json!({"type": "turn_item.updated", "turnItem": turn_item}),
            &mut out,
        );
        self.pending
            .insert(request_id, PendingRequest { agent_id: id, kind });
        self.turn = Some(turn);
        out
    }

    /// `cancelPendingRuntimeRequests`: every open request of the turn is cancelled, and the
    /// agent gets the cancelled outcome.
    fn cancel_pending(&mut self, out: &mut Vec<Out>) {
        let ids: Vec<String> = self.pending.keys().cloned().collect();
        for id in ids {
            if let Some(more) = self.respond(&id, Some("cancel"), None) {
                out.extend(more);
            }
        }
    }

    // ---- settle --------------------------------------------------------------------------

    pub(crate) fn mark_interrupted(&mut self) {
        if let Some(turn) = self.turn.as_mut() {
            turn.interrupted = true;
        }
    }

    /// The prompt settled: finalize with the status its outcome gives.
    pub(crate) fn prompt_settled(&mut self, outcome: PromptOutcome) -> Vec<Out> {
        let interrupted = self.turn_interrupted();
        match outcome {
            PromptOutcome::Stopped(reason) => {
                let status = if reason == "cancelled" {
                    if interrupted {
                        "interrupted"
                    } else {
                        "cancelled"
                    }
                } else {
                    "completed"
                };
                self.finalize(status, None)
            }
            PromptOutcome::Failed { message, code } => {
                let status = if interrupted { "interrupted" } else { "failed" };
                let failure = (self.flavor.prompt_failure)(&message, code);
                self.finalize(status, Some(failure))
            }
        }
    }

    /// `finalizeTurn`.
    pub(crate) fn finalize(&mut self, status: &str, failure: Option<Value>) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(interrupted) = self.turn.as_ref().map(|turn| turn.interrupted) else {
            return out;
        };
        let settled = if interrupted { "interrupted" } else { status };
        if settled == "completed" {
            self.terminalize_open_tools("completed", &mut out);
        } else if settled == "interrupted" {
            self.terminalize_open_tools("interrupted", &mut out);
        }
        self.close_texts(&mut out);
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return out;
        };
        if self.flavor.supports_compaction && settled == "completed" {
            if turn.compact_command {
                self.mark_compacted(None);
            }
            let has_compaction_tool = turn
                .tools
                .keys()
                .any(|id| id.starts_with("acp-compaction:"));
            if turn.compaction_message && !has_compaction_tool {
                self.compaction_item(&mut turn, &now, &mut out);
            }
        }
        let payload = self.provider_turn_payload(&turn, settled, Some(&now));
        self.event(
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": payload}),
            &mut out,
        );
        let mut thread = turn.provider_thread.clone();
        let first = thread
            .get("firstRunOrdinal")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!(turn.run_ordinal));
        set(
            &mut thread,
            "providerSessionId",
            json!(self.provider_session_id),
        );
        set(&mut thread, "status", json!("active"));
        set(&mut thread, "lastRunOrdinal", json!(turn.run_ordinal));
        set(&mut thread, "firstRunOrdinal", first);
        set(&mut thread, "contextUsage", turn.context_usage.clone());
        set(&mut thread, "nativeMetadata", turn.native_metadata.clone());
        set(&mut thread, "updatedAt", json!(now));
        self.provider_thread = Some(thread.clone());
        self.event(
            json!({"type": "provider_thread.updated", "providerThread": thread}),
            &mut out,
        );
        let terminal = if settled == "failed" {
            let key = format!("terminal-failure:{}", turn.provider_turn_id);
            Self::resolve_ordinal(&mut turn, &key);
            json!({
                "type": "turn.terminal",
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "runOrdinal": turn.run_ordinal,
                "status": settled,
                "failure": failure.unwrap_or_else(|| json!({"class": "provider_error"})),
                "threadDisposition": "reusable",
            })
        } else {
            json!({
                "type": "turn.terminal",
                "providerThreadId": turn.provider_thread["id"],
                "providerTurnId": turn.provider_turn_id,
                "runOrdinal": turn.run_ordinal,
                "status": settled,
                "failure": null,
                "threadDisposition": "reusable",
            })
        };
        self.event(terminal, &mut out);
        // Requests of this turn cannot be answered any more.
        self.pending.clear();
        out
    }

    /// A `/compact` turn that completed without the agent's own compaction update: the
    /// session's context usage is gone, and the turn shows "Context compacted".
    fn compaction_item(&mut self, turn: &mut Turn, now: &str, out: &mut Vec<Out>) {
        turn.context_usage = Value::Null;
        self.context_usage = None;
        let native_item_id = format!("{}:compaction", turn.native_turn_id);
        let ordinal = Self::resolve_ordinal(turn, &native_item_id);
        let item = json!({
            "id": ids::turn_item_from_item(self.driver(), &native_item_id),
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": turn.root_node_id,
            "providerThreadId": turn.provider_thread["id"],
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": {"driver": self.driver(), "nativeId": native_item_id, "strength": "weak"},
            "parentItemId": null,
            "ordinal": ordinal,
            "type": "compaction",
            "driver": self.driver(),
            "status": "completed",
            "title": "Context compacted",
            "startedAt": turn.started_at,
            "completedAt": now,
            "updatedAt": now,
        });
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
    }

    /// The agent exited: an open turn fails, open requests go.
    pub(crate) fn agent_exited(&mut self, detail: &str) -> Vec<Out> {
        self.pending.clear();
        if self.turn.is_none() {
            return Vec::new();
        }
        let failure = (self.flavor.prompt_failure)(detail, None);
        self.finalize("failed", Some(failure))
    }

    /// Stop: open runtime requests are cancelled first (their replies go to the agent).
    pub(crate) fn interrupt(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        self.mark_interrupted();
        self.cancel_pending(&mut out);
        out
    }
}

/// `AcpPlanUpdate` (explanations are not sent by any recorded agent and are left out).
#[derive(Debug)]
enum PlanUpdate {
    Items(Vec<(String, String)>),
    Markdown(String),
    Removed,
}

/// `normalizePlanStepStatus`.
fn plan_step_status(raw: &Value) -> String {
    match raw.as_str() {
        Some("completed") => "completed",
        Some("cancelled") => "cancelled",
        Some("in_progress" | "inProgress") => "inProgress",
        _ => "pending",
    }
    .to_owned()
}

fn set(value: &mut Value, key: &str, v: Value) {
    if let Value::Object(map) = value {
        map.insert(key.to_owned(), v);
    }
}

/// `acpContentBlockDisplayText`.
pub(crate) fn content_display_text(content: &Value) -> Option<String> {
    let bounded = |s: &str, n: usize| -> String { s.trim().chars().take(n).collect() };
    let uri = |value: &Value| -> String {
        let uri = bounded(value.as_str().unwrap_or(""), 4096);
        if uri.to_lowercase().starts_with("data:") {
            String::new()
        } else {
            uri
        }
    };
    let text = |s: &str| -> String { s.chars().take(65_536).collect() };
    match content["type"].as_str()? {
        "text" => Some(text(content["text"].as_str().unwrap_or(""))),
        "resource_link" => {
            let mut label = bounded(content["title"].as_str().unwrap_or(""), 512);
            if label.is_empty() {
                label = bounded(content["name"].as_str().unwrap_or(""), 512);
            }
            if label.is_empty() {
                label = "resource".into();
            }
            let description = bounded(content["description"].as_str().unwrap_or(""), 2048);
            let uri = uri(&content["uri"]);
            let head = if description.is_empty() {
                label
            } else {
                format!("{label}: {description}")
            };
            Some(if uri.is_empty() {
                head
            } else {
                format!("{head}\n{uri}")
            })
        }
        "resource" => {
            if let Some(t) = content["resource"]["text"].as_str() {
                return Some(text(t));
            }
            let mime = bounded(content["resource"]["mimeType"].as_str().unwrap_or(""), 256);
            let uri = uri(&content["resource"]["uri"]);
            Some(format!(
                "[ACP binary resource{}{}]",
                if mime.is_empty() {
                    String::new()
                } else {
                    format!(" ({mime})")
                },
                if uri.is_empty() {
                    String::new()
                } else {
                    format!(": {uri}")
                }
            ))
        }
        "image" => {
            let mut mime = bounded(content["mimeType"].as_str().unwrap_or(""), 256);
            if mime.is_empty() {
                mime = "unknown type".into();
            }
            let uri = uri(&content["uri"]);
            Some(format!(
                "[ACP image ({mime}){}]",
                if uri.is_empty() {
                    String::new()
                } else {
                    format!(": {uri}")
                }
            ))
        }
        "audio" => {
            let mut mime = bounded(content["mimeType"].as_str().unwrap_or(""), 256);
            if mime.is_empty() {
                mime = "unknown type".into();
            }
            Some(format!("[ACP audio ({mime})]"))
        }
        other => Some(format!(
            "[Unsupported ACP content: {}]",
            bounded(other, 128)
        )),
    }
}

/// The `(optionId, kind)` pairs of a permission request.
pub(crate) fn permission_options(params: &Value) -> Vec<(String, String)> {
    params["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some((
                        option["optionId"].as_str()?.trim().to_owned(),
                        option["kind"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `selectPermissionOptionId`: the option for a decision.
pub(crate) fn select_option(options: &[(String, String)], decision: &str) -> Option<String> {
    let of_kind = |kind: &str| {
        options
            .iter()
            .find(|(id, k)| k == kind && !id.is_empty())
            .map(|(id, _)| id.clone())
    };
    match decision {
        "accept" => of_kind("allow_once"),
        "acceptForSession" => of_kind("allow_always").or_else(|| of_kind("allow_once")),
        "decline" => of_kind("reject_once"),
        _ => None,
    }
}

/// The reply for an immediate allow or deny (`selectAutoApprovedPermissionOption`).
pub(crate) fn immediate_reply(options: &[(String, String)], allow: Disposition) -> J {
    let option = match allow {
        Disposition::Allow => {
            select_option(options, "accept").or_else(|| select_option(options, "acceptForSession"))
        }
        Disposition::Deny => select_option(options, "decline"),
        Disposition::Ask => None,
    };
    match option {
        Some(option) => selected(&option),
        None => obj().with("outcome", obj().with("outcome", "cancelled")),
    }
}

/// `AcpPermissionDisposition`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    Allow,
    Ask,
    Deny,
}

fn selected(option_id: &str) -> J {
    obj().with(
        "outcome",
        obj()
            .with("outcome", "selected")
            .with("optionId", option_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_provider_support::ids::FixedEnv;

    fn mapper() -> Mapper<FixedEnv> {
        Mapper::new(FixedEnv::default(), &crate::flavor::GROK, "grok", "s")
    }

    #[test]
    fn a_compaction_id_marks_the_session_once_and_old_ids_fall_out() {
        let mut mapper = mapper();
        mapper.mark_compacted(Some("s\u{0}c1"));
        let first = mapper.compaction_marker();
        assert!(first.is_some());
        mapper.clear_compaction_marker(first);
        assert_eq!(mapper.compaction_marker(), None);
        // The same completed compaction, patched again: no new mark.
        mapper.mark_compacted(Some("s\u{0}c1"));
        assert_eq!(mapper.compaction_marker(), None);
        for n in 0..1_000 {
            mapper.mark_compacted(Some(&format!("s\u{0}x{n}")));
        }
        assert_eq!(mapper.completed_compactions.len(), COMPACTION_IDS_KEPT);
    }

    #[test]
    fn a_late_prompt_success_keeps_a_newer_compaction() {
        let mut mapper = mapper();
        mapper.mark_compacted(None);
        let seen = mapper.compaction_marker();
        mapper.mark_compacted(None);
        mapper.clear_compaction_marker(seen);
        assert!(mapper.compaction_marker().is_some());
        mapper.reset_compaction();
        assert_eq!(mapper.compaction_marker(), None);
    }
}
