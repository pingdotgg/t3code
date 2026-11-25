//! Pure composer logic shared by the GPUI views (and, later, the iOS client via
//! `conn-state::composer`): plain data in and out, no GPUI types.

/// Unsent composer content for one thread or draft (`composerDraftStore` `ComposerThreadDraftState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComposerDraft<A> {
    pub(crate) text: String,
    pub(crate) attachments: Vec<A>,
}

impl<A> Default for ComposerDraft<A> {
    fn default() -> Self {
        Self {
            text: String::new(),
            attachments: Vec::new(),
        }
    }
}

impl<A> ComposerDraft<A> {
    /// Conn drops drafts with no prompt text and no attachments (`composerDraftHasUserContent`).
    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.attachments.is_empty()
    }
}

/// Store key for a started thread.
#[must_use]
pub(crate) fn thread_draft_key(thread_id: &str) -> String {
    format!("thread:{thread_id}")
}

/// The thread id behind a [`thread_draft_key`].
#[must_use]
pub(crate) fn thread_id_from_key(key: &str) -> Option<&str> {
    key.strip_prefix("thread:")
}

/// Store key for a new-thread draft. The key follows the draft's id, not its project, so a
/// draft keeps its content when the picker moves it to another project (Conn's
/// `draftsByThreadKey` is keyed by draft id too).
#[must_use]
pub(crate) fn new_thread_draft_key(draft_id: &str) -> String {
    format!("draft:{draft_id}")
}

/// The draft id behind a [`new_thread_draft_key`].
#[must_use]
pub(crate) fn draft_id_from_key(key: &str) -> Option<&str> {
    key.strip_prefix("draft:")
}

/// Per-thread / per-draft unsent composer content, so switching threads never loses a prompt.
#[derive(Clone, Debug)]
pub(crate) struct ComposerDraftStore<A> {
    active_key: Option<String>,
    parked: std::collections::HashMap<String, ComposerDraft<A>>,
    /// The active key's live content was discarded; the composer clears it on its next sync.
    active_discarded: bool,
}

impl<A> Default for ComposerDraftStore<A> {
    fn default() -> Self {
        Self {
            active_key: None,
            parked: std::collections::HashMap::new(),
            active_discarded: false,
        }
    }
}

impl<A> ComposerDraftStore<A> {
    #[must_use]
    pub(crate) fn active_key(&self) -> Option<&str> {
        self.active_key.as_deref()
    }

    /// Parks `current` under the active key and returns the draft to show for `next_key`.
    /// Returns `None` when `next_key` is already active (nothing to swap).
    pub(crate) fn switch(
        &mut self,
        next_key: Option<&str>,
        current: ComposerDraft<A>,
    ) -> Option<ComposerDraft<A>> {
        if self.active_key.as_deref() == next_key {
            return None;
        }
        let discarded = std::mem::take(&mut self.active_discarded);
        if let Some(key) = self.active_key.take()
            && !discarded
            && !current.is_empty()
        {
            self.parked.insert(key, current);
        }
        self.active_key = next_key.map(str::to_owned);
        Some(
            next_key
                .and_then(|key| self.parked.remove(key))
                .unwrap_or_default(),
        )
    }

    /// Drops `key`'s draft once it is sent or discarded (`clearDraftThread`) and returns the
    /// parked content it held. When `key` is active, the composer clears its live content on
    /// its next sync ([`Self::take_discarded`]).
    pub(crate) fn discard(&mut self, key: &str) -> Option<ComposerDraft<A>> {
        if self.active_key.as_deref() == Some(key) {
            self.active_discarded = true;
        }
        self.parked.remove(key)
    }

    /// The content parked under `key`.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn parked_draft(&self, key: &str) -> Option<&ComposerDraft<A>> {
        self.parked.get(key)
    }

    /// Every parked draft with its key.
    pub(crate) fn parked_drafts(&self) -> impl Iterator<Item = (&str, &ComposerDraft<A>)> {
        self.parked.iter().map(|(key, draft)| (key.as_str(), draft))
    }

    /// Parks `draft` under `key` without making it active (a draft restored from disk, or an
    /// undone discard). An empty draft is not kept, as in [`Self::switch`]. The draft is not
    /// put under the active key, whose live content the composer owns.
    pub(crate) fn park(&mut self, key: &str, draft: ComposerDraft<A>) {
        if draft.is_empty() || self.active_key.as_deref() == Some(key) {
            return;
        }
        self.parked.insert(key.to_owned(), draft);
    }

    /// Changes the text parked under `key` (empty when nothing is parked) when `edit` returns the
    /// new text, and drops the draft if that leaves it empty. A draft the composer shows
    /// is not parked, so it is left alone. Returns whether the text changed.
    pub(crate) fn edit_parked_text(
        &mut self,
        key: &str,
        edit: impl FnOnce(&str) -> Option<String>,
    ) -> bool {
        if self.active_key.as_deref() == Some(key) {
            return false;
        }
        let mut draft = self.parked.remove(key).unwrap_or_default();
        let changed = match edit(&draft.text) {
            Some(text) if text != draft.text => {
                draft.text = text;
                true
            }
            _ => false,
        };
        if !draft.is_empty() {
            self.parked.insert(key.to_owned(), draft);
        }
        changed
    }

    /// `true` once when the active draft was discarded and its live content must be cleared.
    pub(crate) fn take_discarded(&mut self) -> bool {
        std::mem::take(&mut self.active_discarded)
    }

    /// Mutable access to parked attachments, so uploads that finish after a switch still land.
    pub(crate) fn parked_attachments_mut(&mut self) -> impl Iterator<Item = &mut A> {
        self.parked
            .values_mut()
            .flat_map(|d| d.attachments.iter_mut())
    }
}

/// Replaces Git-rejected ASCII whitespace with `-` (`sanitizeNewRefName`).
#[must_use]
pub(crate) fn sanitize_new_ref_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_space = false;
    for ch in raw.trim().chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0c' | '\x0b') {
            if !in_space {
                out.push('-');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

/// `origin/feature` -> `feature` (`deriveLocalBranchNameFromRemoteRef`).
#[must_use]
pub(crate) fn local_branch_name_from_remote_ref(name: &str) -> &str {
    match name.find('/') {
        Some(idx) if idx > 0 && idx < name.len() - 1 => &name[idx + 1..],
        _ => name,
    }
}

/// One git ref listed by `vcs.listRefs`, reduced to what the picker needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefEntry {
    pub(crate) name: String,
    pub(crate) is_remote: bool,
    pub(crate) current: bool,
    pub(crate) is_default: bool,
    pub(crate) worktree_path: Option<String>,
}

