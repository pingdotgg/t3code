//! Pure composer logic shared by the GPUI views (and, later, the iOS client via
//! `conn-state::composer`): plain data in and out, no GPUI types.

/// One project offered by the new-thread draft project combobox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProjectPickerItem<'a> {
    pub(crate) id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) pinned: bool,
    /// The server's scratch ("no project") project; never listed.
    pub(crate) is_scratch: bool,
}

/// One row in the draft project combobox (`DraftHeroHeadline.tsx` `pickerItems`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProjectPickerRow {
    Project(String),
    AddProject,
}

/// Combobox rows for `query`: non-scratch projects (pinned first, otherwise in shell order),
/// then `Add project` while the search is empty (`filteredPickerItems` hides it while searching).
#[must_use]
pub(crate) fn project_picker_rows<'a>(
    items: impl IntoIterator<Item = ProjectPickerItem<'a>>,
    query: &str,
) -> Vec<ProjectPickerRow> {
    let needle = query.trim().to_lowercase();
    let mut matching: Vec<ProjectPickerItem<'a>> = items
        .into_iter()
        .filter(|p| !p.is_scratch)
        .filter(|p| needle.is_empty() || p.title.to_lowercase().contains(&needle))
        .collect();
    matching.sort_by_key(|p| !p.pinned);
    let mut rows: Vec<ProjectPickerRow> = matching
        .into_iter()
        .map(|p| ProjectPickerRow::Project(p.id.to_owned()))
        .collect();
    if needle.is_empty() {
        rows.push(ProjectPickerRow::AddProject);
    }
    rows
}

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

/// Store key for a project's new-thread draft: one per project, like Conn's
/// `projectDraftThreadKeyByProjectKey`.
#[must_use]
pub(crate) fn new_thread_draft_key(environment_id: &str, project_id: &str) -> String {
    format!("draft:new:{environment_id}:{project_id}")
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

    /// The picker retargets the active new-thread draft to `next_key`
    /// (`DraftHeroHeadline` `selectProject`). A draft with content moves along, so the project it
    /// left has no draft; the target's own parked draft is displaced (Conn keeps it as an unmapped
    /// draft row, which this client has no row for). An empty draft stays put, and the next
    /// `switch` shows the target's own draft. Returns `true` when the content moved.
    pub(crate) fn retarget(&mut self, next_key: &str, current_is_empty: bool) -> bool {
        if current_is_empty
            || self.active_discarded
            || self.active_key.as_deref().is_none_or(|key| key == next_key)
        {
            return false;
        }
        self.parked.remove(next_key);
        self.active_key = Some(next_key.to_owned());
        true
    }

    /// Drops `key`'s draft once it is sent or discarded (`clearDraftThread`). When `key` is
    /// active, the composer clears its live content on its next sync ([`Self::take_discarded`]).
    pub(crate) fn discard(&mut self, key: &str) {
        self.parked.remove(key);
        if self.active_key.as_deref() == Some(key) {
            self.active_discarded = true;
        }
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
    /// The thread shows a pending approval (`isComposerApprovalState`).
    pub(crate) approval: bool,
    /// The active question of the first pending question request.
    pub(crate) question: Option<PendingQuestion>,
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
        None if pending.approval => ComposerSendAction::RedirectApprovals,
        None => ComposerSendAction::Message,
    }
}

/// Store key for the composer's answer to the question request `entry_id`, kept apart from the
/// thread's draft like Conn's `activePendingProgress.customAnswer`.
#[must_use]
pub(crate) fn question_answer_draft_key(entry_id: &str) -> String {
    format!("question:{entry_id}")
}

