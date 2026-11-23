//! UniFFI-exported records, enums, error types, and pure conversions from `conn-state` / `conn-client`.

use std::collections::{HashMap, HashSet};
use std::fmt;

use conn_client::{ClientError, ConnectionStatus, Credential, commands::format_client_error};
use conn_contract::{
    ChatAttachment, OrchestrationV2AppThread, OrchestrationV2ProviderFailureClass,
    OrchestrationV2ShellThreadStatus,
};
use conn_state::{
    EntryTiming, ItemStatus, PLAN_PREVIEW_MAX_LINES, SecretRequestStatus, ShellState,
    ThreadActivity, ThreadShell, ThreadState, TimelineEntry, TurnCheckpointSummary, TurnItemStatus,
    collapsed_plan_preview, extract_model_slug, format_duration, parse_iso8601_epoch_ms,
    plan_can_collapse, strip_displayed_plan_markdown, subagent_settled, subagent_status_visual,
};

/// Credential presented to `conn-server` when opening a session.
#[derive(Clone, PartialEq, Eq, uniffi::Enum)]
pub enum FfiCredential {
    /// Single-use pairing code from a server's `pairingUrl` (`#token=<code>`).
    PairingCode { code: String },
    /// Bearer access token previously issued by `on_bearer_issued`.
    Bearer { token: String },
}

impl fmt::Debug for FfiCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PairingCode { .. } => f.write_str("FfiCredential::PairingCode(<redacted>)"),
            Self::Bearer { .. } => f.write_str("FfiCredential::Bearer(<redacted>)"),
        }
    }
}

impl From<FfiCredential> for Credential {
    fn from(value: FfiCredential) -> Self {
        match value {
            FfiCredential::PairingCode { code } => Self::PairingCode(code),
            FfiCredential::Bearer { token } => Self::Bearer(token),
        }
    }
}

/// Connection lifecycle reported to [`crate::CoreListener::on_status`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiConnectionStatus {
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
    Failed { message: String },
}

impl From<ConnectionStatus> for FfiConnectionStatus {
    fn from(status: ConnectionStatus) -> Self {
        match status {
            ConnectionStatus::Connecting => Self::Connecting,
            ConnectionStatus::Connected => Self::Connected,
            ConnectionStatus::Reconnecting { attempt } => Self::Reconnecting { attempt },
            ConnectionStatus::Failed(message) => Self::Failed { message },
        }
    }
}

/// How [`crate::ConnCore::send_message`] dispatches a prompt (mirrors desktop `SendDispatch`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiSendMode {
    /// Start immediately when idle; queue after the active run while working (desktop default).
    #[default]
    Auto,
    /// Steer the active run while working (falling back to queue if no active run id is known).
    Steer,
    /// Queue after the active run while working; start immediately when idle.
    Queue,
}

/// User decision for a pending approval request (`runtime-request.respond`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiApprovalDecision {
    Accept,
    AcceptForSession,
    AcceptAlways,
    Decline,
    Cancel,
}

impl FfiApprovalDecision {
    #[must_use]
    pub(crate) const fn as_wire(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::AcceptAlways => "acceptAlways",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

/// Coarse run state of a thread for list indicators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiThreadActivity {
    Idle,
    Working,
    NeedsAttention,
    Failed,
}

impl From<ThreadActivity> for FfiThreadActivity {
    fn from(activity: ThreadActivity) -> Self {
        match activity {
            ThreadActivity::Idle => Self::Idle,
            ThreadActivity::Working => Self::Working,
            ThreadActivity::NeedsAttention => Self::NeedsAttention,
            ThreadActivity::Failed => Self::Failed,
        }
    }
}

/// One registered project from `orchestration.subscribeShell`.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiProject {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
}

/// Summary row for one thread in [`FfiShellSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub branch: Option<String>,
    pub activity: FfiThreadActivity,
    pub updated_at: Option<String>,
    pub settled: bool,
    pub is_subagent: bool,
    pub pinned: bool,
    pub unread: bool,
    /// The provider's error (`lastError`) while the thread has failed; `None` otherwise.
    /// Conn mobile shows it as a third row line (`ThreadListV2Row`).
    pub failure_message: Option<String>,
    /// The failure is a usage limit (`lastErrorClass: usage_limit`), which mobile shows as a
    /// warning ("limited") instead of an error.
    pub usage_limited: bool,
}

/// Point-in-time shell snapshot emitted to [`crate::CoreListener::on_shell`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiShellSnapshot {
    pub projects: Vec<FfiProject>,
    pub threads: Vec<FfiThreadSummary>,
    pub synchronized: bool,
}

/// Status of a tool call or work item row (mirrors [`conn_state::ItemStatus`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiItemStatus {
    Running,
    Completed,
    Failed,
}

impl From<ItemStatus> for FfiItemStatus {
    fn from(status: ItemStatus) -> Self {
        match status {
            ItemStatus::Running => Self::Running,
            ItemStatus::Completed => Self::Completed,
            ItemStatus::Failed => Self::Failed,
        }
    }
}

/// Fine-grained turn item status (mirrors [`conn_state::TurnItemStatus`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTurnItemStatus {
    Idle,
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl From<TurnItemStatus> for FfiTurnItemStatus {
    fn from(status: TurnItemStatus) -> Self {
        match status {
            TurnItemStatus::Idle => Self::Idle,
            TurnItemStatus::Pending => Self::Pending,
            TurnItemStatus::Running => Self::Running,
            TurnItemStatus::Waiting => Self::Waiting,
            TurnItemStatus::Completed => Self::Completed,
            TurnItemStatus::Failed => Self::Failed,
            TurnItemStatus::Cancelled => Self::Cancelled,
            TurnItemStatus::Interrupted => Self::Interrupted,
        }
    }
}

/// Status of a secret request timeline card (mirrors [`conn_state::SecretRequestStatus`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiSecretRequestStatus {
    Pending,
    Saved,
    Declined,
    Cancelled,
}

impl From<SecretRequestStatus> for FfiSecretRequestStatus {
    fn from(status: SecretRequestStatus) -> Self {
        match status {
            SecretRequestStatus::Pending => Self::Pending,
            SecretRequestStatus::Saved => Self::Saved,
            SecretRequestStatus::Declined => Self::Declined,
            SecretRequestStatus::Cancelled => Self::Cancelled,
        }
    }
}

/// Attachment summary carried on user and queued user timeline entries.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub is_image: bool,
}

impl From<&ChatAttachment> for FfiAttachment {
    fn from(attachment: &ChatAttachment) -> Self {
        match attachment {
            ChatAttachment::Image(a) => Self {
                id: a.id.clone(),
                name: a.name.clone(),
                mime_type: a.mime_type.clone(),
                size_bytes: a.size_bytes,
                is_image: true,
            },
            ChatAttachment::File(a) => Self {
                id: a.id.clone(),
                name: a.name.clone(),
                mime_type: a.mime_type.clone(),
                size_bytes: a.size_bytes,
                is_image: false,
            },
            ChatAttachment::Unknown(a) => Self {
                id: a.id.clone(),
                name: a.name.clone(),
                mime_type: a.mime_type.clone(),
                size_bytes: a.size_bytes,
                is_image: a.r#type == "image",
            },
        }
    }
}

/// One selectable option in an [`FfiUserInputQuestion`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiUserInputOption {
    pub label: String,
    pub description: String,
    /// Value submitted when chosen (`option.value ?? option.label`).
    pub value: String,
}

/// One question in an [`FfiTimelineEntry::UserInputRequest`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiUserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<FfiUserInputOption>,
    pub multi_select: bool,
    pub allow_custom_answer: bool,
    pub initial_answer: Option<String>,
}