/// One row in the branch picker (`BranchToolbarBranchSelector` `branchPickerItems`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BranchPickerRow {
    /// Index into the listed refs.
    Ref(usize),
    /// `Create new ref "<name>"` with the sanitized name.
    Create(String),
}

/// Picker rows for `query`: matching refs, then `Create new ref` when the query names no
/// listed ref and creating is allowed (never while picking a new worktree's base).
#[must_use]
pub(crate) fn branch_picker_rows(
    refs: &[RefEntry],
    query: &str,
    can_create: bool,
) -> Vec<BranchPickerRow> {
    let trimmed = query.trim();
    let normalized = trimmed.to_lowercase();
    let sanitized = sanitize_new_ref_name(&normalized);
    let mut rows: Vec<BranchPickerRow> = refs
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            if normalized.is_empty() {
                return true;
            }
            let name = r.name.to_lowercase();
            name.contains(&normalized)
                || (!sanitized.is_empty() && sanitized != normalized && name.contains(&sanitized))
        })
        .map(|(idx, _)| BranchPickerRow::Ref(idx))
        .collect();
    let new_ref = sanitize_new_ref_name(trimmed);
    if can_create && !new_ref.is_empty() && !refs.iter().any(|r| r.name == new_ref) {
        rows.push(BranchPickerRow::Create(new_ref));
    }
    rows
}

/// Trailing badge on a ref row (`BranchPickerRefItem`).
#[must_use]
pub(crate) fn ref_badge(entry: &RefEntry, project_cwd: Option<&str>) -> Option<&'static str> {
    let other_worktree = matches!(
        (entry.worktree_path.as_deref(), project_cwd),
        (Some(path), Some(cwd)) if path != cwd
    );
    if entry.current {
        Some("current")
    } else if other_worktree {
        Some("worktree")
    } else if entry.is_remote {
        Some("remote")
    } else if entry.is_default {
        Some("default")
    } else {
        None
    }
}

/// Branch trigger label (`resolveBranchTriggerLabel`).
#[must_use]
pub(crate) fn branch_trigger_label(
    branch: Option<&str>,
    selecting_worktree_base: bool,
    start_from_origin: bool,
    branch_is_remote: Option<bool>,
) -> String {
    let Some(branch) = branch.filter(|b| !b.is_empty()) else {
        return "Select ref".to_owned();
    };
    if selecting_worktree_base {
        if start_from_origin && branch_is_remote == Some(false) {
            return format!("From {branch} (remote)");
        }
        return format!("From {branch}");
    }
    branch.to_owned()
}

/// Where picking a ref leaves the thread (`resolveBranchSelectionTarget`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchSelectionTarget {
    pub(crate) checkout_cwd: String,
    pub(crate) next_worktree_path: Option<String>,
    pub(crate) reuse_existing_worktree: bool,
    pub(crate) stays_in_active_checkout: bool,
}

fn path_is_within(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[must_use]
pub(crate) fn branch_selection_target(
    project_cwd: &str,
    active_worktree_path: Option<&str>,
    entry: &RefEntry,
) -> BranchSelectionTarget {
    if let Some(path) = entry.worktree_path.as_deref() {
        let next = (!path_is_within(project_cwd, path)).then(|| path.to_owned());
        return BranchSelectionTarget {
            checkout_cwd: path.to_owned(),
            stays_in_active_checkout: next.as_deref() == active_worktree_path,
            next_worktree_path: next,
            reuse_existing_worktree: true,
        };
    }
    let next = if active_worktree_path.is_some() && entry.is_default {
        None
    } else {
        active_worktree_path.map(str::to_owned)
    };
    BranchSelectionTarget {
        checkout_cwd: next.clone().unwrap_or_else(|| project_cwd.to_owned()),
        stays_in_active_checkout: next.as_deref() == active_worktree_path,
        next_worktree_path: next,
        reuse_existing_worktree: false,
    }
}

/// A project thread's workspace, for `Previous worktree`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ThreadWorkspace<'a> {
    pub(crate) branch: Option<&'a str>,
    pub(crate) worktree_path: Option<&'a str>,
    /// ISO-8601 `updatedAt`; compared as text, which orders ISO timestamps correctly.
    pub(crate) updated_at: &'a str,
    pub(crate) archived: bool,
}

/// The project's most recently updated worktree thread (`resolvePreviousWorktreeSeed`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreviousWorktree {
    pub(crate) branch: Option<String>,
    pub(crate) worktree_path: String,
}

#[must_use]
pub(crate) fn previous_worktree<'a>(
    threads: impl IntoIterator<Item = ThreadWorkspace<'a>>,
    current_worktree_path: Option<&str>,
) -> Option<PreviousWorktree> {
    threads
        .into_iter()
        .filter(|t| !t.archived && !t.updated_at.is_empty())
        .filter_map(|t| {
            let path = t.worktree_path?;
            (Some(path) != current_worktree_path).then_some((t, path))
        })
        .max_by(|(a, _), (b, _)| a.updated_at.cmp(b.updated_at))
        .map(|(t, path)| PreviousWorktree {
            branch: t.branch.map(str::to_owned),
            worktree_path: path.to_owned(),
        })
}

/// `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` (`packages/contracts/src/chatAttachment.ts`).
pub(crate) const PROVIDER_SEND_TURN_MAX_INPUT_CHARS: usize = 120_000;
const CLAUDE_ULTRATHINK_PREFIX: &str = "Ultrathink:\n";
const PLAN_IMPLEMENTATION_PROMPT_PREFIX: &str = "PLEASE IMPLEMENT THIS PLAN:\n";
/// `ATTACHMENT_ONLY_BOOTSTRAP_PROMPT` (`composerContextReferences.ts`).
const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT: &str = "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Inline alert while the prompt is over the provider limit
/// (`getComposerPromptLengthValidationMessage`); `None` when it fits.
#[must_use]
pub(crate) fn prompt_length_message(prompt: &str) -> Option<String> {
    let len = prompt.trim().chars().count();
    let excess = len.checked_sub(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)?;
    if excess == 0 {
        return None;
    }
    let noun = if excess == 1 {
        "character"
    } else {
        "characters"
    };
    Some(format!(
        "Prompt is {} {noun} over the {}-character limit. Shorten or split it before sending.",
        group_thousands(excess),
        group_thousands(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
    ))
}

/// Default editor placeholder (`DEFAULT_COMPOSER_PLACEHOLDER`).
pub(crate) const DEFAULT_COMPOSER_PLACEHOLDER: &str = "Ask anything. @ files, $ skills, / commands";

/// The pending requests a composer send answers instead of starting a turn
/// (`activePendingApproval`, `activePendingProgress`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ComposerPendingRequest {
    /// The thread's first pending approval (`activePendingApproval`, `isComposerApprovalState`).
    pub(crate) approval: Option<PendingApprovalPrompt>,
    /// The active question of the first pending question request.
    pub(crate) question: Option<PendingQuestion>,
}