/// Editor placeholder for the composer's state (`ChatComposer.tsx` `placeholder`). This client
/// does not see `supportsFeedback`, so an approval always shows the redirect placeholder.
#[must_use]
pub(crate) fn composer_placeholder(
    pending: &ComposerPendingRequest,
    provider_unavailable: bool,
) -> &'static str {
    if pending.approval {
        "Send a message to decline and redirect the agent"
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
        PreviousWorktree, ProjectPickerItem, ProjectPickerRow, PromptHistoryEntry, RefEntry,
        ThreadWorkspace, branch_picker_rows, branch_selection_target, branch_trigger_label,
        composer_placeholder, local_branch_name_from_remote_ref, new_thread_draft_key,
        previous_worktree, project_picker_rows, prompt_history_entries, prompt_length_message,
        recallable_prompt, ref_badge, sanitize_new_ref_name, step_prompt_history, thread_draft_key,
    };

    fn item<'a>(
        id: &'a str,
        title: &'a str,
        pinned: bool,
        is_scratch: bool,
    ) -> ProjectPickerItem<'a> {
        ProjectPickerItem {
            id,
            title,
            pinned,
            is_scratch,
        }
    }

    fn ids(rows: &[ProjectPickerRow]) -> Vec<&str> {
        rows.iter()
            .map(|row| match row {
                ProjectPickerRow::Project(id) => id.as_str(),
                ProjectPickerRow::AddProject => "+add",
            })
            .collect()
    }

    #[test]
    fn project_picker_hides_scratch_pins_first_and_adds_project_only_without_query() {
        let items = [
            item("a", "conn", false, false),
            item("s", "Scratch", false, true),
            item("b", "orbit", true, false),
            item("c", "Conn GPUI", false, false),
        ];
        assert_eq!(
            ids(&project_picker_rows(items, "")),
            ["b", "a", "c", "+add"]
        );
        assert_eq!(ids(&project_picker_rows(items, "  CONN ")), ["a", "c"]);
        assert!(project_picker_rows(items, "scratch").is_empty());
    }

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
        let new = new_thread_draft_key("env", "p");
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
        let new = new_thread_draft_key("env", "p");
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
    fn new_thread_drafts_are_kept_per_project() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("env", "a");
        let b = new_thread_draft_key("env", "b");
        let other_env = new_thread_draft_key("other", "a");
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
        // The same project on another environment is another draft.
        assert_eq!(
            store.switch(Some(&other_env), draft("idea for b", &[])),
            Some(draft("", &[]))
        );
    }

    #[test]
    fn retargeting_moves_a_draft_with_content_and_leaves_an_empty_one() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("env", "a");
        let b = new_thread_draft_key("env", "b");
        let c = new_thread_draft_key("env", "c");
        store.switch(Some(&b), draft("", &[]));
        store.switch(Some(&c), draft("b's own idea", &[]));
        store.switch(Some(&a), draft("c's own idea", &[]));

        // A has content: it follows the picker to B and replaces B's own draft.
        assert!(store.retarget(&b, false));
        assert_eq!(store.active_key(), Some(b.as_str()));
        assert_eq!(store.switch(Some(&b), draft("moved", &[])), None);
        // A has no draft left of its own.
        assert_eq!(
            store.switch(Some(&a), draft("moved", &[])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&b), draft("", &[])),
            Some(draft("moved", &[]))
        );

        // An empty draft stays put; the target shows its own draft after the switch.
        assert!(!store.retarget(&c, true));
        assert_eq!(store.active_key(), Some(b.as_str()));
        assert_eq!(
            store.switch(Some(&c), draft("", &[])),
            Some(draft("c's own idea", &[]))
        );
        // No active draft, or the target is already active: nothing moves.
        assert!(!store.retarget(&c, false));
        assert!(!ComposerDraftStore::<u32>::default().retarget(&c, false));
    }

    #[test]
    fn discarding_a_draft_clears_it_for_good() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = new_thread_draft_key("env", "a");
        let b = new_thread_draft_key("env", "b");
        let t = thread_draft_key("t");
        store.switch(Some(&a), draft("", &[]));
        store.switch(Some(&b), draft("parked a", &[1]));

        // A parked draft is dropped at once.
        store.discard(&a);
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));

        // The active draft's live content is not parked when the composer moves on.
        store.discard(&a);
        assert!(store.take_discarded());
        assert!(!store.take_discarded());
        store.discard(&a);
        assert_eq!(
            store.switch(Some(&t), draft("sent", &[2])),
            Some(draft("", &[]))
        );
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
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
        ComposerPendingRequest, ComposerSendAction, DEFAULT_COMPOSER_PLACEHOLDER, PendingQuestion,
        composer_placeholder, composer_send_action,
    };

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
            approval: true,
            question: None,
        };
        let ask = |q| ComposerPendingRequest {
            approval: false,
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
                    approval: true,
                    question: Some(question(false, true, false)),
                },
                false
            ),
            "Send a message to decline and redirect the agent"
        );
    }

    #[test]
    fn send_answers_questions_before_redirecting_approvals() {
        let ask = |approval, q| ComposerPendingRequest {
            approval,
            question: Some(q),
        };
        assert_eq!(
            composer_send_action(&ComposerPendingRequest::default(), false),
            ComposerSendAction::Message
        );
        assert_eq!(
            composer_send_action(
                &ComposerPendingRequest {
                    approval: true,
                    question: None,
                },
                false
            ),
            ComposerSendAction::RedirectApprovals
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
}