/// One answered question on a settled [`FfiTimelineEntry::UserInputRequest`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiUserInputAnswer {
    pub question_id: String,
    pub question: String,
    pub answer: String,
}

/// Value submitted for one user-input question in [`crate::ConnCore::respond_user_input`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiUserInputAnswerValue {
    Single { value: String },
    Multi { values: Vec<String> },
}

impl FfiUserInputAnswerValue {
    #[must_use]
    pub(crate) fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Single { value } => serde_json::Value::String(value.clone()),
            Self::Multi { values } => serde_json::Value::Array(
                values
                    .iter()
                    .map(|v| serde_json::Value::String(v.clone()))
                    .collect(),
            ),
        }
    }
}

/// One `(question_id, value)` pair submitted to [`crate::ConnCore::respond_user_input`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiUserInputSubmission {
    pub question_id: String,
    pub value: FfiUserInputAnswerValue,
}

/// One changed file summary inside an [`FfiTimelineEntry::TurnCheckpoint`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTurnCheckpointFile {
    pub path: String,
    pub kind: String,
    pub additions: i64,
    pub deletions: i64,
}

/// Timing and grouping metadata for a contiguous run of `Thinking` / `Tool` entries.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiWorkGroupTiming {
    /// Stable group id matching desktop (`work-group-<first_entry_id>`).
    pub id: String,
    pub first_entry_id: String,
    pub entry_ids: Vec<String>,
    pub run_id: Option<String>,
    pub has_active: bool,
    pub continues_steer: bool,
    pub duration_ms: Option<u64>,
    pub duration_label: Option<String>,
}

/// One flattened timeline row emitted in [`FfiThreadSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiTimelineEntry {
    User {
        id: String,
        text: String,
        created_at: Option<String>,
        created_by_agent: bool,
        is_steer: bool,
        run_id: Option<String>,
        attachments: Vec<FfiAttachment>,
    },
    QueuedUser {
        id: String,
        run_id: String,
        message_id: String,
        text: String,
        created_at: String,
        created_by_agent: bool,
        attachments: Vec<FfiAttachment>,
    },
    Assistant {
        id: String,
        markdown: String,
        streaming: bool,
        created_at: Option<String>,
        run_id: Option<String>,
        status: FfiItemStatus,
    },
    Thinking {
        id: String,
        text: String,
        streaming: bool,
        run_id: Option<String>,
        duration_ms: Option<u64>,
    },
    Tool {
        id: String,
        kind: String,
        title: String,
        detail: Option<String>,
        status: FfiItemStatus,
        output_omitted: bool,
        run_id: Option<String>,
        duration_ms: Option<u64>,
    },
    Approval {
        id: String,
        /// Server runtime request id to pass to [`crate::ConnCore::respond_approval`].
        request_id: String,
        title: String,
        detail: Option<String>,
    },
    UserInputRequest {
        id: String,
        /// Server runtime request id to pass to [`crate::ConnCore::respond_user_input`] or
        /// [`crate::ConnCore::dismiss_user_input`].
        request_id: String,
        title: Option<String>,
        questions: Vec<FfiUserInputQuestion>,
        status: FfiTurnItemStatus,
        pending: bool,
        answers: Vec<FfiUserInputAnswer>,
        dismissible: bool,
        created_at: Option<String>,
    },
    SecretRequest {
        /// Turn item id to pass as `turn_item_id` when answering the secret request.
        id: String,
        label: String,
        reason: String,
        url: Option<String>,
        placeholder: Option<String>,
        file_delivery: bool,
        status: FfiSecretRequestStatus,
        pending: bool,
        created_at: Option<String>,
    },
    ProposedPlan {
        id: String,
        run_id: Option<String>,
        title: String,
        markdown: String,
        display_markdown: String,
        preview_markdown: String,
        can_collapse: bool,
        streaming: bool,
        status: FfiItemStatus,
        created_at: Option<String>,
    },
    Subagent {
        id: String,
        child_thread_id: Option<String>,
        title: String,
        role: String,
        status: FfiTurnItemStatus,
        status_label: String,
        settled: bool,
        summary: Option<String>,
        remote_label: Option<String>,
        created_at: Option<String>,
        started_at: Option<String>,
        completed_at: Option<String>,
    },
    TurnCheckpoint {
        id: String,
        run_id: String,
        app_run_ordinal: Option<i64>,
        file_count: u32,
        additions: i64,
        deletions: i64,
        files: Vec<FfiTurnCheckpointFile>,
    },
    Notice {
        id: String,
        text: String,
        is_error: bool,
    },
    /// Fallback for future timeline entry kinds not yet mapped to a dedicated variant.
    Other { id: String, label: String },
}

/// Point-in-time snapshot of one subscribed thread emitted to [`crate::CoreListener::on_thread`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadSnapshot {
    pub thread_id: String,
    pub title: Option<String>,
    pub branch: Option<String>,
    pub model_label: Option<String>,
    pub entries: Vec<FfiTimelineEntry>,
    pub work_groups: Vec<FfiWorkGroupTiming>,
    pub working: bool,
    pub active_run_id: Option<String>,
    pub queued_count: u32,
    pub synchronized: bool,
}

/// Categorized reason for an [`FfiError::Orbit`] failure (mirrors [`conn_orbit::OrbitErrorReason`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitErrorReason {
    NotANode,
    AccessRequired,
    ExtensionDisabled,
    NotFound,
    Unreachable,
    InvalidResponse,
    VersionConflict,
    Unsupported,
    Gateway,
}

impl From<conn_orbit::OrbitErrorReason> for FfiOrbitErrorReason {
    fn from(reason: conn_orbit::OrbitErrorReason) -> Self {
        match reason {
            conn_orbit::OrbitErrorReason::NotANode => Self::NotANode,
            conn_orbit::OrbitErrorReason::AccessRequired => Self::AccessRequired,
            conn_orbit::OrbitErrorReason::ExtensionDisabled => Self::ExtensionDisabled,
            conn_orbit::OrbitErrorReason::NotFound => Self::NotFound,
            conn_orbit::OrbitErrorReason::Unreachable => Self::Unreachable,
            conn_orbit::OrbitErrorReason::InvalidResponse => Self::InvalidResponse,
            conn_orbit::OrbitErrorReason::VersionConflict => Self::VersionConflict,
            conn_orbit::OrbitErrorReason::Unsupported => Self::Unsupported,
            conn_orbit::OrbitErrorReason::Gateway => Self::Gateway,
        }
    }
}

/// Errors returned across the UniFFI boundary.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum FfiError {
    #[error("invalid server url: {message}")]
    InvalidUrl { message: String },
    #[error("invalid theme: {message}")]
    InvalidTheme { message: String },
    #[error("invalid input: {message}")]
    InvalidInput { message: String },
    #[error("connection error: {message}")]
    Connection { message: String },
    #[error("authentication error: {message}")]
    Auth { message: String },
    #[error("rpc error: {message}")]
    Rpc { message: String },
    #[error("orbit error: {message}")]
    Orbit {
        message: String,
        reason: FfiOrbitErrorReason,
    },
    #[error("connection closed")]
    Closed,
}

impl From<conn_orbit::TasksError> for FfiError {
    fn from(err: conn_orbit::TasksError) -> Self {
        let reason = conn_orbit::OrbitErrorReason::from(err.reason).into();
        Self::Orbit {
            message: err.message,
            reason,
        }
    }
}

impl From<conn_orbit::ProfileError> for FfiError {
    fn from(err: conn_orbit::ProfileError) -> Self {
        let reason = err.reason().into();
        Self::Orbit {
            message: err.to_string(),
            reason,
        }
    }
}

impl From<conn_orbit::GatewayError> for FfiError {
    fn from(err: conn_orbit::GatewayError) -> Self {
        match err {
            conn_orbit::GatewayError::InvalidRequest(message) => Self::InvalidUrl { message },
            other => Self::Orbit {
                message: other.to_string(),
                reason: FfiOrbitErrorReason::Unreachable,
            },
        }
    }
}