/// The pending approval the composer answers (`activePendingApproval`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PendingApprovalPrompt {
    /// A send declines it with the typed text as feedback (`supportsFeedback`).
    pub(crate) supports_feedback: bool,
}

/// The active question of a pending question request (`activePendingProgress.activeQuestion`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PendingQuestion {
    /// `false` when the provider set `allowCustomAnswer: false` (`isChoiceOnlyPendingQuestion`).
    pub(crate) allow_custom_answer: bool,
    pub(crate) has_options: bool,
    /// The question card already holds an answer, so a blank send submits it.
    pub(crate) answered: bool,
}

/// What a composer send does (`useComposerSend` `onSend`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ComposerSendAction {
    /// Start a turn, or steer or queue the running one.
    Message,
    /// Decline the pending approvals, then steer the turn with the message
    /// (`declinePendingApprovals`, `followUpBehavior: "steer"`).
    RedirectApprovals,
    /// Decline the first approval with the typed text as its feedback (`sendApprovalFeedback`).
    DeclineWithFeedback,
    /// Answer the active question with the typed text, or with its selection when blank
    /// (`onAdvanceActivePendingUserInput`).
    AnswerQuestion,
    /// Nothing to send: a choice-only question, or a blank answer with nothing selected.
    Blocked,
}

/// A question outranks an approval, as in Conn's send handler (`answeringQuestion` first).
#[must_use]
pub(crate) fn composer_send_action(
    pending: &ComposerPendingRequest,
    text_is_blank: bool,
) -> ComposerSendAction {
    match pending.question {
        Some(q) if !q.allow_custom_answer => ComposerSendAction::Blocked,
        Some(q) if text_is_blank && !q.answered => ComposerSendAction::Blocked,
        Some(_) => ComposerSendAction::AnswerQuestion,
        None => match pending.approval {
            Some(approval) if approval.supports_feedback => ComposerSendAction::DeclineWithFeedback,
            Some(_) => ComposerSendAction::RedirectApprovals,
            None => ComposerSendAction::Message,
        },
    }
}

/// What a send over pending approvals does, decided from the thread's live approvals when the
/// send reaches the app (`useComposerSend` `approvalFeedbackTarget` / `approvalsToDecline`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ApprovalSendPlan {
    /// No approval is pending: send the message as usual.
    Message,
    /// Decline the first approval with `feedback` and send nothing else (`sendApprovalFeedback`).
    Feedback {
        request_id: String,
        feedback: String,
    },
    /// Feedback is text only; the draft stays so the user can remove its attachments.
    FeedbackNeedsPlainText,
    /// Decline every answerable approval in `decline`, then send the message
    /// (`declinePendingApprovals`). `shown` holds every pending one, answerable or not.
    Redirect {
        shown: Vec<String>,
        decline: Vec<String>,
    },
}

/// The draft an approval send leaves in the composer until the decline settles, so the app can
/// tell whether the user changed it meanwhile (`draftChangedSinceSend`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeldDraft {
    pub(crate) text: String,
    pub(crate) attachment_ids: Vec<u64>,
}

/// Error shown when approval feedback carries attachments (`useComposerSend`).
pub(crate) const APPROVAL_FEEDBACK_PLAIN_TEXT: &str =
    "Send approval feedback without attachments or added context.";

/// Conn gives feedback only to the first approval, and only when its provider takes feedback.
#[must_use]
pub(crate) fn plan_approval_send(
    approvals: &[conn_state::PendingApproval],
    text: &str,
    has_attachments: bool,
) -> ApprovalSendPlan {
    let Some(first) = approvals.first() else {
        return ApprovalSendPlan::Message;
    };
    if first.supports_feedback {
        return if has_attachments {
            ApprovalSendPlan::FeedbackNeedsPlainText
        } else {
            ApprovalSendPlan::Feedback {
                request_id: first.request_id.clone(),
                feedback: text.trim().to_owned(),
            }
        };
    }
    ApprovalSendPlan::Redirect {
        shown: approvals.iter().map(|a| a.request_id.clone()).collect(),
        // A request the provider can no longer answer has nothing to decline.
        decline: approvals
            .iter()
            .filter(|a| a.answerable)
            .map(|a| a.request_id.clone())
            .collect(),
    }
}

/// True when `now` holds an approval that was not pending before the decline; it would block
/// the redirect, so the message waits for the next send to decline it too.
#[must_use]
pub(crate) fn approval_arrived(before: &[String], now: &[conn_state::PendingApproval]) -> bool {
    now.iter().any(|a| !before.contains(&a.request_id))
}

/// Why a redirect kept the draft instead of sending it (`approvalRedirectNotice`); `None` when
/// the decline failed on its own, which reports its own error.
#[must_use]
pub(crate) fn approval_redirect_notice(
    draft_changed: bool,
    declined: bool,
    approval_responding: bool,
    approval_arrived: bool,
) -> Option<&'static str> {
    if draft_changed {
        return Some(if declined {
            "Approval declined. Your message changed, so it wasn't sent."
        } else {
            "Your message changed, so it wasn't sent."
        });
    }
    if approval_responding {
        return Some("An approval is already being answered, so your message wasn't sent.");
    }
    if declined && approval_arrived {
        return Some("Another approval arrived, so your message wasn't sent.");
    }
    None
}

/// Second line of every redirect notice (`description`).
pub(crate) const APPROVAL_REDIRECT_RETRY: &str = "Send again when it's ready.";

/// The pending approval and question the composer shows: the first approval unless it is held
/// (`activePendingApproval`), and the first question's entry id unless it is held, which hides
/// every question until the hold lifts (`holdingUserInput`).
#[must_use]
pub(crate) fn guarded_pending_requests(
    approvals: &[conn_state::PendingApproval],
    question: Option<&(String, String)>,
    held: &std::collections::HashSet<String>,
) -> (Option<PendingApprovalPrompt>, Option<String>) {
    let approval = approvals
        .first()
        .filter(|approval| !held.contains(&approval.request_id))
        .map(|approval| PendingApprovalPrompt {
            supports_feedback: approval.supports_feedback,
        });
    let question = question
        .filter(|(_, request_id)| !held.contains(request_id))
        .map(|(entry_id, _)| entry_id.clone());
    (approval, question)
}

/// How long typing must pause before held requests show (`COMPOSER_TYPING_IDLE_MS`).
pub(crate) const COMPOSER_TYPING_IDLE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Holds approvals and questions that arrive while the user types in the composer, so Enter or
/// the next keystroke never answers or redirects a prompt they have not seen
/// (`composerTypingGuard.ts`). Holds lift on blur, on send, and after
/// [`COMPOSER_TYPING_IDLE`] without typing.
#[derive(Clone, Debug, Default)]
pub(crate) struct TypingGuard {
    seen: std::collections::HashSet<String>,
    held: std::collections::HashSet<String>,
    focused: bool,
    last_typed_at: Option<std::time::Instant>,
}

/// An input to [`TypingGuard::update`] (`TypingGuardEvent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TypingGuardInput {
    /// The user edited the prompt (not a question's answer).
    Typed,
    Focus,
    Blur,
    Send,
    Idle,
}

impl TypingGuard {
    /// Request ids held back from the composer and the timeline.
    pub(crate) fn held(&self) -> &std::collections::HashSet<String> {
        &self.held
    }

    /// Takes the current pending request ids. A request seen for the first time while the
    /// focused composer was typed in within [`COMPOSER_TYPING_IDLE`] is held; a held request
    /// that is no longer pending is dropped. Returns whether the held set changed.
    pub(crate) fn requests(&mut self, request_ids: &[String], now: std::time::Instant) -> bool {
        let before = self.held.len();
        self.held.retain(|id| request_ids.contains(id));
        let mut changed = self.held.len() != before;
        let typing = self.focused
            && self
                .last_typed_at
                .is_some_and(|at| now.saturating_duration_since(at) < COMPOSER_TYPING_IDLE);
        for id in request_ids {
            if self.seen.insert(id.clone()) && typing {
                changed |= self.held.insert(id.clone());
            }
        }
        changed
    }

    /// Applies one editor event. Returns whether the held set changed.
    pub(crate) fn update(&mut self, input: TypingGuardInput, now: std::time::Instant) -> bool {
        match input {
            TypingGuardInput::Typed => {
                self.last_typed_at = Some(now);
                false
            }
            TypingGuardInput::Focus => {
                self.focused = true;
                false
            }
            TypingGuardInput::Blur | TypingGuardInput::Send | TypingGuardInput::Idle => {
                if input == TypingGuardInput::Blur {
                    self.focused = false;
                }
                self.last_typed_at = None;
                let changed = !self.held.is_empty();
                self.held.clear();
                changed
            }
        }
    }

    /// Starts over for another thread or draft, keeping the editor's focus
    /// (`useComposerTypingGuard` scope change).
    pub(crate) fn reset_scope(&mut self) {
        *self = Self {
            focused: self.focused,
            ..Self::default()
        };
    }

    /// When the idle release is due while requests are held.
    pub(crate) fn idle_deadline(&self) -> Option<std::time::Instant> {
        if self.held.is_empty() {
            return None;
        }
        Some(
            self.last_typed_at
                .map_or_else(std::time::Instant::now, |at| at + COMPOSER_TYPING_IDLE),
        )
    }
}

/// Store key for the composer's answer to the question request `entry_id`, kept apart from the
/// thread's draft like Conn's `activePendingProgress.customAnswer`.
#[must_use]
pub(crate) fn question_answer_draft_key(entry_id: &str) -> String {
    format!("question:{entry_id}")
}

/// Editor placeholder for the composer's state (`ChatComposer.tsx` `placeholder`).
#[must_use]
pub(crate) fn composer_placeholder(
    pending: &ComposerPendingRequest,
    provider_unavailable: bool,
) -> &'static str {
    if let Some(approval) = pending.approval {
        if approval.supports_feedback {
            "Send feedback to decline this request"
        } else {
            "Send a message to decline and redirect the agent"
        }
    } else if let Some(q) = pending.question {
        if !q.allow_custom_answer {
            "Choose an option above"
        } else if !q.has_options {
            "Type your answer"
        } else {
            "Type your own answer, or leave this blank to use the selected option"
        }
    } else if provider_unavailable {
        "Enable a provider in Settings to send a message"
    } else {
        DEFAULT_COMPOSER_PLACEHOLDER
    }
}

/// Removes trailing `<review_comment>` blocks and legacy context blocks the composer cannot hold.
fn strip_trailing_blocks(mut prompt: String) -> String {
    loop {
        let trimmed = prompt.trim_end();
        let mut cut = None;
        for tag in [
            "review_comment",
            "terminal_context",
            "element_context",
            "preview_annotation",
        ] {
            let close = format!("</{tag}>");
            if trimmed.ends_with(&close)
                && let Some(start) = trimmed.rfind(&format!("<{tag}"))
            {
                cut = Some(start);
                break;
            }
        }
        match cut {
            Some(start) => prompt = prompt[..start].trim_end().to_owned(),
            None => return prompt,
        }
    }
}

/// A sent message's text as the composer can hold it (`recallableComposerPrompt`).
#[must_use]
pub(crate) fn recallable_prompt(text: &str) -> String {
    let mut prompt = text.trim();
    if let Some(rest) = prompt.strip_prefix(CLAUDE_ULTRATHINK_PREFIX) {
        prompt = rest;
    }
    let prompt = strip_trailing_blocks(prompt.to_owned());
    let trimmed = prompt.trim();
    if trimmed == ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
        || trimmed.starts_with(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
    {
        return String::new();
    }
    trimmed.to_owned()
}

/// One recallable prompt the user typed in this thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromptHistoryEntry {
    pub(crate) id: String,
    pub(crate) prompt: String,
}

/// Recallable prompts from `(message id, text, created_by_agent)` user messages, oldest first;
/// agent messages are skipped and repeats collapse (`buildComposerPromptHistoryEntries`).
#[must_use]
pub(crate) fn prompt_history_entries<'a>(
    messages: impl IntoIterator<Item = (&'a str, &'a str, bool)>,
) -> Vec<PromptHistoryEntry> {
    let mut entries: Vec<PromptHistoryEntry> = Vec::new();
    for (id, text, by_agent) in messages {
        if by_agent {
            continue;
        }
        let prompt = recallable_prompt(text);
        if prompt.is_empty() {
            continue;
        }
        let entry = PromptHistoryEntry {
            id: id.to_owned(),
            prompt,
        };
        match entries.last_mut() {
            Some(last) if last.prompt == entry.prompt => *last = entry,
            _ => entries.push(entry),
        }
    }
    entries
}

/// Where the user is while browsing history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromptHistoryPosition {
    pub(crate) entry_id: String,
    pub(crate) recalled: String,
}