impl From<ClientError> for FfiError {
    fn from(err: ClientError) -> Self {
        match err {
            ClientError::InvalidUrl(e) => Self::InvalidUrl {
                message: e.to_string(),
            },
            ClientError::Connection(message) => Self::Connection { message },
            ClientError::Codec(e) => Self::Rpc {
                message: e.to_string(),
            },
            ClientError::Auth(message) => Self::Auth { message },
            ClientError::Rpc(_) => Self::Rpc {
                message: format_client_error(&err),
            },
            ClientError::Closed => Self::Closed,
        }
    }
}

/// Thread header metadata sourced from [`ThreadShell`] or [`OrchestrationV2AppThread`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ThreadSnapshotMeta {
    pub title: Option<String>,
    pub branch: Option<String>,
    pub model_label: Option<String>,
}

impl ThreadSnapshotMeta {
    #[must_use]
    pub(crate) fn from_shell(thread: &ThreadShell) -> Self {
        let model = extract_model_slug(&thread.model_selection);
        Self {
            title: non_empty_str(&thread.title),
            branch: thread.branch.as_deref().and_then(non_empty_str),
            model_label: non_empty_str(&model),
        }
    }

    #[must_use]
    pub(crate) fn from_app_thread(thread: &OrchestrationV2AppThread) -> Self {
        let model = extract_model_slug(&thread.model_selection);
        Self {
            title: non_empty_str(&thread.title),
            branch: thread.branch.as_deref().and_then(non_empty_str),
            model_label: non_empty_str(&model),
        }
    }
}

fn non_empty_str(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Projects [`ShellState`] into [`FfiShellSnapshot`].
///
/// Includes non-archived projects and top-level active threads (newest first) followed by
/// top-level settled threads flagged `settled: true` (newest first).
#[must_use]
pub(crate) fn build_shell_snapshot(shell: &ShellState) -> FfiShellSnapshot {
    let projects = shell
        .projects
        .iter()
        .filter(|project| {
            project
                .archived_at
                .as_ref()
                .and_then(Option::as_deref)
                .is_none_or(|s| s.trim().is_empty())
        })
        .map(|project| FfiProject {
            id: project.id.clone(),
            title: project.title.clone(),
            workspace_root: project.workspace_root.clone(),
        })
        .collect();

    let active = shell
        .top_level_active_threads()
        .map(|thread| map_thread_summary(shell, thread, false));
    let settled = shell
        .top_level_settled_threads()
        .into_iter()
        .map(|thread| map_thread_summary(shell, thread, true));
    let threads = active.chain(settled).collect();

    FfiShellSnapshot {
        projects,
        threads,
        synchronized: shell.synchronized,
    }
}

fn is_pinned(thread: &ThreadShell) -> bool {
    thread
        .pinned_at
        .as_ref()
        .and_then(Option::as_deref)
        .is_some_and(|s| !s.trim().is_empty())
}

/// Mirrors Conn's `hasUnseenCompletion`: completion after the last visit, using millisecond
/// precision so `thread.mark-unread` (which moves `lastVisitedAt` to `completedAt - 1 ms`)
/// shows as unread.
fn has_unseen_completion(thread: &ThreadShell) -> bool {
    let Some(completed) = thread
        .latest_run_completed_at
        .as_ref()
        .and_then(Option::as_deref)
        .and_then(parse_iso8601_epoch_ms)
    else {
        return false;
    };
    let Some(visited) = thread.last_visited_at.as_ref().and_then(Option::as_deref) else {
        return false;
    };
    parse_iso8601_epoch_ms(visited).is_none_or(|v| completed > v)
}

fn map_thread_summary(shell: &ShellState, thread: &ThreadShell, settled: bool) -> FfiThreadSummary {
    let updated_at = if !thread.updated_at.is_empty() {
        Some(thread.updated_at.clone())
    } else if !thread.created_at.is_empty() {
        Some(thread.created_at.clone())
    } else {
        None
    };

    FfiThreadSummary {
        id: thread.id.clone(),
        project_id: thread.project_id.clone(),
        title: thread.title.clone(),
        branch: thread.branch.clone(),
        activity: shell.activity(&thread.id).into(),
        updated_at,
        settled,
        is_subagent: ShellState::is_subagent(thread),
        pinned: is_pinned(thread),
        unread: has_unseen_completion(thread),
        failure_message: failure_message(thread),
        usage_limited: is_usage_limited(thread),
    }
}

/// `lastError` while the thread has failed, like Conn mobile's `showsError` in `ThreadListV2Row`.
fn failure_message(thread: &ThreadShell) -> Option<String> {
    if thread.status != OrchestrationV2ShellThreadStatus::Failed {
        return None;
    }
    thread
        .last_error
        .as_ref()
        .and_then(Option::as_deref)
        .and_then(non_empty_str)
}

/// Mobile's `resolveThreadListV2Status`: a failure of class `usage_limit` is "limited".
fn is_usage_limited(thread: &ThreadShell) -> bool {
    thread.status == OrchestrationV2ShellThreadStatus::Failed
        && matches!(
            thread.last_error_class,
            Some(Some(OrchestrationV2ProviderFailureClass::UsageLimit))
        )
}

fn entry_duration_ms(timing: Option<&EntryTiming>) -> Option<u64> {
    let timing = timing?;
    let (Some(start), Some(end)) = (timing.started_at_ms, timing.completed_at_ms) else {
        return None;
    };
    (end > start).then(|| u64::try_from(end - start).ok())?
}

fn effective_entry_run_id<'a>(
    thread: &'a ThreadState,
    entry: &'a TimelineEntry,
) -> Option<&'a str> {
    if let Some(run_id) = thread.entry_run_id(entry.id()) {
        return Some(run_id);
    }
    match entry {
        TimelineEntry::User { run_id, .. }
        | TimelineEntry::Assistant { run_id, .. }
        | TimelineEntry::ProposedPlan { run_id, .. } => run_id.as_deref(),
        _ => None,
    }
}

fn is_work_entry(entry: &TimelineEntry) -> bool {
    matches!(
        entry,
        TimelineEntry::Thinking { .. } | TimelineEntry::Tool { .. }
    )
}

fn is_active_work_entry(entry: &TimelineEntry) -> bool {
    match entry {
        TimelineEntry::Thinking { streaming, .. } => *streaming,
        TimelineEntry::Tool { status, .. } => *status == ItemStatus::Running,
        _ => false,
    }
}

fn build_work_groups(thread: &ThreadState) -> Vec<FfiWorkGroupTiming> {
    let entries = &thread.entries;
    let non_queued_end = entries
        .iter()
        .rposition(|e| !matches!(e, TimelineEntry::QueuedUser { .. }))
        .map_or(0, |idx| idx + 1);

    let mut groups = Vec::new();
    let mut idx = 0usize;
    while idx < entries.len() {
        if !is_work_entry(&entries[idx]) {
            idx += 1;
            continue;
        }
        let start = idx;
        while idx < entries.len() && is_work_entry(&entries[idx]) {
            idx += 1;
        }
        let slice = &entries[start..idx];
        let id_refs: Vec<&str> = slice.iter().map(TimelineEntry::id).collect();
        let entry_ids: Vec<String> = id_refs.iter().map(|id| (*id).to_owned()).collect();
        let first_entry_id = slice[0].id().to_owned();
        let mut has_active = slice.iter().any(is_active_work_entry);
        if thread.working && idx == non_queued_end {
            has_active = true;
        }
        let continues_steer = start > 0
            && matches!(
                entries[start - 1],
                TimelineEntry::User { is_steer: true, .. }
            );
        let run_id = thread
            .entry_run_id(slice[slice.len() - 1].id())
            .map(str::to_owned);
        let duration_ms = thread.work_group_duration_ms(&id_refs);
        let duration_label = duration_ms.map(format_duration);

        groups.push(FfiWorkGroupTiming {
            id: format!("work-group-{first_entry_id}"),
            first_entry_id,
            entry_ids,
            run_id,
            has_active,
            continues_steer,
            duration_ms,
            duration_label,
        });
    }
    groups
}