/// Result of one ↑/↓ step: the prompt to show and the new position (`None` = back to empty).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromptHistoryStep {
    pub(crate) position: Option<PromptHistoryPosition>,
    pub(crate) prompt: String,
}

/// ↑ (`backward`) or ↓ through sent prompts (`stepComposerPromptHistory`). `None` leaves the key
/// to the editor: ↑ on a prompt the user typed, or ↓ when not browsing.
#[must_use]
pub(crate) fn step_prompt_history(
    backward: bool,
    entries: &[PromptHistoryEntry],
    position: Option<&PromptHistoryPosition>,
    current_prompt: &str,
) -> Option<PromptHistoryStep> {
    let active = position
        .filter(|p| p.recalled == current_prompt)
        .and_then(|p| {
            entries
                .iter()
                .position(|e| e.id == p.entry_id)
                .or_else(|| entries.iter().rposition(|e| e.prompt == p.recalled))
        });
    let recall = |entry: &PromptHistoryEntry| PromptHistoryStep {
        position: Some(PromptHistoryPosition {
            entry_id: entry.id.clone(),
            recalled: entry.prompt.clone(),
        }),
        prompt: entry.prompt.clone(),
    };
    if backward {
        if active.is_none() && !current_prompt.is_empty() {
            return None;
        }
        let idx = match active {
            None => entries.len().checked_sub(1)?,
            Some(i) => i.checked_sub(1)?,
        };
        return entries.get(idx).map(recall);
    }
    let i = active?;
    Some(entries.get(i + 1).map_or(
        PromptHistoryStep {
            position: None,
            prompt: String::new(),
        },
        recall,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        BranchPickerRow, ComposerDraft, ComposerDraftStore, PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
        PreviousWorktree, PromptHistoryEntry, RefEntry, ThreadWorkspace, branch_picker_rows,
        branch_selection_target, branch_trigger_label, composer_placeholder, draft_id_from_key,
        local_branch_name_from_remote_ref, new_thread_draft_key, previous_worktree,
        prompt_history_entries, prompt_length_message, recallable_prompt, ref_badge,
        sanitize_new_ref_name, step_prompt_history, thread_draft_key, thread_id_from_key,
    };

    fn draft(text: &str, attachments: &[u32]) -> ComposerDraft<u32> {
        ComposerDraft {
            text: text.to_owned(),
            attachments: attachments.to_vec(),
        }
    }

    #[test]
    fn draft_store_parks_and_restores_per_key_and_drops_empty_drafts() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = thread_draft_key("a");
        let b = thread_draft_key("b");
        let new = new_thread_draft_key("p");
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
        assert_eq!(store.switch(Some(&a), draft("typing", &[])), None);

        // Leaving `a` parks its prompt and attachment; `b` starts empty.
        assert_eq!(
            store.switch(Some(&b), draft("half a prompt", &[7])),
            Some(draft("", &[]))
        );
        // Whitespace-only `b` is not kept.
        assert_eq!(
            store.switch(Some(&new), draft("  ", &[])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&b), draft("new thread idea", &[])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&a), draft("", &[])),
            Some(draft("half a prompt", &[7]))
        );
        // Restoring removes it from the parked set; the draft is live again.
        assert_eq!(store.switch(None, draft("", &[])), Some(draft("", &[])));
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
        assert_eq!(
            store.switch(Some(&new), draft("", &[])),
            Some(draft("new thread idea", &[]))
        );
    }

    #[test]
    fn draft_store_reaches_parked_attachments() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = thread_draft_key("a");
        let new = new_thread_draft_key("p");
        store.switch(Some(&a), draft("", &[]));
        store.switch(Some(&new), draft("x", &[1, 2]));
        for att in store.parked_attachments_mut() {
            *att += 10;
        }
        assert_eq!(
            store.switch(Some(&a), draft("", &[])),
            Some(draft("x", &[11, 12]))
        );
    }

    #[test]
    fn new_thread_drafts_are_kept_per_draft_id() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("a");
        let b = new_thread_draft_key("b");
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
        // Start in A, move on to B, start there, and A comes back with its text and attachments.
        assert_eq!(
            store.switch(Some(&b), draft("idea for a", &[3])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&a), draft("idea for b", &[])),
            Some(draft("idea for a", &[3]))
        );
        assert_eq!(
            store.switch(Some(&b), draft("idea for a", &[3])),
            Some(draft("idea for b", &[]))
        );
        assert_eq!(draft_id_from_key(&a), Some("a"));
        assert_eq!(draft_id_from_key(&thread_draft_key("a")), None);
        assert_eq!(thread_id_from_key(&thread_draft_key("t")), Some("t"));
        assert_eq!(thread_id_from_key(&a), None);
    }

    #[test]
    fn two_drafts_for_one_project_never_share_content() {
        // A draft moved to a project that already has one leaves that one parked under its own
        // id: the moved draft keeps its own key, so nothing is replaced.
        let mut store = ComposerDraftStore::<u32>::default();
        let own = new_thread_draft_key("own");
        let moved = new_thread_draft_key("moved");
        store.switch(Some(&own), draft("", &[]));
        store.switch(Some(&moved), draft("the project's own idea", &[]));
        assert_eq!(
            store.switch(None, draft("moved idea", &[1])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.parked_draft(&own),
            Some(&draft("the project's own idea", &[]))
        );
        assert_eq!(store.parked_draft(&moved), Some(&draft("moved idea", &[1])));
        assert_eq!(store.parked_drafts().count(), 2);
    }

    #[test]
    fn parking_restores_a_draft_without_making_it_active() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("a");
        let b = new_thread_draft_key("b");
        store.park(&a, draft("from disk", &[]));
        store.park(&b, draft("  ", &[]));
        assert!(store.parked_draft(&b).is_none());
        assert_eq!(store.active_key(), None);
        assert_eq!(
            store.switch(Some(&a), draft("", &[])),
            Some(draft("from disk", &[]))
        );
        // The active key's live content is the composer's, so parking under it does nothing.
        store.park(&a, draft("late", &[]));
        assert!(store.parked_draft(&a).is_none());
    }

    #[test]
    fn discarding_a_draft_clears_it_for_good() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("a");
        let b = new_thread_draft_key("b");
        let t = thread_draft_key("t");
        store.switch(Some(&a), draft("", &[]));
        store.switch(Some(&b), draft("parked a", &[1]));

        // A parked draft is dropped at once, and handed back for an undo.
        assert_eq!(store.discard(&a), Some(draft("parked a", &[1])));
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));

        // The active draft's live content is not parked when the composer moves on.
        assert_eq!(store.discard(&a), None);
        assert!(store.take_discarded());
        assert!(!store.take_discarded());
        store.discard(&a);
        assert_eq!(
            store.switch(Some(&t), draft("sent", &[2])),
            Some(draft("", &[]))
        );
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
    }

    #[test]
    fn parked_text_is_edited_in_place() {
        let mut store = ComposerDraftStore::<u32>::default();
        let thread = thread_draft_key("t");
        let question = super::question_answer_draft_key("q");
        store.switch(Some(&question), draft("", &[]));
        // Nothing parked yet: the edit starts from empty text and parks the result.
        assert!(store.edit_parked_text(&thread, |text| Some(format!("{text}set aside"))));
        assert_eq!(store.parked_draft(&thread), Some(&draft("set aside", &[])));
        // The attachments stay, and an edit that changes nothing reports it.
        store.park(&thread, draft("set aside", &[7]));
        assert!(!store.edit_parked_text(&thread, |_| None));
        assert!(!store.edit_parked_text(&thread, |text| Some(text.to_owned())));
        assert!(store.edit_parked_text(&thread, |_| Some("moved".to_owned())));
        assert_eq!(store.parked_draft(&thread), Some(&draft("moved", &[7])));
        // Emptied text with no attachments drops the draft.
        store.park(&thread, draft("only text", &[]));
        assert!(store.edit_parked_text(&thread, |_| Some(String::new())));
        assert!(store.parked_draft(&thread).is_none());
        // The shown draft belongs to the composer.
        assert!(!store.edit_parked_text(&question, |_| Some("x".to_owned())));
    }

    fn git_ref(name: &str) -> RefEntry {
        RefEntry {
            name: name.to_owned(),
            is_remote: false,
            current: false,
            is_default: false,
            worktree_path: None,
        }
    }

    #[test]
    fn ref_names_sanitize_and_strip_remotes() {
        assert_eq!(sanitize_new_ref_name("  my  new\tbranch "), "my-new-branch");
        assert_eq!(sanitize_new_ref_name("a\u{a0}b"), "a\u{a0}b");
        assert_eq!(local_branch_name_from_remote_ref("origin/feat/x"), "feat/x");
        assert_eq!(local_branch_name_from_remote_ref("main"), "main");
        assert_eq!(local_branch_name_from_remote_ref("origin/"), "origin/");
    }

    #[test]
    fn branch_picker_filters_and_offers_create_only_for_new_names() {
        let refs = [
            git_ref("main"),
            git_ref("feat/new-picker"),
            git_ref("origin/main"),
        ];
        assert_eq!(
            branch_picker_rows(&refs, "", true),
            [
                BranchPickerRow::Ref(0),
                BranchPickerRow::Ref(1),
                BranchPickerRow::Ref(2)
            ]
        );
        // Spaces match the sanitized name, and creating offers the sanitized name.
        assert_eq!(
            branch_picker_rows(&refs, "New Picker", true),
            [
                BranchPickerRow::Ref(1),
                BranchPickerRow::Create("New-Picker".to_owned())
            ]
        );
        assert_eq!(
            branch_picker_rows(&refs, "main", true),
            [BranchPickerRow::Ref(0), BranchPickerRow::Ref(2)]
        );
        assert_eq!(branch_picker_rows(&refs, "zzz", false), []);
    }

    #[test]
    fn ref_badges_follow_conn_priority() {
        let mut r = git_ref("x");
        r.is_default = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("default"));
        r.is_remote = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("remote"));
        r.worktree_path = Some("/p".to_owned());
        assert_eq!(ref_badge(&r, Some("/p")), Some("remote"));
        r.worktree_path = Some("/wt".to_owned());
        assert_eq!(ref_badge(&r, Some("/p")), Some("worktree"));
        r.current = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("current"));
    }

    #[test]
    fn branch_trigger_labels() {
        assert_eq!(branch_trigger_label(None, false, false, None), "Select ref");
        assert_eq!(
            branch_trigger_label(Some("main"), false, true, Some(false)),
            "main"
        );
        assert_eq!(
            branch_trigger_label(Some("main"), true, false, Some(false)),
            "From main"
        );
        assert_eq!(
            branch_trigger_label(Some("main"), true, true, Some(false)),
            "From main (remote)"
        );
        assert_eq!(
            branch_trigger_label(Some("origin/main"), true, true, Some(true)),
            "From origin/main"
        );
    }

    #[test]
    fn branch_selection_reuses_worktrees_and_leaves_them_for_default() {
        let mut in_wt = git_ref("feat");
        in_wt.worktree_path = Some("/wt/feat".to_owned());
        let t = branch_selection_target("/p", None, &in_wt);
        assert!(t.reuse_existing_worktree && !t.stays_in_active_checkout);
        assert_eq!(t.next_worktree_path.as_deref(), Some("/wt/feat"));
        assert_eq!(t.checkout_cwd, "/wt/feat");

        let mut at_root = git_ref("main");
        at_root.worktree_path = Some("/p".to_owned());
        let t = branch_selection_target("/p", Some("/wt/a"), &at_root);
        assert_eq!(t.next_worktree_path, None);

        let mut default = git_ref("main");
        default.is_default = true;
        let t = branch_selection_target("/p", Some("/wt/a"), &default);
        assert_eq!(
            (t.checkout_cwd.as_str(), t.next_worktree_path),
            ("/p", None)
        );
        let t = branch_selection_target("/p", Some("/wt/a"), &git_ref("other"));
        assert_eq!(t.checkout_cwd, "/wt/a");
        assert!(t.stays_in_active_checkout);
    }

    #[test]
    fn previous_worktree_picks_latest_other_unarchived_worktree() {
        let ws = |branch, path, updated_at, archived| ThreadWorkspace {
            branch,
            worktree_path: path,
            updated_at,
            archived,
        };
        let threads = [
            ws(Some("a"), Some("/wt/a"), "2026-11-01T00:00:00.000Z", false),
            ws(Some("b"), Some("/wt/b"), "2026-11-03T00:00:00.000Z", true),
            ws(None, None, "2026-11-04T00:00:00.000Z", false),
            ws(Some("c"), Some("/wt/c"), "2026-11-02T00:00:00.000Z", false),
        ];
        assert_eq!(
            previous_worktree(threads, None),
            Some(PreviousWorktree {
                branch: Some("c".to_owned()),
                worktree_path: "/wt/c".to_owned()
            })
        );
        assert_eq!(
            previous_worktree(threads, Some("/wt/c")).map(|p| p.worktree_path),
            Some("/wt/a".to_owned())
        );
    }

    #[test]
    fn prompt_length_message_counts_excess_characters() {
        let at_limit = "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
        assert_eq!(prompt_length_message(&format!("  {at_limit}\n")), None);
        assert_eq!(
            prompt_length_message(&format!("{at_limit}b")).as_deref(),
            Some(
                "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending."
            )
        );
        assert_eq!(
            prompt_length_message(&"é".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1_234))
                .as_deref(),
            Some(
                "Prompt is 1,234 characters over the 120,000-character limit. Shorten or split it before sending."
            )
        );
        assert_eq!(
            composer_placeholder(&Default::default(), true),
            "Enable a provider in Settings to send a message"
        );
    }

    #[test]
    fn recallable_prompt_strips_prefixes_and_context_blocks() {
        assert_eq!(recallable_prompt("Ultrathink:\nfix it"), "fix it");
        assert_eq!(
            recallable_prompt(
                "look here\n\n<review_comment path=\"a\">x</review_comment>\n<terminal_context>\n- t lines 1-2:\nls\n</terminal_context>"
            ),
            "look here"
        );
        assert_eq!(recallable_prompt("PLEASE IMPLEMENT THIS PLAN:\n# Plan"), "");
        assert_eq!(
            recallable_prompt(
                "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]"
            ),
            ""
        );
    }

    #[test]
    fn prompt_history_walks_typed_prompts_and_stops_on_user_text() {
        let entries = prompt_history_entries([
            ("m1", "first", false),
            ("m2", "agent note", true),
            ("m3", "second", false),
            ("m4", "second", false),
            ("m5", "PLEASE IMPLEMENT THIS PLAN:\nx", false),
        ]);
        assert_eq!(
            entries,
            [
                PromptHistoryEntry {
                    id: "m1".into(),
                    prompt: "first".into()
                },
                PromptHistoryEntry {
                    id: "m4".into(),
                    prompt: "second".into()
                },
            ]
        );
        // ↓ does nothing until browsing; ↑ on typed text leaves the key to the editor.
        assert_eq!(step_prompt_history(false, &entries, None, ""), None);
        assert_eq!(step_prompt_history(true, &entries, None, "draft"), None);

        let up = step_prompt_history(true, &entries, None, "").expect("latest");
        assert_eq!(up.prompt, "second");
        let up2 =
            step_prompt_history(true, &entries, up.position.as_ref(), "second").expect("older");
        assert_eq!(up2.prompt, "first");
        assert_eq!(
            step_prompt_history(true, &entries, up2.position.as_ref(), "first"),
            None
        );
        let down =
            step_prompt_history(false, &entries, up2.position.as_ref(), "first").expect("newer");
        assert_eq!(down.prompt, "second");
        let back =
            step_prompt_history(false, &entries, down.position.as_ref(), "second").expect("empty");
        assert_eq!((back.position, back.prompt.as_str()), (None, ""));
        // Editing a recalled prompt ends browsing.
        assert_eq!(
            step_prompt_history(true, &entries, down.position.as_ref(), "second!"),
            None
        );
    }
}

#[cfg(test)]
mod pending_request_tests {
    use super::{
        ApprovalSendPlan, ComposerPendingRequest, ComposerSendAction, DEFAULT_COMPOSER_PLACEHOLDER,
        PendingApprovalPrompt, PendingQuestion, approval_arrived, approval_redirect_notice,
        composer_placeholder, composer_send_action, plan_approval_send,
    };

    const REDIRECT: Option<PendingApprovalPrompt> = Some(PendingApprovalPrompt {
        supports_feedback: false,
    });
    const FEEDBACK: Option<PendingApprovalPrompt> = Some(PendingApprovalPrompt {
        supports_feedback: true,
    });

    fn approval(
        id: &str,
        answerable: bool,
        supports_feedback: bool,
    ) -> conn_state::PendingApproval {
        conn_state::PendingApproval {
            entry_id: format!("item-{id}"),
            request_id: id.to_owned(),
            answerable,
            supports_feedback,
        }
    }

    const fn question(
        allow_custom_answer: bool,
        has_options: bool,
        answered: bool,
    ) -> PendingQuestion {
        PendingQuestion {
            allow_custom_answer,
            has_options,
            answered,
        }
    }

    #[test]
    fn placeholder_follows_the_pending_request() {
        let none = ComposerPendingRequest::default();
        let approval = ComposerPendingRequest {
            approval: REDIRECT,
            question: None,
        };
        let ask = |q| ComposerPendingRequest {
            approval: None,
            question: Some(q),
        };
        assert_eq!(
            composer_placeholder(&none, false),
            DEFAULT_COMPOSER_PLACEHOLDER
        );
        assert_eq!(
            composer_placeholder(&approval, true),
            "Send a message to decline and redirect the agent"
        );
        assert_eq!(
            composer_placeholder(
                &ComposerPendingRequest {
                    approval: FEEDBACK,
                    question: None,
                },
                false
            ),
            "Send feedback to decline this request"
        );
        assert_eq!(
            composer_placeholder(&ask(question(false, true, false)), false),
            "Choose an option above"
        );
        assert_eq!(
            composer_placeholder(&ask(question(true, false, false)), false),
            "Type your answer"
        );
        assert_eq!(
            composer_placeholder(&ask(question(true, true, true)), true),
            "Type your own answer, or leave this blank to use the selected option"
        );
        // An approval outranks a question in the placeholder.
        assert_eq!(
            composer_placeholder(
                &ComposerPendingRequest {
                    approval: REDIRECT,
                    question: Some(question(false, true, false)),
                },
                false
            ),
            "Send a message to decline and redirect the agent"
        );
    }