fn map_checkpoint_entry(checkpoint: &TurnCheckpointSummary) -> FfiTimelineEntry {
    FfiTimelineEntry::TurnCheckpoint {
        id: format!("checkpoint:{}", checkpoint.run_id),
        run_id: checkpoint.run_id.clone(),
        app_run_ordinal: checkpoint.app_run_ordinal,
        file_count: u32::try_from(checkpoint.file_count).unwrap_or(u32::MAX),
        additions: checkpoint.additions,
        deletions: checkpoint.deletions,
        files: checkpoint
            .files
            .iter()
            .map(|f| FfiTurnCheckpointFile {
                path: f.path.clone(),
                kind: f.kind.clone(),
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect(),
    }
}

/// Projects one [`ThreadState`] and optional header metadata into [`FfiThreadSnapshot`].
#[must_use]
pub(crate) fn build_thread_snapshot(
    thread: &ThreadState,
    meta: Option<&ThreadSnapshotMeta>,
) -> FfiThreadSnapshot {
    let mut entries = Vec::with_capacity(thread.entries.len() + thread.turn_checkpoints.len());
    let mut emitted_checkpoints: HashSet<&str> = HashSet::new();
    let mut queued_count: u32 = 0;

    for (idx, entry) in thread.entries.iter().enumerate() {
        if matches!(entry, TimelineEntry::QueuedUser { .. }) {
            queued_count = queued_count.saturating_add(1);
        }
        entries.push(map_timeline_entry_with_context(
            entry,
            &thread.approval_requests,
            &thread.entry_timings,
        ));

        // Insert a TurnCheckpoint card right after the final non-user, non-queued item belonging
        // to `run_id`, matching desktop `conn-app/src/chat/cache.rs`.
        if !matches!(
            entry,
            TimelineEntry::User { .. } | TimelineEntry::QueuedUser { .. }
        ) && let Some(run_id) = effective_entry_run_id(thread, entry)
        {
            let next_same_run = thread
                .entries
                .get(idx + 1)
                .filter(|next| !matches!(next, TimelineEntry::QueuedUser { .. }))
                .and_then(|next| effective_entry_run_id(thread, next))
                .is_some_and(|next_id| next_id == run_id);
            if !next_same_run
                && !emitted_checkpoints.contains(run_id)
                && let Some(cp) = thread
                    .checkpoint_for_run(run_id)
                    .filter(|cp| cp.file_count > 0)
            {
                emitted_checkpoints.insert(run_id);
                entries.push(map_checkpoint_entry(cp));
            }
        }
    }

    let work_groups = build_work_groups(thread);

    FfiThreadSnapshot {
        thread_id: thread.thread_id.clone(),
        title: meta.and_then(|m| m.title.clone()),
        branch: meta.and_then(|m| m.branch.clone()),
        model_label: meta.and_then(|m| m.model_label.clone()),
        entries,
        work_groups,
        working: thread.working,
        active_run_id: thread.active_run_id().map(str::to_owned),
        queued_count,
        synchronized: thread.synchronized,
    }
}

/// Maps a [`TimelineEntry`] into its FFI representation with approval request ids and timings.
#[must_use]
pub(crate) fn map_timeline_entry_with_context(
    entry: &TimelineEntry,
    approval_requests: &HashMap<String, String>,
    entry_timings: &HashMap<String, EntryTiming>,
) -> FfiTimelineEntry {
    match entry {
        TimelineEntry::User {
            id,
            text,
            created_by_agent,
            created_at,
            attachments,
            is_steer,
            run_id,
        } => FfiTimelineEntry::User {
            id: id.clone(),
            text: text.clone(),
            created_at: created_at.clone(),
            created_by_agent: *created_by_agent,
            is_steer: *is_steer,
            run_id: run_id.clone(),
            attachments: attachments.iter().map(FfiAttachment::from).collect(),
        },
        TimelineEntry::QueuedUser {
            id,
            run_id,
            message_id,
            text,
            attachments,
            created_at,
            created_by_agent,
        } => FfiTimelineEntry::QueuedUser {
            id: id.clone(),
            run_id: run_id.clone(),
            message_id: message_id.clone(),
            text: text.clone(),
            created_at: created_at.clone(),
            created_by_agent: *created_by_agent,
            attachments: attachments.iter().map(FfiAttachment::from).collect(),
        },
        TimelineEntry::Assistant {
            id,
            markdown,
            streaming,
            created_at,
            run_id,
            status,
        } => FfiTimelineEntry::Assistant {
            id: id.clone(),
            markdown: markdown.clone(),
            streaming: *streaming,
            created_at: created_at.clone(),
            run_id: run_id.clone(),
            status: (*status).into(),
        },
        TimelineEntry::Thinking {
            id,
            text,
            streaming,
        } => {
            let timing = entry_timings.get(id);
            FfiTimelineEntry::Thinking {
                id: id.clone(),
                text: text.clone(),
                streaming: *streaming,
                run_id: timing.and_then(|t| t.run_id.clone()),
                duration_ms: entry_duration_ms(timing),
            }
        }
        TimelineEntry::Tool {
            id,
            kind,
            title,
            detail,
            status,
            output_omitted,
        } => {
            let timing = entry_timings.get(id);
            FfiTimelineEntry::Tool {
                id: id.clone(),
                kind: kind.clone(),
                title: title.clone(),
                detail: detail.clone(),
                status: (*status).into(),
                output_omitted: *output_omitted,
                run_id: timing.and_then(|t| t.run_id.clone()),
                duration_ms: entry_duration_ms(timing),
            }
        }
        TimelineEntry::Approval { id, title, detail } => FfiTimelineEntry::Approval {
            id: id.clone(),
            request_id: approval_requests
                .get(id)
                .cloned()
                .unwrap_or_else(|| id.clone()),
            title: title.clone(),
            detail: detail.clone(),
        },
        TimelineEntry::UserInputRequest {
            id,
            request_id,
            title,
            questions,
            status,
            pending,
            answers,
            dismissible,
            created_at,
        } => FfiTimelineEntry::UserInputRequest {
            id: id.clone(),
            request_id: request_id.clone(),
            title: title.clone(),
            questions: questions
                .iter()
                .map(|q| FfiUserInputQuestion {
                    id: q.id.clone(),
                    header: q.header.clone(),
                    question: q.question.clone(),
                    options: q
                        .options
                        .iter()
                        .map(|o| FfiUserInputOption {
                            label: o.label.clone(),
                            description: o.description.clone(),
                            value: o.answer_value().to_owned(),
                        })
                        .collect(),
                    multi_select: q.multi_select,
                    allow_custom_answer: q.allow_custom_answer,
                    initial_answer: q.initial_answer.clone(),
                })
                .collect(),
            status: (*status).into(),
            pending: *pending,
            answers: answers
                .iter()
                .map(|a| FfiUserInputAnswer {
                    question_id: a.question_id.clone(),
                    question: a.question.clone(),
                    answer: a.answer.clone(),
                })
                .collect(),
            dismissible: *dismissible,
            created_at: created_at.clone(),
        },
        TimelineEntry::SecretRequest {
            id,
            label,
            reason,
            url,
            placeholder,
            file_delivery,
            status,
            pending,
            created_at,
        } => FfiTimelineEntry::SecretRequest {
            id: id.clone(),
            label: label.clone(),
            reason: reason.clone(),
            url: url.clone(),
            placeholder: placeholder.clone(),
            file_delivery: *file_delivery,
            status: (*status).into(),
            pending: *pending,
            created_at: created_at.clone(),
        },
        TimelineEntry::ProposedPlan {
            id,
            run_id,
            title,
            markdown,
            streaming,
            status,
            created_at,
        } => FfiTimelineEntry::ProposedPlan {
            id: id.clone(),
            run_id: run_id.clone(),
            title: title.clone(),
            markdown: markdown.clone(),
            display_markdown: strip_displayed_plan_markdown(markdown),
            preview_markdown: collapsed_plan_preview(markdown, PLAN_PREVIEW_MAX_LINES),
            can_collapse: plan_can_collapse(markdown),
            streaming: *streaming,
            status: (*status).into(),
            created_at: created_at.clone(),
        },
        TimelineEntry::Subagent {
            id,
            child_thread_id,
            title,
            role,
            status,
            summary,
            remote_label,
            created_at,
            started_at,
            completed_at,
        } => {
            let (_, status_label) = subagent_status_visual(*status);
            FfiTimelineEntry::Subagent {
                id: id.clone(),
                child_thread_id: child_thread_id.clone(),
                title: title.clone(),
                role: role.clone(),
                status: (*status).into(),
                status_label: status_label.to_owned(),
                settled: subagent_settled(*status),
                summary: summary.clone(),
                remote_label: remote_label.clone(),
                created_at: created_at.clone(),
                started_at: started_at.clone(),
                completed_at: completed_at.clone(),
            }
        }
        TimelineEntry::Notice { id, text, is_error } => FfiTimelineEntry::Notice {
            id: id.clone(),
            text: text.clone(),
            is_error: *is_error,
        },
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::{
        ChatFileAttachment, ChatImageAttachment, OrchestrationV2ShellStreamItem,
        OrchestrationV2ThreadStreamItem, OrchestrationV2TurnItemStatus, lit,
    };
    use conn_state::{
        RunTiming, SecretRequestStatus, TurnCheckpointFile, UserInputAnswer, UserInputOption,
        UserInputQuestion,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_every_timeline_entry_variant_to_typed_ffi() {
        let mut approvals = HashMap::new();
        approvals.insert("ap1".to_owned(), "req-approval-42".to_owned());

        let mut timings = HashMap::new();
        timings.insert(
            "th1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(1_000),
                completed_at_ms: Some(2_500),
            },
        );
        timings.insert(
            "tool1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(2_500),
                completed_at_ms: Some(4_000),
            },
        );

        let user = TimelineEntry::User {
            id: "u1".to_owned(),
            text: "Hello".to_owned(),
            created_by_agent: true,
            created_at: Some("2026-11-22T10:00:00Z".to_owned()),
            attachments: vec![ChatAttachment::Image(ChatImageAttachment {
                r#type: lit::Image,
                id: "img-1".to_owned(),
                name: "screen.png".to_owned(),
                mime_type: "image/png".to_owned(),
                size_bytes: 2048,
                source: None,
            })],
            is_steer: true,
            run_id: Some("r1".to_owned()),
        };
        assert_eq!(
            map_timeline_entry_with_context(&user, &approvals, &timings),
            FfiTimelineEntry::User {
                id: "u1".to_owned(),
                text: "Hello".to_owned(),
                created_at: Some("2026-11-22T10:00:00Z".to_owned()),
                created_by_agent: true,
                is_steer: true,
                run_id: Some("r1".to_owned()),
                attachments: vec![FfiAttachment {
                    id: "img-1".to_owned(),
                    name: "screen.png".to_owned(),
                    mime_type: "image/png".to_owned(),
                    size_bytes: 2048,
                    is_image: true,
                }],
            },
            "User entry maps cleanly"
        );

        let queued = TimelineEntry::QueuedUser {
            id: "q1".to_owned(),
            run_id: "r2".to_owned(),
            message_id: "m2".to_owned(),
            text: "Next question".to_owned(),
            attachments: vec![ChatAttachment::File(ChatFileAttachment {
                r#type: lit::File,
                id: "f-1".to_owned(),
                name: "spec.md".to_owned(),
                mime_type: "text/markdown".to_owned(),
                size_bytes: 512,
                source: None,
            })],
            created_at: "2026-11-22T10:01:00Z".to_owned(),
            created_by_agent: false,
        };
        assert_eq!(
            map_timeline_entry_with_context(&queued, &approvals, &timings),
            FfiTimelineEntry::QueuedUser {
                id: "q1".to_owned(),
                run_id: "r2".to_owned(),
                message_id: "m2".to_owned(),
                text: "Next question".to_owned(),
                created_at: "2026-11-22T10:01:00Z".to_owned(),
                created_by_agent: false,
                attachments: vec![FfiAttachment {
                    id: "f-1".to_owned(),
                    name: "spec.md".to_owned(),
                    mime_type: "text/markdown".to_owned(),
                    size_bytes: 512,
                    is_image: false,
                }],
            },
            "QueuedUser maps to typed QueuedUser"
        );

        let assistant = TimelineEntry::Assistant {
            id: "a1".to_owned(),
            markdown: "**Reply**".to_owned(),
            streaming: true,
            created_at: Some("2026-11-22T10:00:02Z".to_owned()),
            run_id: Some("r1".to_owned()),
            status: ItemStatus::Running,
        };
        assert_eq!(
            map_timeline_entry_with_context(&assistant, &approvals, &timings),
            FfiTimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "**Reply**".to_owned(),
                streaming: true,
                created_at: Some("2026-11-22T10:00:02Z".to_owned()),
                run_id: Some("r1".to_owned()),
                status: FfiItemStatus::Running,
            },
            "Assistant entry maps cleanly"
        );

        let thinking = TimelineEntry::Thinking {
            id: "th1".to_owned(),
            text: "Considering options".to_owned(),
            streaming: false,
        };
        assert_eq!(
            map_timeline_entry_with_context(&thinking, &approvals, &timings),
            FfiTimelineEntry::Thinking {
                id: "th1".to_owned(),
                text: "Considering options".to_owned(),
                streaming: false,
                run_id: Some("r1".to_owned()),
                duration_ms: Some(1_500),
            },
            "Thinking entry carries timing metadata"
        );

        for (state_status, ffi_status) in [
            (ItemStatus::Running, FfiItemStatus::Running),
            (ItemStatus::Completed, FfiItemStatus::Completed),
            (ItemStatus::Failed, FfiItemStatus::Failed),
        ] {
            let tool = TimelineEntry::Tool {
                id: "tool1".to_owned(),
                kind: "command".to_owned(),
                title: "cargo test".to_owned(),
                detail: Some("ok".to_owned()),
                status: state_status,
                output_omitted: true,
            };
            assert_eq!(
                map_timeline_entry_with_context(&tool, &approvals, &timings),
                FfiTimelineEntry::Tool {
                    id: "tool1".to_owned(),
                    kind: "command".to_owned(),
                    title: "cargo test".to_owned(),
                    detail: Some("ok".to_owned()),
                    status: ffi_status,
                    output_omitted: true,
                    run_id: Some("r1".to_owned()),
                    duration_ms: Some(1_500),
                },
                "Tool entry preserves status {state_status:?}"
            );
        }

        let approval = TimelineEntry::Approval {
            id: "ap1".to_owned(),
            title: "Run rm -rf".to_owned(),
            detail: Some("outside workspace".to_owned()),
        };
        assert_eq!(
            map_timeline_entry_with_context(&approval, &approvals, &timings),
            FfiTimelineEntry::Approval {
                id: "ap1".to_owned(),
                request_id: "req-approval-42".to_owned(),
                title: "Run rm -rf".to_owned(),
                detail: Some("outside workspace".to_owned()),
            },
            "Approval entry carries server request_id from approval_requests"
        );

        let user_input = TimelineEntry::UserInputRequest {
            id: "ui1".to_owned(),
            request_id: "req-1".to_owned(),
            title: Some("Configure project".to_owned()),
            questions: vec![UserInputQuestion {
                id: "q-1".to_owned(),
                header: "Framework".to_owned(),
                question: "Which framework?".to_owned(),
                options: vec![
                    UserInputOption {
                        label: "SwiftUI".to_owned(),
                        description: "Native iOS".to_owned(),
                        value: Some("swiftui".to_owned()),
                        preview: None,
                    },
                    UserInputOption {
                        label: "UIKit".to_owned(),
                        description: "Classic".to_owned(),
                        value: None,
                        preview: None,
                    },
                ],
                multi_select: true,
                allow_custom_answer: true,
                initial_answer: Some("swiftui".to_owned()),
            }],
            status: OrchestrationV2TurnItemStatus::Completed,
            pending: false,
            answers: vec![UserInputAnswer {
                question_id: "q-1".to_owned(),
                question: "Which framework?".to_owned(),
                answer: "swiftui".to_owned(),
            }],
            dismissible: true,
            created_at: Some("2026-11-22T10:02:00Z".to_owned()),
        };
        assert_eq!(
            map_timeline_entry_with_context(&user_input, &approvals, &timings),
            FfiTimelineEntry::UserInputRequest {
                id: "ui1".to_owned(),
                request_id: "req-1".to_owned(),
                title: Some("Configure project".to_owned()),
                questions: vec![FfiUserInputQuestion {
                    id: "q-1".to_owned(),
                    header: "Framework".to_owned(),
                    question: "Which framework?".to_owned(),
                    options: vec![
                        FfiUserInputOption {
                            label: "SwiftUI".to_owned(),
                            description: "Native iOS".to_owned(),
                            value: "swiftui".to_owned(),
                        },
                        FfiUserInputOption {
                            label: "UIKit".to_owned(),
                            description: "Classic".to_owned(),
                            value: "UIKit".to_owned(),
                        },
                    ],
                    multi_select: true,
                    allow_custom_answer: true,
                    initial_answer: Some("swiftui".to_owned()),
                }],
                status: FfiTurnItemStatus::Completed,
                pending: false,
                answers: vec![FfiUserInputAnswer {
                    question_id: "q-1".to_owned(),
                    question: "Which framework?".to_owned(),
                    answer: "swiftui".to_owned(),
                }],
                dismissible: true,
                created_at: Some("2026-11-22T10:02:00Z".to_owned()),
            },
            "UserInputRequest maps all questions, options, and answers"
        );

        let secret = TimelineEntry::SecretRequest {
            id: "sec1".to_owned(),
            label: "API Key".to_owned(),
            reason: "Needed for deploy".to_owned(),
            url: Some("https://example.com/tokens".to_owned()),
            placeholder: Some("sk-...".to_owned()),
            file_delivery: true,
            status: SecretRequestStatus::Pending,
            pending: true,
            created_at: Some("2026-11-22T10:03:00Z".to_owned()),
        };
        assert_eq!(
            map_timeline_entry_with_context(&secret, &approvals, &timings),
            FfiTimelineEntry::SecretRequest {
                id: "sec1".to_owned(),
                label: "API Key".to_owned(),
                reason: "Needed for deploy".to_owned(),
                url: Some("https://example.com/tokens".to_owned()),
                placeholder: Some("sk-...".to_owned()),
                file_delivery: true,
                status: FfiSecretRequestStatus::Pending,
                pending: true,
                created_at: Some("2026-11-22T10:03:00Z".to_owned()),
            },
            "SecretRequest maps cleanly"
        );

        let long_plan_lines: String = (1..=25)
            .map(|i| format!("- Step {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let plan_md = format!("# Migration Plan\n\n## Summary\n\n{long_plan_lines}");
        let plan = TimelineEntry::ProposedPlan {
            id: "plan1".to_owned(),
            run_id: Some("r1".to_owned()),
            title: "Migration Plan".to_owned(),
            markdown: plan_md.clone(),
            streaming: false,
            status: ItemStatus::Completed,
            created_at: Some("2026-11-22T10:04:00Z".to_owned()),
        };
        let mapped_plan = map_timeline_entry_with_context(&plan, &approvals, &timings);
        match mapped_plan {
            FfiTimelineEntry::ProposedPlan {
                id,
                run_id,
                title,
                markdown,
                display_markdown,
                preview_markdown,
                can_collapse,
                streaming,
                status,
                created_at,
            } => {
                assert_eq!(id, "plan1");
                assert_eq!(run_id.as_deref(), Some("r1"));
                assert_eq!(title, "Migration Plan");
                assert_eq!(markdown, plan_md);
                assert!(
                    display_markdown.starts_with("- Step 1"),
                    "display markdown strips title and Summary heading"
                );
                assert!(
                    preview_markdown.ends_with("\n\n..."),
                    "long plan preview ends with ellipsis"
                );
                assert!(can_collapse, "25-line plan must be collapsible");
                assert!(!streaming);
                assert_eq!(status, FfiItemStatus::Completed);
                assert_eq!(created_at.as_deref(), Some("2026-11-22T10:04:00Z"));
            }
            other => panic!("expected ProposedPlan, got {other:?}"),
        }

        let subagent = TimelineEntry::Subagent {
            id: "sub1".to_owned(),
            child_thread_id: Some("child-1".to_owned()),
            title: "Audit crates".to_owned(),
            role: "claudeAgent".to_owned(),
            status: OrchestrationV2TurnItemStatus::Completed,
            summary: Some("All clear".to_owned()),
            remote_label: Some("vps".to_owned()),
            created_at: Some("2026-11-22T10:05:00Z".to_owned()),
            started_at: Some("2026-11-22T10:04:30Z".to_owned()),
            completed_at: Some("2026-11-22T10:05:00Z".to_owned()),
        };
        assert_eq!(
            map_timeline_entry_with_context(&subagent, &approvals, &timings),
            FfiTimelineEntry::Subagent {
                id: "sub1".to_owned(),
                child_thread_id: Some("child-1".to_owned()),
                title: "Audit crates".to_owned(),
                role: "claudeAgent".to_owned(),
                status: FfiTurnItemStatus::Completed,
                status_label: "Completed".to_owned(),
                settled: true,
                summary: Some("All clear".to_owned()),
                remote_label: Some("vps".to_owned()),
                created_at: Some("2026-11-22T10:05:00Z".to_owned()),
                started_at: Some("2026-11-22T10:04:30Z".to_owned()),
                completed_at: Some("2026-11-22T10:05:00Z".to_owned()),
            },
            "Subagent maps child thread link, status label, and settled state"
        );

        let error_notice = TimelineEntry::Notice {
            id: "n1".to_owned(),
            text: "Timed out".to_owned(),
            is_error: true,
        };
        assert_eq!(
            map_timeline_entry_with_context(&error_notice, &approvals, &timings),
            FfiTimelineEntry::Notice {
                id: "n1".to_owned(),
                text: "Timed out".to_owned(),
                is_error: true,
            },
            "Error Notice maps cleanly"
        );

        let plain_notice = TimelineEntry::Notice {
            id: "n2".to_owned(),
            text: "Context compacted".to_owned(),
            is_error: false,
        };
        assert_eq!(
            map_timeline_entry_with_context(&plain_notice, &approvals, &timings),
            FfiTimelineEntry::Notice {
                id: "n2".to_owned(),
                text: "Context compacted".to_owned(),
                is_error: false,
            },
            "Info Notice maps cleanly"
        );
    }

    #[test]
    fn builds_thread_snapshot_with_checkpoints_work_groups_queued_count_and_meta() {
        let mut state = ThreadState::new("thread-rich");
        state.synchronized = true;
        state.working = true;
        state.entries = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "Fix build".to_owned(),
                created_by_agent: false,
                created_at: Some("2026-11-22T10:00:00Z".to_owned()),
                attachments: Vec::new(),
                is_steer: false,
                run_id: Some("r1".to_owned()),
            },
            TimelineEntry::Thinking {
                id: "th1".to_owned(),
                text: "Checking errors".to_owned(),
                streaming: false,
            },
            TimelineEntry::Tool {
                id: "tool1".to_owned(),
                kind: "command".to_owned(),
                title: "cargo check".to_owned(),
                detail: Some("ok".to_owned()),
                status: ItemStatus::Completed,
                output_omitted: false,
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "Done!".to_owned(),
                streaming: false,
                created_at: Some("2026-11-22T10:00:08Z".to_owned()),
                run_id: Some("r1".to_owned()),
                status: ItemStatus::Completed,
            },
            TimelineEntry::User {
                id: "u2".to_owned(),
                text: "Also run clippy".to_owned(),
                created_by_agent: false,
                created_at: Some("2026-11-22T10:00:09Z".to_owned()),
                attachments: Vec::new(),
                is_steer: true,
                run_id: Some("r2".to_owned()),
            },
            TimelineEntry::Tool {
                id: "tool2".to_owned(),
                kind: "command".to_owned(),
                title: "cargo clippy".to_owned(),
                detail: None,
                status: ItemStatus::Running,
                output_omitted: false,
            },
            TimelineEntry::QueuedUser {
                id: "q1".to_owned(),
                run_id: "r3".to_owned(),
                message_id: "m3".to_owned(),
                text: "Then commit".to_owned(),
                attachments: Vec::new(),
                created_at: "2026-11-22T10:00:10Z".to_owned(),
                created_by_agent: false,
            },
        ];
        state.entry_timings.insert(
            "th1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(1_000),
                completed_at_ms: Some(3_000),
            },
        );
        state.entry_timings.insert(
            "tool1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(3_000),
                completed_at_ms: Some(8_500),
            },
        );
        state.entry_timings.insert(
            "a1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(8_500),
                completed_at_ms: Some(9_000),
            },
        );
        state.entry_timings.insert(
            "tool2".to_owned(),
            EntryTiming {
                run_id: Some("r2".to_owned()),
                started_at_ms: Some(10_000),
                completed_at_ms: None,
            },
        );
        state.run_timings.insert(
            "r1".to_owned(),
            RunTiming {
                started_at_ms: Some(1_000),
                completed_at_ms: Some(9_000),
            },
        );
        state.turn_checkpoints.insert(
            "r1".to_owned(),
            TurnCheckpointSummary {
                run_id: "r1".to_owned(),
                app_run_ordinal: Some(1),
                file_count: 2,
                additions: 14,
                deletions: 3,
                files: vec![TurnCheckpointFile {
                    path: "src/lib.rs".to_owned(),
                    kind: "modified".to_owned(),
                    additions: 14,
                    deletions: 3,
                }],
            },
        );

        let meta = ThreadSnapshotMeta {
            title: Some("Fix build".to_owned()),
            branch: Some("feat/ios-spike".to_owned()),
            model_label: Some("claude-sonnet-4-5".to_owned()),
        };

        let snap = build_thread_snapshot(&state, Some(&meta));
        assert_eq!(snap.title.as_deref(), Some("Fix build"));
        assert_eq!(snap.branch.as_deref(), Some("feat/ios-spike"));
        assert_eq!(snap.model_label.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(snap.queued_count, 1, "must count QueuedUser entries");
        assert!(snap.synchronized);
        assert!(snap.working);

        // TurnCheckpoint for r1 is inserted right after a1 (index 4).
        assert_eq!(
            snap.entries.len(),
            8,
            "7 entries + 1 TurnCheckpoint inserted after r1"
        );
        assert!(
            matches!(
                &snap.entries[4],
                FfiTimelineEntry::TurnCheckpoint {
                    id,
                    run_id,
                    file_count: 2,
                    additions: 14,
                    deletions: 3,
                    ..
                } if id == "checkpoint:r1" && run_id == "r1"
            ),
            "TurnCheckpoint inserted after final non-user item of r1: {:?}",
            snap.entries[4]
        );

        // Work groups: [th1, tool1] (7.5s, inactive) and [tool2] (continues_steer, active).
        assert_eq!(snap.work_groups.len(), 2, "two contiguous work groups");
        assert_eq!(snap.work_groups[0].id, "work-group-th1");
        assert_eq!(snap.work_groups[0].entry_ids, vec!["th1", "tool1"]);
        assert!(!snap.work_groups[0].has_active);
        assert!(!snap.work_groups[0].continues_steer);
        assert_eq!(snap.work_groups[0].duration_ms, Some(7_500));
        assert_eq!(snap.work_groups[0].duration_label.as_deref(), Some("7.5s"));

        assert_eq!(snap.work_groups[1].id, "work-group-tool2");
        assert_eq!(snap.work_groups[1].entry_ids, vec!["tool2"]);
        assert!(snap.work_groups[1].has_active);
        assert!(snap.work_groups[1].continues_steer);
    }

    #[test]
    fn builds_thread_snapshot_from_testkit_synthetic_thread() {
        let raw = conn_state::testkit::synthetic_thread_snapshot_json(
            conn_state::testkit::SyntheticThread {
                turns: 2,
                commands_per_turn: 1,
                command_output_bytes: 32,
                assistant_bytes: 48,
            },
        );
        let item: OrchestrationV2ThreadStreamItem =
            serde_json::from_str(&raw).expect("synthetic snapshot must decode");
        let mut state = ThreadState::new("thread-1");
        assert!(state.apply(item), "snapshot must change thread state");

        let ffi = build_thread_snapshot(&state, None);
        assert_eq!(
            ffi.entries.len(),
            6,
            "2 turns * (user + command + assistant) = 6 entries"
        );
        assert!(
            matches!(ffi.entries[0], FfiTimelineEntry::User { .. }),
            "first entry is User"
        );
        assert!(
            matches!(ffi.entries[1], FfiTimelineEntry::Tool { .. }),
            "second entry is Tool"
        );
        assert!(
            matches!(ffi.entries[2], FfiTimelineEntry::Assistant { .. }),
            "third entry is Assistant"
        );
        assert_eq!(
            ffi.work_groups.len(),
            2,
            "each turn has one tool work group"
        );
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "test fixture builder mirrors shell thread json fields"
    )]
    fn thread_shell_json(
        id: &str,
        project_id: &str,
        title: &str,
        updated_at: &str,
        status: &str,
        settled_at: Option<&str>,
        parent_thread_id: Option<&str>,
        pinned_at: Option<&str>,
        latest_run_completed_at: Option<&str>,
        last_visited_at: Option<&str>,
    ) -> serde_json::Value {
        let root_thread_id = parent_thread_id.unwrap_or(id);
        json!({
            "createdBy": "user",
            "creationSource": "web",
            "id": id,
            "projectId": project_id,
            "title": title,
            "providerInstanceId": "claudeAgent",
            "modelSelection": { "instanceId": "claudeAgent", "model": "haiku" },
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "branch": "main",
            "worktreePath": null,
            "lineage": {
                "rootThreadId": root_thread_id,
                "parentThreadId": parent_thread_id,
                "relationshipToParent": null
            },
            "forkedFrom": null,
            "activeProviderThreadId": null,
            "latestRunId": null,
            "latestRunCompletedAt": latest_run_completed_at,
            "activeRunId": null,
            "status": status,
            "pendingRuntimeRequest": null,
            "latestVisibleMessage": null,
            "latestUserMessageAt": updated_at,
            "hasActionableProposedPlan": false,
            "itemCount": 0,
            "visibleItemCount": 0,
            "createdAt": updated_at,
            "updatedAt": updated_at,
            "archivedAt": null,
            "settledOverride": null,
            "settledAt": settled_at,
            "pinnedAt": pinned_at,
            "lastVisitedAt": last_visited_at,
            "deletedAt": null
        })
    }

    #[test]
    fn thread_summary_carries_the_failure_message_only_while_failed() {
        let thread = |id: &str, status: &str, error: &str, class: &str| {
            let mut json = thread_shell_json(
                id,
                "p-active",
                id,
                "2026-11-22T12:00:00Z",
                status,
                None,
                None,
                None,
                None,
                None,
            );
            json["lastError"] = json!(error);
            json["lastErrorClass"] = json!(class);
            json
        };
        let item: OrchestrationV2ShellStreamItem = serde_json::from_value(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 1,
                "projects": [{
                    "id": "p-active",
                    "title": "Conn",
                    "workspaceRoot": "/tmp/conn",
                    "defaultModelSelection": null,
                    "scripts": [],
                    "createdAt": "2026-11-20T00:00:00Z",
                    "updatedAt": "2026-11-20T00:00:00Z",
                    "archivedAt": null
                }],
                "threads": [
                    thread("t-failed", "failed", "Model claude-x is not available", "provider_error"),
                    thread("t-limited", "failed", "Usage limit reached", "usage_limit"),
                    thread("t-recovered", "idle", "Old error", "provider_error"),
                    thread("t-blank", "failed", "  ", "unknown"),
                ],
                "archivedThreads": []
            }
        }))
        .unwrap_or_else(|e| panic!("deserialize shell snapshot: {e}"));
        let mut shell = ShellState::default();
        shell.apply(item);

        let snap = build_shell_snapshot(&shell);
        let row = |id: &str| {
            snap.threads
                .iter()
                .find(|t| t.id == id)
                .unwrap_or_else(|| panic!("row {id} missing from shell snapshot"))
        };
        assert_eq!(
            row("t-failed").failure_message.as_deref(),
            Some("Model claude-x is not available"),
            "a failed thread shows its provider error"
        );
        assert!(
            !row("t-failed").usage_limited,
            "a provider error is not a usage limit"
        );
        assert_eq!(
            row("t-limited").failure_message.as_deref(),
            Some("Usage limit reached"),
            "a usage-limited thread shows its error"
        );
        assert!(
            row("t-limited").usage_limited,
            "usage_limit marks the row limited"
        );
        assert_eq!(
            row("t-recovered").failure_message,
            None,
            "a thread that is no longer failed hides its old error"
        );
        assert_eq!(
            row("t-blank").failure_message,
            None,
            "a blank error shows nothing"
        );
    }

    #[test]
    fn builds_shell_snapshot_with_newest_first_ordering_settled_pinned_and_unread_flags() {
        let snapshot_json = json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 10,
                "projects": [
                    {
                        "id": "p-active",
                        "title": "Conn",
                        "workspaceRoot": "/tmp/conn",
                        "defaultModelSelection": null,
                        "scripts": [],
                        "createdAt": "2026-11-20T00:00:00Z",
                        "updatedAt": "2026-11-20T00:00:00Z",
                        "archivedAt": null
                    },
                    {
                        "id": "p-archived",
                        "title": "Old",
                        "workspaceRoot": "/tmp/old",
                        "defaultModelSelection": null,
                        "scripts": [],
                        "createdAt": "2026-11-19T00:00:00Z",
                        "updatedAt": "2026-11-19T00:00:00Z",
                        "archivedAt": "2026-11-20T00:00:00Z"
                    }
                ],
                "threads": [
                    thread_shell_json(
                        "t-old",
                        "p-active",
                        "Older active",
                        "2026-11-22T09:00:00Z",
                        "idle",
                        None,
                        None,
                        Some("2026-11-22T09:30:00Z"),
                        Some("2026-11-22T09:05:00.500Z"),
                        Some("2026-11-22T09:05:00.499Z")
                    ),
                    thread_shell_json(
                        "t-new",
                        "p-active",
                        "Newer active",
                        "2026-11-22T11:00:00Z",
                        "running",
                        None,
                        None,
                        None,
                        Some("2026-11-22T10:59:00.000Z"),
                        Some("2026-11-22T10:59:00.000Z")
                    ),
                    thread_shell_json(
                        "t-sub",
                        "p-active",
                        "Child subagent",
                        "2026-11-22T12:00:00Z",
                        "running",
                        None,
                        Some("t-new"),
                        None,
                        None,
                        None
                    ),
                    thread_shell_json(
                        "t-settled-old",
                        "p-active",
                        "Settled older",
                        "2026-11-22T08:00:00Z",
                        "completed",
                        Some("2026-11-22T08:05:00Z"),
                        None,
                        None,
                        None,
                        None
                    ),
                    thread_shell_json(
                        "t-settled-new",
                        "p-active",
                        "Settled newer",
                        "2026-11-22T10:00:00Z",
                        "failed",
                        Some("2026-11-22T10:05:00Z"),
                        None,
                        None,
                        None,
                        None
                    )
                ],
                "archivedThreads": [
                    thread_shell_json(
                        "t-archived",
                        "p-active",
                        "Archived settled",
                        "2026-11-22T10:30:00Z",
                        "completed",
                        None,
                        None,
                        None,
                        None,
                        None
                    )
                ]
            }
        });

        let item: OrchestrationV2ShellStreamItem =
            serde_json::from_value(snapshot_json).expect("shell snapshot json must decode");
        let sync_item: OrchestrationV2ShellStreamItem =
            serde_json::from_value(json!({ "kind": "synchronized" }))
                .expect("synchronized json must decode");

        let mut shell = ShellState::default();
        shell.apply(item);
        assert!(
            !build_shell_snapshot(&shell).synchronized,
            "synchronized is false before Synchronized item"
        );
        shell.apply(sync_item);

        let snap = build_shell_snapshot(&shell);
        assert!(snap.synchronized, "synchronized must be true after marker");
        assert_eq!(snap.projects.len(), 1, "archived projects must be filtered");
        assert_eq!(snap.projects[0].id, "p-active");

        let ids: Vec<&str> = snap.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "t-new",
                "t-old",
                "t-archived",
                "t-settled-new",
                "t-settled-old",
            ],
            "active threads newest-first, then settled threads newest-first, excluding subagents"
        );
        assert!(!snap.threads[0].settled);
        assert!(!snap.threads[0].pinned);
        assert!(
            !snap.threads[0].unread,
            "visited == completed must not be unread"
        );
        assert_eq!(snap.threads[0].activity, FfiThreadActivity::Working);

        assert!(!snap.threads[1].settled);
        assert!(snap.threads[1].pinned, "pinnedAt populates pinned flag");
        assert!(
            snap.threads[1].unread,
            "completedAt 1 ms after lastVisitedAt (mark-unread) must be unread"
        );
        assert_eq!(snap.threads[1].activity, FfiThreadActivity::Idle);

        assert!(snap.threads[2].settled);
        assert!(snap.threads[3].settled);
        assert_eq!(snap.threads[3].activity, FfiThreadActivity::Failed);
        assert!(snap.threads[4].settled);
    }

    #[test]
    fn credential_debug_redacts_secrets() {
        let code = FfiCredential::PairingCode {
            code: "super-secret-code".to_owned(),
        };
        let bearer = FfiCredential::Bearer {
            token: "super-secret-token".to_owned(),
        };
        assert!(!format!("{code:?}").contains("super-secret-code"));
        assert!(!format!("{bearer:?}").contains("super-secret-token"));
    }
}