    #[test]
    fn send_answers_questions_before_redirecting_approvals() {
        let ask = |approval: bool, q| ComposerPendingRequest {
            approval: if approval { REDIRECT } else { None },
            question: Some(q),
        };
        assert_eq!(
            composer_send_action(&ComposerPendingRequest::default(), false),
            ComposerSendAction::Message
        );
        assert_eq!(
            composer_send_action(
                &ComposerPendingRequest {
                    approval: REDIRECT,
                    question: None,
                },
                false
            ),
            ComposerSendAction::RedirectApprovals
        );
        assert_eq!(
            composer_send_action(
                &ComposerPendingRequest {
                    approval: FEEDBACK,
                    question: None,
                },
                false
            ),
            ComposerSendAction::DeclineWithFeedback
        );
        assert_eq!(
            composer_send_action(&ask(true, question(true, true, false)), false),
            ComposerSendAction::AnswerQuestion
        );
        // A blank send uses the selected option, and needs one.
        assert_eq!(
            composer_send_action(&ask(false, question(true, true, true)), true),
            ComposerSendAction::AnswerQuestion
        );
        assert_eq!(
            composer_send_action(&ask(false, question(true, true, false)), true),
            ComposerSendAction::Blocked
        );
        // A choice-only question is answered in its card, never from the composer.
        assert_eq!(
            composer_send_action(&ask(false, question(false, true, true)), false),
            ComposerSendAction::Blocked
        );
    }

    #[test]
    fn approval_send_gives_feedback_to_the_first_approval_or_declines_answerable_ones() {
        assert_eq!(
            plan_approval_send(&[], "hi", false),
            ApprovalSendPlan::Message
        );
        // Feedback goes to the first approval only, trimmed, and never with attachments.
        let feedback = [approval("a", true, true), approval("b", true, false)];
        assert_eq!(
            plan_approval_send(&feedback, "  use staging  ", false),
            ApprovalSendPlan::Feedback {
                request_id: "a".to_owned(),
                feedback: "use staging".to_owned(),
            }
        );
        assert_eq!(
            plan_approval_send(&feedback, "use staging", true),
            ApprovalSendPlan::FeedbackNeedsPlainText
        );
        // A later approval's feedback support does not make this a feedback send.
        let redirect = [
            approval("a", true, false),
            approval("gone", false, false),
            approval("c", true, true),
        ];
        assert_eq!(
            plan_approval_send(&redirect, "do X instead", true),
            ApprovalSendPlan::Redirect {
                shown: vec!["a".to_owned(), "gone".to_owned(), "c".to_owned()],
                decline: vec!["a".to_owned(), "c".to_owned()],
            }
        );
    }

    #[test]
    fn redirect_guards_name_why_the_message_stayed() {
        let before = ["a".to_owned()];
        assert!(!approval_arrived(&before, &[approval("a", true, false)]));
        assert!(!approval_arrived(&before, &[]));
        assert!(approval_arrived(&before, &[approval("b", true, false)]));

        assert_eq!(
            approval_redirect_notice(true, true, false, true),
            Some("Approval declined. Your message changed, so it wasn't sent.")
        );
        assert_eq!(
            approval_redirect_notice(true, false, true, false),
            Some("Your message changed, so it wasn't sent.")
        );
        assert_eq!(
            approval_redirect_notice(false, false, true, false),
            Some("An approval is already being answered, so your message wasn't sent.")
        );
        assert_eq!(
            approval_redirect_notice(false, true, false, true),
            Some("Another approval arrived, so your message wasn't sent.")
        );
        // A failed decline reports its own error; an arrival only matters after a decline.
        assert_eq!(approval_redirect_notice(false, false, false, true), None);
        assert_eq!(approval_redirect_notice(false, true, false, false), None);
    }

    #[test]
    fn typing_guard_holds_requests_that_arrive_while_typing() {
        use super::{COMPOSER_TYPING_IDLE, TypingGuard, TypingGuardInput};
        use std::time::{Duration, Instant};

        let t0 = Instant::now();
        let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        let mut guard = TypingGuard::default();

        // Requests already pending when the composer opens are never held.
        assert!(!guard.requests(&ids(&["a"]), t0));
        // Typing without focus holds nothing.
        guard.update(TypingGuardInput::Typed, t0);
        assert!(!guard.requests(&ids(&["a", "b"]), t0));
        assert!(guard.held().is_empty());

        guard.update(TypingGuardInput::Focus, t0);
        guard.update(TypingGuardInput::Typed, t0);
        assert!(guard.requests(&ids(&["a", "b", "c"]), t0 + Duration::from_millis(100)));
        assert_eq!(guard.held().len(), 1);
        assert!(guard.held().contains("c"));
        assert_eq!(guard.idle_deadline(), Some(t0 + COMPOSER_TYPING_IDLE));
        // A request seen once is not held again; one that resolves stops being held.
        assert!(guard.requests(&ids(&["a", "b"]), t0));
        assert!(guard.held().is_empty());
        assert!(!guard.requests(&ids(&["a", "b", "c"]), t0));

        // After the idle window a new request shows at once.
        let late = t0 + COMPOSER_TYPING_IDLE;
        assert!(!guard.requests(&ids(&["d"]), late));
        assert!(guard.held().is_empty());

        // Blur, send and idle each release every hold.
        for release in [
            TypingGuardInput::Blur,
            TypingGuardInput::Send,
            TypingGuardInput::Idle,
        ] {
            guard.update(TypingGuardInput::Focus, late);
            guard.update(TypingGuardInput::Typed, late);
            let fresh = format!("{release:?}");
            assert!(guard.requests(std::slice::from_ref(&fresh), late));
            assert!(guard.update(release, late));
            assert!(guard.held().is_empty());
            assert_eq!(guard.idle_deadline(), None);
            // Holds released, the request stays seen.
            assert!(!guard.requests(&[fresh], late));
        }
        // Blur leaves the editor unfocused, so typing holds nothing until it is focused again.
        guard.update(TypingGuardInput::Blur, late);
        guard.update(TypingGuardInput::Typed, late);
        assert!(!guard.requests(&ids(&["e"]), late));
    }

    #[test]
    fn typing_guard_scope_change_forgets_requests_but_keeps_focus() {
        use super::{TypingGuard, TypingGuardInput};
        use std::time::Instant;

        let now = Instant::now();
        let mut guard = TypingGuard::default();
        guard.update(TypingGuardInput::Focus, now);
        guard.update(TypingGuardInput::Typed, now);
        assert!(guard.requests(&["a".to_owned()], now));
        guard.reset_scope();
        assert!(guard.held().is_empty());
        // Still focused, but the typing clock restarted: the other thread's pending requests show.
        assert!(!guard.requests(&["b".to_owned()], now));
        guard.update(TypingGuardInput::Typed, now);
        assert!(guard.requests(&["b".to_owned(), "c".to_owned()], now));
        assert!(guard.held().contains("c"));
    }

    #[test]
    fn held_requests_leave_the_composer() {
        use super::guarded_pending_requests;
        use std::collections::HashSet;

        let approvals = [approval("a", true, true), approval("b", true, false)];
        let question = ("item-q".to_owned(), "q".to_owned());
        let held = |ids: &[&str]| {
            ids.iter()
                .map(|id| (*id).to_owned())
                .collect::<HashSet<_>>()
        };

        assert_eq!(
            guarded_pending_requests(&approvals, Some(&question), &held(&[])),
            (FEEDBACK, Some("item-q".to_owned()))
        );
        // Holding the first approval clears the approval state, even with a later one shown.
        assert_eq!(
            guarded_pending_requests(&approvals, Some(&question), &held(&["a", "q"])),
            (None, None)
        );
        assert_eq!(
            guarded_pending_requests(&approvals, None, &held(&["b"])),
            (FEEDBACK, None)
        );
    }
}
