//! Pure business logic and presentation helpers for the Pull request surface.
//!
//! Mirrors Conn's `pullRequestDetail.logic.ts`, `pullRequestPresentation.tsx`, and
//! `pullRequestIcons.tsx`, kept free of GPUI/I/O so every rule is unit-tested.

use std::collections::{BTreeMap, HashMap, HashSet};

use conn_contract::{
    OrchestrationV2AppThread, PullRequestAction, PullRequestActionInputUpdateMethod,
    PullRequestActor, PullRequestCheck, PullRequestCheckStatus, PullRequestComment,
    PullRequestCommentKind, PullRequestCommit, PullRequestDetail, PullRequestDetailAutoMergeMethod,
    PullRequestDetailBaseComparison, PullRequestMergeability, PullRequestRef,
    PullRequestReviewThread, PullRequestState, ThreadPullRequestLink, ThreadPullRequestLinkSource,
};
use conn_desktop::orbit::insights::parse_date_ms;
use conn_theme::{Appearance, Rgba, Tokens, color_mix_srgb, parse_color};

use super::super::diff_parser::{DiffFile, DiffHunk, DiffLine, DiffLineKind};

/// Tabs in Conn's `PullRequestDetailPanel`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(super) enum DetailTab {
    #[default]
    Summary,
    Checks,
    Timeline,
    Code,
}

impl DetailTab {
    pub(super) const ALL: [Self; 4] = [Self::Summary, Self::Checks, Self::Timeline, Self::Code];

    #[must_use]
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Checks => "checks",
            Self::Timeline => "timeline",
            Self::Code => "code",
        }
    }

    #[must_use]
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Summary => "Description",
            Self::Checks => "Checks",
            Self::Timeline => "Timeline",
            Self::Code => "Code",
        }
    }
}

/// Timeline chronological ordering toggle (`PullRequestDetailPanel.tsx`: `timelineOrder`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum TimelineOrder {
    #[default]
    Newest,
    Oldest,
}

impl TimelineOrder {
    #[must_use]
    pub(super) const fn toggled(self) -> Self {
        match self {
            Self::Newest => Self::Oldest,
            Self::Oldest => Self::Newest,
        }
    }

    #[must_use]
    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Newest => "Newest first",
            Self::Oldest => "Oldest first",
        }
    }
}

/// Saved comment filter (`PullRequestTimelineTab.tsx`: `DEFAULT_PULL_REQUEST_COMMENT_FILTER`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct CommentFilter {
    pub(super) bots: bool,
    pub(super) resolved: bool,
}

/// A resolved pull request reference together with its display URL when already known.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ResolvedPullRequestTarget {
    pub(super) reference: PullRequestRef,
    pub(super) url: Option<String>,
}

/// Resolves the pull request target attached to a thread, mirroring
/// `threadPullRequestPanelTarget` in `pullRequestDetail.logic.ts`.
#[must_use]
pub(super) fn resolve_thread_pr_target(
    thread: &OrchestrationV2AppThread,
) -> Option<ResolvedPullRequestTarget> {
    if let Some(links) = &thread.pull_requests
        && let Some(current) = select_current_thread_pr_link(links)
    {
        return Some(ResolvedPullRequestTarget {
            reference: PullRequestRef {
                project_id: thread.project_id.clone(),
                host: Some(current.host.clone()),
                expected_account_id: None,
                allow_stale: None,
                repository: current.repository.clone(),
                number: current.number,
            },
            url: Some(current.url.clone()),
        });
    }

    let legacy = thread
        .linked_pull_request
        .as_ref()
        .and_then(|inner| inner.as_ref())
        .or_else(|| {
            thread
                .branch_pull_request
                .as_ref()
                .and_then(|inner| inner.as_ref())
        })?;

    let parsed = parse_pull_request_url(&legacy.url);
    Some(ResolvedPullRequestTarget {
        reference: PullRequestRef {
            project_id: legacy.project_id.clone(),
            host: parsed.as_ref().map(|p| p.host.clone()),
            expected_account_id: None,
            allow_stale: None,
            repository: legacy.repository.clone(),
            number: legacy.number,
        },
        url: Some(legacy.url.clone()),
    })
}

/// Picks the active visible pull request link on a thread: ignores `StackDismissed` links,
/// prefers the most recently linked open PR, otherwise the most recently linked PR.
#[must_use]
pub(super) fn select_current_thread_pr_link(
    links: &[ThreadPullRequestLink],
) -> Option<&ThreadPullRequestLink> {
    let visible: Vec<&ThreadPullRequestLink> = links
        .iter()
        .filter(|link| link.source != ThreadPullRequestLinkSource::StackDismissed)
        .collect();
    if visible.is_empty() {
        return None;
    }
    let open = visible
        .iter()
        .copied()
        .filter(|link| {
            link.snapshot
                .as_ref()
                .is_none_or(|snap| snap.state == PullRequestState::Open)
        })
        .max_by_key(|link| parse_date_ms(&link.linked_at).unwrap_or(i64::MIN));
    open.or_else(|| {
        visible
            .into_iter()
            .max_by_key(|link| parse_date_ms(&link.linked_at).unwrap_or(i64::MIN))
    })
}

/// Parsed components of a pull/merge request URL across GitHub, GitLab, Forgejo, Bitbucket, etc.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ParsedPullRequestUrl {
    pub(super) host: String,
    pub(super) repository: String,
    pub(super) number: i64,
    pub(super) repository_url: String,
}

/// Parses a pull request URL (`https://github.com/owner/repo/pull/42`,
/// `https://gitlab.com/group/repo/-/merge_requests/7`, etc.) into host, repository, and number.
#[must_use]
pub(super) fn parse_pull_request_url(raw: &str) -> Option<ParsedPullRequestUrl> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let scheme = url.scheme();
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();

    // GitLab: /<owner>/<repo>/-/merge_requests/<n>
    if let Some(pos) = segments.iter().position(|s| *s == "merge_requests")
        && pos >= 2
        && let Some(num) = segments.get(pos + 1).and_then(|s| s.parse::<i64>().ok())
    {
        let repo_end = if segments.get(pos - 1) == Some(&"-") {
            pos - 1
        } else {
            pos
        };
        if repo_end >= 2 {
            let repository = segments[..repo_end].join("/");
            return Some(ParsedPullRequestUrl {
                repository_url: format!("{scheme}://{host}/{repository}"),
                host,
                repository,
                number: num,
            });
        }
    }

    // GitHub / Forgejo / Bitbucket / Origin: /<owner>/<repo>/(pull|pulls|pull-requests|pr)/<n>
    for marker in ["pull", "pulls", "pull-requests", "pr"] {
        if let Some(pos) = segments.iter().position(|s| *s == marker)
            && pos >= 2
            && let Some(num) = segments.get(pos + 1).and_then(|s| s.parse::<i64>().ok())
        {
            let repository = segments[..pos].join("/");
            return Some(ParsedPullRequestUrl {
                repository_url: format!("{scheme}://{host}/{repository}"),
                host,
                repository,
                number: num,
            });
        }
    }

    None
}

/// The prominent primary header action (`PullRequestPrimaryAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PrimaryControl {
    Resolve,
    Ready,
    Merge,
    EnableAutoMerge,
    AutoMergeArmed,
    Merged,
    Closed,
    None,
}

/// Resolves the primary header action matching `resolvePullRequestPrimaryControl`.
#[must_use]
pub(super) fn resolve_primary_control(
    detail: &PullRequestDetail,
    checks_state: Option<ChecksState>,
) -> PrimaryControl {
    match detail.state {
        PullRequestState::Merged => return PrimaryControl::Merged,
        PullRequestState::Closed => return PrimaryControl::Closed,
        PullRequestState::Open => {}
    }
    if detail.mergeability == PullRequestMergeability::Conflicting {
        return PrimaryControl::Resolve;
    }
    if detail.is_draft {
        return if can_perform_action(detail, PullRequestAction::Ready) {
            PrimaryControl::Ready
        } else {
            PrimaryControl::None
        };
    }
    if detail.auto_merge_enabled == Some(true) {
        return PrimaryControl::AutoMergeArmed;
    }
    if allowed_merge_methods(detail).is_empty() {
        return PrimaryControl::None;
    }
    if detail.auto_merge_enabled == Some(false)
        && checks_state.is_some()
        && checks_state != Some(ChecksState::Passing)
        && can_perform_action(detail, PullRequestAction::EnableAutoMerge)
    {
        return PrimaryControl::EnableAutoMerge;
    }
    if can_perform_action(detail, PullRequestAction::Merge) {
        PrimaryControl::Merge
    } else {
        PrimaryControl::None
    }
}

/// Returns true when both the host capability and viewer permission allow `action`.
#[must_use]
pub(super) fn can_perform_action(detail: &PullRequestDetail, action: PullRequestAction) -> bool {
    detail.capabilities.actions.contains(&Some(action))
        && detail.viewer_permissions.actions.contains(&Some(action))
}

/// Returns true when the viewer may edit the PR title/description.
#[must_use]
pub(super) fn can_edit_change_request(detail: &PullRequestDetail) -> bool {
    detail
        .capabilities
        .edit
        .as_ref()
        .is_some_and(|edit| edit.change_request)
        && detail.viewer_permissions.edit_change_request != Some(false)
}

/// Returns true when the head branch can be deleted from the host.
#[must_use]
pub(super) fn can_delete_branch(detail: &PullRequestDetail) -> bool {
    detail.state != PullRequestState::Open
        && detail.capabilities.delete_branch == Some(true)
        && can_perform_action(detail, PullRequestAction::DeleteBranch)
}

/// Allowed merge methods filtered by both `capabilities.merge_methods` and `merge_capabilities`.
#[must_use]
pub(super) fn allowed_merge_methods(
    detail: &PullRequestDetail,
) -> Vec<PullRequestDetailAutoMergeMethod> {
    detail
        .capabilities
        .merge_methods
        .iter()
        .flatten()
        .copied()
        .filter(|method| match method {
            PullRequestDetailAutoMergeMethod::Merge => detail.merge_capabilities.merge,
            PullRequestDetailAutoMergeMethod::Squash => detail.merge_capabilities.squash,
            PullRequestDetailAutoMergeMethod::Rebase => detail.merge_capabilities.rebase,
            PullRequestDetailAutoMergeMethod::FastForward => {
                detail.merge_capabilities.fast_forward == Some(true)
            }
        })
        .collect()
}

/// Picks the effective merge method from the allowed list.
#[must_use]
pub(super) fn resolve_merge_method(
    allowed: &[PullRequestDetailAutoMergeMethod],
    selected: Option<PullRequestDetailAutoMergeMethod>,
    auto_merge_method: Option<PullRequestDetailAutoMergeMethod>,
) -> PullRequestDetailAutoMergeMethod {
    for candidate in [selected, auto_merge_method].into_iter().flatten() {
        if allowed.contains(&candidate) {
            return candidate;
        }
    }
    allowed
        .first()
        .copied()
        .unwrap_or(PullRequestDetailAutoMergeMethod::Merge)
}

#[must_use]
pub(super) const fn merge_method_label(method: PullRequestDetailAutoMergeMethod) -> &'static str {
    match method {
        PullRequestDetailAutoMergeMethod::Merge => "Merge",
        PullRequestDetailAutoMergeMethod::Squash => "Squash and merge",
        PullRequestDetailAutoMergeMethod::Rebase => "Rebase and merge",
        PullRequestDetailAutoMergeMethod::FastForward => "Fast-forward merge",
    }
}

#[must_use]
pub(super) const fn auto_merge_label(method: PullRequestDetailAutoMergeMethod) -> &'static str {
    match method {
        PullRequestDetailAutoMergeMethod::Merge => "Auto-merge (merge)",
        PullRequestDetailAutoMergeMethod::Squash => "Auto-merge (squash and merge)",
        PullRequestDetailAutoMergeMethod::Rebase => "Auto-merge (rebase and merge)",
        PullRequestDetailAutoMergeMethod::FastForward => "Auto-merge (fast-forward merge)",
    }
}

/// Base-branch freshness warning (`resolveBaseFreshness`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct BaseFreshness {
    pub(super) behind_by: Option<i64>,
    pub(super) methods: Vec<PullRequestActionInputUpdateMethod>,
}

#[must_use]
pub(super) fn resolve_base_freshness(detail: &PullRequestDetail) -> Option<BaseFreshness> {
    if detail.state != PullRequestState::Open
        || detail.base_comparison != Some(PullRequestDetailBaseComparison::Behind)
        || detail.mergeability != PullRequestMergeability::Mergeable
    {
        return None;
    }
    let offered = detail
        .capabilities
        .update_methods
        .as_deref()
        .unwrap_or_default();
    let allowed = detail
        .viewer_permissions
        .update_methods
        .as_deref()
        .unwrap_or_default();
    let methods = offered
        .iter()
        .flatten()
        .copied()
        .filter(|m| allowed.contains(&Some(*m)))
        .collect();
    Some(BaseFreshness {
        behind_by: detail.behind_by,
        methods,
    })
}

/// Visual presentation for a PR's state (`PULL_REQUEST_STATE_PRESENTATION`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StateTone {
    Open,
    Draft,
    Closed,
    Merged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StatePresentation {
    pub(super) label: &'static str,
    pub(super) icon: &'static str,
    pub(super) tone: StateTone,
}

#[must_use]
pub(super) const fn resolve_state_presentation(
    state: PullRequestState,
    is_draft: bool,
) -> StatePresentation {
    match (state, is_draft) {
        (PullRequestState::Open, true) => StatePresentation {
            label: "Draft",
            icon: "superhero/pull-request-draft.svg",
            tone: StateTone::Draft,
        },
        (PullRequestState::Open, false) => StatePresentation {
            label: "Open",
            icon: "superhero/pull-request.svg",
            tone: StateTone::Open,
        },
        (PullRequestState::Closed, _) => StatePresentation {
            label: "Closed",
            icon: "superhero/pull-request-closed.svg",
            tone: StateTone::Closed,
        },
        (PullRequestState::Merged, _) => StatePresentation {
            label: "Merged",
            icon: "superhero/merge.svg",
            tone: StateTone::Merged,
        },
    }
}

/// Maps a PR state tone onto `conn_theme::Tokens` (never hardcoded hex).
#[must_use]
pub(super) fn state_tone_color(tokens: &Tokens, tone: StateTone) -> Rgba {
    match tone {
        StateTone::Open => tokens.success,
        StateTone::Draft => tokens.muted_foreground,
        StateTone::Closed => tokens.destructive,
        StateTone::Merged => tokens.info,
    }
}

/// Rollup state of CI checks (`pullRequestChecksState`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChecksState {
    Passing,
    Failing,
    Pending,
}

#[must_use]
pub(super) fn classify_checks(checks: &[PullRequestCheck]) -> Option<ChecksState> {
    if checks.is_empty() {
        return None;
    }
    if checks.iter().any(|c| {
        matches!(
            c.status,
            PullRequestCheckStatus::Failure | PullRequestCheckStatus::Cancelled
        )
    }) {
        return Some(ChecksState::Failing);
    }
    if checks.iter().any(|c| {
        matches!(
            c.status,
            PullRequestCheckStatus::Pending | PullRequestCheckStatus::ActionRequired
        )
    }) {
        return Some(ChecksState::Pending);
    }
    if checks
        .iter()
        .any(|c| c.status == PullRequestCheckStatus::Success)
    {
        Some(ChecksState::Passing)
    } else {
        None
    }
}

#[must_use]
pub(super) fn is_workflow_approval_check(check: &PullRequestCheck) -> bool {
    if check.status != PullRequestCheckStatus::ActionRequired {
        return false;
    }
    let Some(url) = check.url.as_deref() else {
        return false;
    };
    if let Some((_, rest)) = url.split_once("/actions/runs/") {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        !digits.is_empty()
    } else {
        false
    }
}

#[must_use]
pub(super) fn check_status_label(check: &PullRequestCheck) -> &'static str {
    if is_workflow_approval_check(check) {
        return "Awaiting approval";
    }
    match check.status {
        PullRequestCheckStatus::Pending => "Running",
        PullRequestCheckStatus::ActionRequired => "Awaiting action",
        PullRequestCheckStatus::Success => "Passed",
        PullRequestCheckStatus::Failure => "Failed",
        PullRequestCheckStatus::Cancelled => "Cancelled",
        PullRequestCheckStatus::Skipped => "Skipped",
        PullRequestCheckStatus::Neutral => "Neutral",
    }
}

#[must_use]
pub(super) const fn check_status_icon(status: PullRequestCheckStatus) -> &'static str {
    match status {
        PullRequestCheckStatus::Pending => "superhero/spinner.svg",
        PullRequestCheckStatus::ActionRequired => "superhero/circle-dot.svg",
        PullRequestCheckStatus::Success => "superhero/check-circle.svg",
        PullRequestCheckStatus::Failure => "superhero/clear-circle.svg",
        PullRequestCheckStatus::Cancelled => "superhero/check-cancelled.svg",
        PullRequestCheckStatus::Skipped => "superhero/blocked.svg",
        PullRequestCheckStatus::Neutral => "superhero/circle-dashed.svg",
    }
}

#[must_use]
pub(super) fn check_status_color(tokens: &Tokens, status: PullRequestCheckStatus) -> Rgba {
    match status {
        PullRequestCheckStatus::Pending | PullRequestCheckStatus::ActionRequired => tokens.warning,
        PullRequestCheckStatus::Success => tokens.success,
        PullRequestCheckStatus::Failure => tokens.destructive,
        PullRequestCheckStatus::Cancelled
        | PullRequestCheckStatus::Skipped
        | PullRequestCheckStatus::Neutral => tokens.muted_foreground.with_alpha(0.7),
    }
}

#[must_use]
pub(super) fn summarize_checks(checks: &[PullRequestCheck]) -> String {
    if checks.is_empty() {
        return "No checks reported".to_owned();
    }
    let total = checks.len();
    let action_required: Vec<&PullRequestCheck> = checks
        .iter()
        .filter(|c| c.status == PullRequestCheckStatus::ActionRequired)
        .collect();
    let workflow_approval = action_required
        .iter()
        .filter(|c| is_workflow_approval_check(c))
        .count();
    let other_action = action_required.len() - workflow_approval;
    let failed = checks
        .iter()
        .filter(|c| {
            matches!(
                c.status,
                PullRequestCheckStatus::Failure | PullRequestCheckStatus::Cancelled
            )
        })
        .count();
    let pending = checks
        .iter()
        .filter(|c| c.status == PullRequestCheckStatus::Pending)
        .count();
    let passed = checks
        .iter()
        .filter(|c| c.status == PullRequestCheckStatus::Success)
        .count();

    if failed > 0 {
        return format!("{failed} of {total} checks failing");
    }
    if workflow_approval > 0 && other_action > 0 {
        let wf = if workflow_approval == 1 {
            "workflow"
        } else {
            "workflows"
        };
        let ck = if other_action == 1 { "check" } else { "checks" };
        return format!("{workflow_approval} {wf} and {other_action} {ck} awaiting action");
    }
    if workflow_approval > 0 {
        let noun = if workflow_approval == 1 {
            "workflow"
        } else {
            "workflows"
        };
        return format!("{workflow_approval} {noun} awaiting approval");
    }
    if other_action > 0 {
        let noun = if other_action == 1 { "check" } else { "checks" };
        return format!("{other_action} {noun} awaiting action");
    }
    if pending > 0 {
        return format!("{pending} of {total} checks running");
    }
    if passed == total {
        "All checks passed".to_owned()
    } else {
        format!("{passed} of {total} checks passing")
    }
}

/// Normalized review verdict (`pullRequestReviewOutcome`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReviewOutcome {
    Approved,
    ChangesRequested,
    Dismissed,
}

#[must_use]
pub(super) fn review_outcome(review_state: Option<&str>) -> Option<ReviewOutcome> {
    let normalized = review_state?.trim().to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "approved" => Some(ReviewOutcome::Approved),
        "changes-requested" => Some(ReviewOutcome::ChangesRequested),
        "dismissed" => Some(ReviewOutcome::Dismissed),
        _ => None,
    }
}

#[must_use]
pub(super) const fn review_outcome_label(outcome: ReviewOutcome) -> &'static str {
    match outcome {
        ReviewOutcome::Approved => "Approved",
        ReviewOutcome::ChangesRequested => "Changes requested",
        ReviewOutcome::Dismissed => "Review dismissed",
    }
}

#[must_use]
pub(super) fn review_outcome_color(tokens: &Tokens, outcome: ReviewOutcome) -> Rgba {
    match outcome {
        ReviewOutcome::Approved => tokens.success,
        ReviewOutcome::ChangesRequested => tokens.destructive,
        ReviewOutcome::Dismissed => tokens.muted_foreground.with_alpha(0.7),
    }
}

#[must_use]
pub(super) fn newest_commit_at(commits: &[PullRequestCommit]) -> Option<&str> {
    commits
        .iter()
        .filter_map(|c| parse_date_ms(&c.committed_date).map(|ms| (ms, c.committed_date.as_str())))
        .max_by_key(|(ms, _)| *ms)
        .map(|(_, iso)| iso)
}

#[must_use]
pub(super) fn is_verdict_stale(at: &str, newest_commit: Option<&str>) -> bool {
    let Some(commit_iso) = newest_commit else {
        return false;
    };
    match (parse_date_ms(at), parse_date_ms(commit_iso)) {
        (Some(verdict_ms), Some(commit_ms)) => verdict_ms < commit_ms,
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ReviewOutcomeEntry {
    pub(super) key: String,
    pub(super) actor: Option<PullRequestActor>,
    pub(super) outcome: ReviewOutcome,
    pub(super) at: String,
    pub(super) stale: bool,
}

/// Deduplicated latest non-dismissed review outcome per reviewer (`latestPullRequestReviewOutcomes`).
#[must_use]
pub(super) fn latest_review_outcomes(
    comments: &[PullRequestComment],
    commits: &[PullRequestCommit],
) -> Vec<ReviewOutcomeEntry> {
    let newest = newest_commit_at(commits);
    let mut latest: BTreeMap<String, ReviewOutcomeEntry> = BTreeMap::new();
    for comment in comments {
        let Some(outcome) = review_outcome(comment.review_state.as_deref()) else {
            continue;
        };
        let key = comment
            .author
            .as_ref()
            .map(|a| a.login.to_ascii_lowercase())
            .unwrap_or_else(|| format!("ghost:{}", comment.id));
        if let Some(current) = latest.get(&key)
            && parse_date_ms(&current.at).unwrap_or(i64::MIN)
                > parse_date_ms(&comment.created_at).unwrap_or(i64::MIN)
        {
            continue;
        }
        latest.insert(
            key.clone(),
            ReviewOutcomeEntry {
                key,
                actor: comment.author.clone(),
                outcome,
                at: comment.created_at.clone(),
                stale: is_verdict_stale(&comment.created_at, newest),
            },
        );
    }
    latest
        .into_values()
        .filter(|entry| entry.outcome != ReviewOutcome::Dismissed)
        .collect()
}

/// Reviewer row entry combining requested reviewers and submitted verdicts (`PullRequestPeopleRows`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ReviewerEntry {
    pub(super) key: String,
    pub(super) actor: Option<PullRequestActor>,
    pub(super) outcome: Option<ReviewOutcome>,
    pub(super) stale: bool,
}

#[must_use]
pub(super) fn build_reviewer_entries(
    reviewers: &[PullRequestActor],
    comments: &[PullRequestComment],
    commits: &[PullRequestCommit],
) -> Vec<ReviewerEntry> {
    let outcomes = latest_review_outcomes(comments, commits);
    let outcome_by_login: HashMap<String, &ReviewOutcomeEntry> = outcomes
        .iter()
        .filter_map(|entry| {
            entry
                .actor
                .as_ref()
                .map(|a| (a.login.to_ascii_lowercase(), entry))
        })
        .collect();

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for actor in reviewers {
        let lower = actor.login.to_ascii_lowercase();
        seen.insert(lower.clone());
        let matched = outcome_by_login.get(&lower);
        out.push(ReviewerEntry {
            key: actor.login.clone(),
            actor: Some(actor.clone()),
            outcome: matched.map(|e| e.outcome),
            stale: matched.is_some_and(|e| e.stale),
        });
    }
    for entry in &outcomes {
        let lower = entry
            .actor
            .as_ref()
            .map(|a| a.login.to_ascii_lowercase())
            .unwrap_or_else(|| entry.key.clone());
        if seen.insert(lower) {
            out.push(ReviewerEntry {
                key: entry.key.clone(),
                actor: entry.actor.clone(),
                outcome: Some(entry.outcome),
                stale: entry.stale,
            });
        }
    }
    out
}

/// Strips HTML comments (`<!-- ... -->`) when checking if a body has visible text (`visibleBody`).
#[must_use]
pub(super) fn visible_body(raw: &str) -> Option<String> {
    let mut stripped = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<!--") {
        stripped.push_str(&rest[..start]);
        if let Some(end) = rest[start + 4..].find("-->") {
            rest = &rest[start + 4 + end + 3..];
        } else {
            rest = "";
            break;
        }
    }
    stripped.push_str(rest);
    if stripped.trim().is_empty() {
        None
    } else {
        Some(raw.trim().to_owned())
    }
}

/// Timeline event kinds matching `PullRequestTimelineEvent`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TimelineEventKind {
    Opened,
    Commit,
    Comment,
    Review,
    Merged,
    Closed,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct TimelineThread {
    pub(super) id: String,
    pub(super) path: Option<String>,
    pub(super) line: Option<i64>,
    pub(super) is_resolved: bool,
    pub(super) is_outdated: bool,
    pub(super) can_resolve: bool,
    pub(super) replies: Vec<TimelineEvent>,
    pub(super) more_replies: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct TimelineEvent {
    pub(super) id: String,
    pub(super) at: String,
    pub(super) kind: TimelineEventKind,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) markdown: bool,
    pub(super) url: Option<String>,
    pub(super) actor: Option<PullRequestActor>,
    pub(super) additions: Option<i64>,
    pub(super) deletions: Option<i64>,
    pub(super) path: Option<String>,
    pub(super) review_state: Option<String>,
    pub(super) is_comment_event: bool,
    pub(super) thread: Option<TimelineThread>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum TimelineRow {
    Event(TimelineEvent),
    Comments(Vec<TimelineEvent>),
}

fn comment_to_event(comment: &PullRequestComment) -> TimelineEvent {
    let is_review = comment.kind == PullRequestCommentKind::Review;
    TimelineEvent {
        id: comment.id.clone(),
        at: comment.created_at.clone(),
        kind: if is_review {
            TimelineEventKind::Review
        } else {
            TimelineEventKind::Comment
        },
        title: if is_review {
            "reviewed".to_owned()
        } else {
            "commented".to_owned()
        },
        body: visible_body(&comment.body),
        markdown: true,
        url: comment.url.clone(),
        actor: comment.author.clone(),
        additions: None,
        deletions: None,
        path: comment.path.clone(),
        review_state: comment.review_state.clone(),
        is_comment_event: true,
        thread: None,
    }
}

/// Builds the full PR timeline sorted newest-first (`buildPullRequestTimeline`).
#[must_use]
pub(super) fn build_timeline(
    detail: &PullRequestDetail,
    comments: &[PullRequestComment],
    review_threads: &[PullRequestReviewThread],
    commits: &[PullRequestCommit],
) -> Vec<TimelineEvent> {
    let mut events = Vec::new();

    events.push(TimelineEvent {
        id: "created".to_owned(),
        at: detail.created_at.clone(),
        kind: TimelineEventKind::Opened,
        title: "opened this pull request".to_owned(),
        body: None,
        markdown: false,
        url: None,
        actor: detail.author.clone(),
        additions: None,
        deletions: None,
        path: None,
        review_state: None,
        is_comment_event: false,
        thread: None,
    });

    for commit in commits {
        let short = commit.oid.get(..7).unwrap_or(&commit.oid);
        events.push(TimelineEvent {
            id: commit.oid.clone(),
            at: commit.committed_date.clone(),
            kind: TimelineEventKind::Commit,
            title: format!("Commit {short}"),
            body: if commit.message_headline.is_empty() {
                None
            } else {
                Some(commit.message_headline.clone())
            },
            markdown: false,
            url: None,
            actor: commit.authors.as_ref().and_then(|a| a.first().cloned()),
            additions: commit.additions,
            deletions: commit.deletions,
            path: None,
            review_state: None,
            is_comment_event: false,
            thread: None,
        });
    }

    let by_id: HashMap<&str, &PullRequestComment> =
        comments.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut claimed: HashSet<String> = HashSet::new();

    for thread in review_threads {
        let mut ordered: Vec<PullRequestComment> = thread
            .comments
            .iter()
            .map(|c| {
                if let Some(existing) = by_id.get(c.id.as_str()) {
                    (*existing).clone()
                } else {
                    PullRequestComment {
                        id: c.id.clone(),
                        kind: PullRequestCommentKind::ReviewComment,
                        author: c.author.clone(),
                        body: c.body.clone(),
                        created_at: c.created_at.clone(),
                        edited_at: c.edited_at.clone(),
                        url: c.url.clone(),
                        path: Some(thread.path.clone()),
                        review_state: None,
                        reactions: c.reactions.clone(),
                        can_edit: c.can_edit,
                    }
                }
            })
            .collect();
        ordered.sort_by_key(|c| parse_date_ms(&c.created_at).unwrap_or(0));
        let Some(root) = ordered.first().cloned() else {
            continue;
        };
        for c in &ordered {
            claimed.insert(c.id.clone());
        }
        let replies: Vec<TimelineEvent> = ordered[1..].iter().map(comment_to_event).collect();
        let total = thread
            .comment_count
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(ordered.len());
        let more_replies = total.saturating_sub(ordered.len());

        let mut root_event = comment_to_event(&root);
        root_event.thread = Some(TimelineThread {
            id: thread.id.clone(),
            path: Some(thread.path.clone()),
            line: thread.line,
            is_resolved: thread.is_resolved,
            is_outdated: thread.is_outdated,
            can_resolve: thread.can_resolve.unwrap_or(false),
            replies,
            more_replies,
        });
        events.push(root_event);
    }

    for comment in comments {
        if !claimed.contains(&comment.id) {
            events.push(comment_to_event(comment));
        }
    }

    if let Some(merged_at) = &detail.merged_at {
        events.push(TimelineEvent {
            id: "merged".to_owned(),
            at: merged_at.clone(),
            kind: TimelineEventKind::Merged,
            title: "merged this pull request".to_owned(),
            body: None,
            markdown: false,
            url: None,
            actor: None,
            additions: None,
            deletions: None,
            path: None,
            review_state: None,
            is_comment_event: false,
            thread: None,
        });
    } else if let Some(closed_at) = &detail.closed_at {
        events.push(TimelineEvent {
            id: "closed".to_owned(),
            at: closed_at.clone(),
            kind: TimelineEventKind::Closed,
            title: "closed this pull request".to_owned(),
            body: None,
            markdown: false,
            url: None,
            actor: None,
            additions: None,
            deletions: None,
            path: None,
            review_state: None,
            is_comment_event: false,
            thread: None,
        });
    }

    events.sort_by(|left, right| {
        let r = parse_date_ms(&right.at).unwrap_or(0);
        let l = parse_date_ms(&left.at).unwrap_or(0);
        r.cmp(&l)
    });
    events
}

/// Applies the comment filter (`filterPullRequestTimelineEvents`): commits and lifecycle events
/// always stay; bot chatter and resolved/dismissed conversations hide unless enabled.
#[must_use]
pub(super) fn filter_timeline_events(
    events: &[TimelineEvent],
    filter: CommentFilter,
) -> Vec<TimelineEvent> {
    if filter.bots && filter.resolved {
        return events.to_vec();
    }
    events
        .iter()
        .filter(|event| {
            if !event.is_comment_event {
                return true;
            }
            let finished = event.thread.as_ref().is_some_and(|t| t.is_resolved)
                || review_outcome(event.review_state.as_deref()) == Some(ReviewOutcome::Dismissed);
            if !filter.resolved && finished {
                return false;
            }
            if filter.bots {
                return true;
            }
            let is_keep = |ev: &TimelineEvent| {
                let is_bot = ev.actor.as_ref().is_some_and(|a| a.is_bot == Some(true));
                let is_verdict = matches!(
                    review_outcome(ev.review_state.as_deref()),
                    Some(ReviewOutcome::Approved | ReviewOutcome::ChangesRequested)
                );
                !is_bot || is_verdict
            };
            is_keep(event)
                || event
                    .thread
                    .as_ref()
                    .is_some_and(|t| t.replies.iter().any(is_keep))
        })
        .cloned()
        .collect()
}

/// Groups consecutive general comments into collapsible `Comments` rows
/// (`groupPullRequestTimelineConversations`).
#[must_use]
pub(super) fn group_timeline_rows(events: Vec<TimelineEvent>) -> Vec<TimelineRow> {
    let mut rows: Vec<TimelineRow> = Vec::new();
    for event in events {
        let is_general_comment = matches!(
            event.kind,
            TimelineEventKind::Comment | TimelineEventKind::Review
        ) && event.thread.is_none()
            && review_outcome(event.review_state.as_deref()).is_none();
        if is_general_comment {
            if let Some(TimelineRow::Comments(group)) = rows.last_mut() {
                group.push(event);
            } else {
                rows.push(TimelineRow::Comments(vec![event]));
            }
        } else {
            rows.push(TimelineRow::Event(event));
        }
    }
    rows
}

/// Relative timestamp label (`"just now"`, `"5m ago"`, `"2h ago"`, `"3d ago"`).
#[must_use]
pub(super) fn format_relative_time(iso: &str, now_ms: i64) -> String {
    let Some(at_ms) = parse_date_ms(iso) else {
        return String::new();
    };
    let elapsed_secs = ((now_ms - at_ms).max(0)) / 1_000;
    if elapsed_secs < 60 {
        return "just now".to_owned();
    }
    let minutes = elapsed_secs / 60;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

/// Current wall-clock Unix epoch in milliseconds.
#[must_use]
pub(super) fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Formats an integer with comma thousands separators (`1234` -> `"1,234"`).
#[must_use]
pub(super) fn format_grouped_count(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + usize::from(negative));
    if negative {
        out.push('-');
    }
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (digits.len() - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Formats a host label such as `"Open on GitHub"`, `"Open on GitLab"`, etc.
#[must_use]
pub(super) fn open_on_host_label(provider: &str) -> &'static str {
    match provider.to_ascii_lowercase().as_str() {
        "github" => "Open on GitHub",
        "gitlab" => "Open on GitLab",
        "bitbucket" => "Open on Bitbucket",
        "azure-devops" | "azure" => "Open on Azure DevOps",
        "forgejo" | "gitea" => "Open on Forgejo",
        "gitcafe" => "Open on GitCafe",
        "cursor-origin" | "origin" => "Open on Origin",
        _ => "Open on host",
    }
}

/// Checkout CLI command for copying (`pullRequestCheckoutCommand`).
#[must_use]
pub(super) fn checkout_command(provider: &str, number: i64, head_branch: &str) -> Option<String> {
    match provider.to_ascii_lowercase().as_str() {
        "github" => Some(format!("gh pr checkout {number}")),
        "gitlab" => Some(format!("glab mr checkout {number}")),
        "forgejo" | "gitea" => Some(format!("tea pulls checkout {number}")),
        "cursor-origin" | "origin" => Some(format!("origin pr checkout {number}")),
        _ if !head_branch.is_empty() => {
            Some(format!("git fetch origin && git checkout {head_branch}"))
        }
        _ => None,
    }
}

/// Derives background and text colors for a host-supplied label hex color (`badge.tsx`: `variant="label"`),
/// blending it against the active theme's foreground and card surface.
#[must_use]
pub(super) fn label_chip_colors(tokens: &Tokens, raw_color: Option<&str>) -> (Rgba, Rgba) {
    let Some(raw) = raw_color.map(str::trim).filter(|s| !s.is_empty()) else {
        return (tokens.secondary, tokens.secondary_foreground);
    };
    let normalized = if raw.starts_with('#') {
        raw.to_owned()
    } else {
        format!("#{raw}")
    };
    let Ok(base) = parse_color(&normalized) else {
        return (tokens.secondary, tokens.secondary_foreground);
    };
    let is_dark = tokens.appearance == Appearance::Dark;
    let bg = base.with_alpha(if is_dark { 0.14 } else { 0.10 });
    let fg = color_mix_srgb(base, if is_dark { 0.45 } else { 0.30 }, tokens.foreground);
    (bg, fg)
}

/// Extracts a concise human-readable error message from a `conn_client::ClientError`.
#[must_use]
pub(super) fn describe_rpc_error(err: &conn_client::ClientError) -> (Option<String>, String) {
    match err {
        conn_client::ClientError::Rpc(val) => {
            let tag = val.get("_tag").and_then(serde_json::Value::as_str);
            let reason = val.get("reason").and_then(serde_json::Value::as_str);
            if tag == Some("PullRequestOperationError") && reason == Some("not-found") {
                return (
                    Some("not-found".to_owned()),
                    "Pull request not found.".to_owned(),
                );
            }
            if tag == Some("PullRequestUnavailableError") {
                let msg = match reason {
                    Some("cli-missing") => {
                        "The source-control CLI is not installed on this server."
                    }
                    Some("cli-unauthenticated") => {
                        "Sign in to your source-control host to view pull requests."
                    }
                    Some("provider-unsupported") => {
                        "This repository's host does not support pull requests here yet."
                    }
                    _ => "Pull requests are unavailable in this environment.",
                };
                return (Some("unavailable".to_owned()), msg.to_owned());
            }
            let detail = val
                .get("detail")
                .or_else(|| val.get("message"))
                .or_else(|| val.get("reason"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| err.to_string());
            (tag.map(ToOwned::to_owned), detail)
        }
        other => (None, other.to_string()),
    }
}

/// Computes a unified [`DiffFile`] with 3 lines of context from old and new file contents
/// returned by `pullRequests.diffFileContents`.
#[must_use]
pub(super) fn build_unified_diff_from_contents(
    old_path: &str,
    new_path: &str,
    old_contents: &str,
    new_contents: &str,
) -> DiffFile {
    let old_lines: Vec<&str> = if old_contents.is_empty() {
        Vec::new()
    } else {
        old_contents.lines().collect()
    };
    let new_lines: Vec<&str> = if new_contents.is_empty() {
        Vec::new()
    } else {
        new_contents.lines().collect()
    };

    let edits = compute_line_diff(&old_lines, &new_lines);
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for edit in &edits {
        match edit.kind {
            DiffLineKind::Added => additions += 1,
            DiffLineKind::Removed => deletions += 1,
            DiffLineKind::Context => {}
        }
    }

    let hunks = group_diff_hunks(&edits, 3);
    let display_path = if !old_path.is_empty() && !new_path.is_empty() && old_path != new_path {
        format!("{old_path} -> {new_path}")
    } else if !new_path.is_empty() {
        new_path.to_owned()
    } else {
        old_path.to_owned()
    };

    DiffFile {
        old_path: (!old_path.is_empty()).then(|| old_path.to_owned()),
        new_path: (!new_path.is_empty()).then(|| new_path.to_owned()),
        display_path,
        additions,
        deletions,
        is_binary: false,
        hunks,
    }
}

/// Computes a line-by-line edit script using LCS for reasonable file sizes, falling back to a
/// prefix/suffix trim diff for very large files so the UI never stalls.
fn compute_line_diff(old: &[&str], new: &[&str]) -> Vec<DiffLine> {
    // Strip common prefix and suffix first to keep the DP table tiny.
    let prefix = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let old_rem = &old[prefix..];
    let new_rem = &new[prefix..];
    let suffix = old_rem
        .iter()
        .rev()
        .zip(new_rem.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();

    let old_mid = &old_rem[..old_rem.len() - suffix];
    let new_mid = &new_rem[..new_rem.len() - suffix];

    let mut out = Vec::with_capacity(old.len() + new.len());
    for (idx, line) in old[..prefix].iter().enumerate() {
        let n = u32::try_from(idx + 1).unwrap_or(u32::MAX);
        out.push(DiffLine {
            kind: DiffLineKind::Context,
            old_line: Some(n),
            new_line: Some(n),
            text: (*line).to_owned(),
        });
    }

    let old_base = prefix;
    let new_base = prefix;
    // Cap DP matrix cells at 2_000_000 (~8 MB) so huge generated files remain instant.
    if old_mid.len().saturating_mul(new_mid.len()) <= 2_000_000 {
        let rows = old_mid.len() + 1;
        let cols = new_mid.len() + 1;
        let mut dp = vec![0u32; rows * cols];
        for i in (0..old_mid.len()).rev() {
            for j in (0..new_mid.len()).rev() {
                dp[i * cols + j] = if old_mid[i] == new_mid[j] {
                    dp[(i + 1) * cols + (j + 1)] + 1
                } else {
                    dp[(i + 1) * cols + j].max(dp[i * cols + (j + 1)])
                };
            }
        }
        let mut i = 0;
        let mut j = 0;
        while i < old_mid.len() || j < new_mid.len() {
            if i < old_mid.len() && j < new_mid.len() && old_mid[i] == new_mid[j] {
                out.push(DiffLine {
                    kind: DiffLineKind::Context,
                    old_line: Some(u32::try_from(old_base + i + 1).unwrap_or(u32::MAX)),
                    new_line: Some(u32::try_from(new_base + j + 1).unwrap_or(u32::MAX)),
                    text: old_mid[i].to_owned(),
                });
                i += 1;
                j += 1;
            } else if i < old_mid.len()
                && (j == new_mid.len() || dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)])
            {
                out.push(DiffLine {
                    kind: DiffLineKind::Removed,
                    old_line: Some(u32::try_from(old_base + i + 1).unwrap_or(u32::MAX)),
                    new_line: None,
                    text: old_mid[i].to_owned(),
                });
                i += 1;
            } else if j < new_mid.len() {
                out.push(DiffLine {
                    kind: DiffLineKind::Added,
                    old_line: None,
                    new_line: Some(u32::try_from(new_base + j + 1).unwrap_or(u32::MAX)),
                    text: new_mid[j].to_owned(),
                });
                j += 1;
            }
        }
    } else {
        for (i, line) in old_mid.iter().enumerate() {
            out.push(DiffLine {
                kind: DiffLineKind::Removed,
                old_line: Some(u32::try_from(old_base + i + 1).unwrap_or(u32::MAX)),
                new_line: None,
                text: (*line).to_owned(),
            });
        }
        for (j, line) in new_mid.iter().enumerate() {
            out.push(DiffLine {
                kind: DiffLineKind::Added,
                old_line: None,
                new_line: Some(u32::try_from(new_base + j + 1).unwrap_or(u32::MAX)),
                text: (*line).to_owned(),
            });
        }
    }

    let old_tail_start = old.len() - suffix;
    let new_tail_start = new.len() - suffix;
    for k in 0..suffix {
        out.push(DiffLine {
            kind: DiffLineKind::Context,
            old_line: Some(u32::try_from(old_tail_start + k + 1).unwrap_or(u32::MAX)),
            new_line: Some(u32::try_from(new_tail_start + k + 1).unwrap_or(u32::MAX)),
            text: old[old_tail_start + k].to_owned(),
        });
    }

    out
}

fn group_diff_hunks(lines: &[DiffLine], context: usize) -> Vec<DiffHunk> {
    let changed_indices: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(idx, line)| (line.kind != DiffLineKind::Context).then_some(idx))
        .collect();
    if changed_indices.is_empty() {
        return Vec::new();
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for idx in changed_indices {
        let start = idx.saturating_sub(context);
        let end = (idx + context + 1).min(lines.len());
        if let Some(last) = ranges.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
        } else {
            ranges.push((start, end));
        }
    }

    ranges
        .into_iter()
        .map(|(start, end)| {
            let slice = lines[start..end].to_vec();
            let old_start = slice.iter().find_map(|l| l.old_line).unwrap_or(0);
            let new_start = slice.iter().find_map(|l| l.new_line).unwrap_or(0);
            let old_count = u32::try_from(
                slice
                    .iter()
                    .filter(|l| l.kind != DiffLineKind::Added)
                    .count(),
            )
            .unwrap_or(0);
            let new_count = u32::try_from(
                slice
                    .iter()
                    .filter(|l| l.kind != DiffLineKind::Removed)
                    .count(),
            )
            .unwrap_or(0);
            DiffHunk {
                header: format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@"),
                old_start,
                old_count,
                new_start,
                new_count,
                lines: slice,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use conn_contract::{
        PullRequestCapabilities, PullRequestMergeCapabilities, PullRequestReviewCapabilities,
        PullRequestReviewerCapabilities, PullRequestViewerPermissions, ThreadPullRequestSnapshot,
    };

    use super::*;

    fn sample_detail() -> PullRequestDetail {
        PullRequestDetail {
            provider: "github".to_owned(),
            capabilities: PullRequestCapabilities {
                diff: true,
                comment: true,
                actions: vec![
                    Some(PullRequestAction::Merge),
                    Some(PullRequestAction::Ready),
                    Some(PullRequestAction::Draft),
                    Some(PullRequestAction::Close),
                    Some(PullRequestAction::EnableAutoMerge),
                    Some(PullRequestAction::DisableAutoMerge),
                ],
                merge_methods: vec![
                    Some(PullRequestDetailAutoMergeMethod::Squash),
                    Some(PullRequestDetailAutoMergeMethod::Merge),
                ],
                delete_branch: Some(true),
                update_methods: Some(vec![Some(PullRequestActionInputUpdateMethod::Merge)]),
                search: true,
                reactions: Some(true),
                viewed_files: None,
                review: PullRequestReviewCapabilities {
                    inline_comment: true,
                    range_comment: Some(true),
                    reply: true,
                    resolve: true,
                    verdicts: vec![],
                },
                reviewers: PullRequestReviewerCapabilities {
                    request: true,
                    list_candidates: true,
                    search_candidates: Some(true),
                },
                edit: None,
                stacks: None,
                stack_actions: None,
                labels: Some(true),
                mentions: Some(true),
                reference_sigils: None,
                checks_always_report: None,
            },
            viewer_permissions: PullRequestViewerPermissions {
                stack_rebase: None,
                actions: vec![
                    Some(PullRequestAction::Merge),
                    Some(PullRequestAction::Ready),
                    Some(PullRequestAction::Draft),
                    Some(PullRequestAction::Close),
                    Some(PullRequestAction::EnableAutoMerge),
                ],
                comment: true,
                resolve: true,
                verdicts: vec![],
                request_reviewers: true,
                update_methods: Some(vec![Some(PullRequestActionInputUpdateMethod::Merge)]),
                labels: Some(true),
                edit_change_request: Some(true),
                maintainer_edits: None,
            },
            project_id: "proj-1".to_owned(),
            project_title: "conn-gpui".to_owned(),
            workspace_root: "/tmp/repo".to_owned(),
            repository: "nckrtl/conn-gpui".to_owned(),
            number: 42,
            title: "Add pull request surface".to_owned(),
            body: "Implements the PR surface.".to_owned(),
            url: "https://github.com/nckrtl/conn-gpui/pull/42".to_owned(),
            author: Some(PullRequestActor {
                is_bot: Some(false),
                login: "nckrtl".to_owned(),
                name: Some("Nick".to_owned()),
                avatar_url: None,
            }),
            state: PullRequestState::Open,
            is_draft: false,
            mergeability: PullRequestMergeability::Mergeable,
            additions: 120,
            deletions: 15,
            changed_files: 4,
            head_branch: "feat/pr-panel".to_owned(),
            head_repository_name_with_owner: None,
            head_sha: Some("abcdef1234567".to_owned()),
            base_branch: "main".to_owned(),
            created_at: "2026-11-20T10:00:00Z".to_owned(),
            updated_at: "2026-11-21T09:00:00Z".to_owned(),
            observed_at: None,
            merged_at: None,
            closed_at: None,
            reviewers: vec![],
            labels: vec![],
            checks: vec![],
            merge_capabilities: PullRequestMergeCapabilities {
                merge: true,
                squash: true,
                rebase: false,
                fast_forward: None,
            },
            viewer: Some("nckrtl".to_owned()),
            base_comparison: None,
            behind_by: None,
            auto_merge_enabled: None,
            auto_merge_method: None,
            workflow_approvals_required: None,
            merge_queue_removal: None,
            maintainer_can_modify: None,
        }
    }

    #[test]
    fn parses_github_and_gitlab_pr_urls() {
        let gh = parse_pull_request_url("https://github.com/nckrtl/conn-gpui/pull/42")
            .expect("github url parses");
        assert_eq!(gh.host, "github.com");
        assert_eq!(gh.repository, "nckrtl/conn-gpui");
        assert_eq!(gh.number, 42);
        assert_eq!(gh.repository_url, "https://github.com/nckrtl/conn-gpui");

        let gl = parse_pull_request_url("https://gitlab.com/org/sub/repo/-/merge_requests/19")
            .expect("gitlab url parses");
        assert_eq!(gl.host, "gitlab.com");
        assert_eq!(gl.repository, "org/sub/repo");
        assert_eq!(gl.number, 19);
    }

    #[test]
    fn selects_open_non_dismissed_thread_pr_link() {
        let make_link = |number: i64,
                         source: ThreadPullRequestLinkSource,
                         state: PullRequestState,
                         linked_at: &str| ThreadPullRequestLink {
            host: "github.com".to_owned(),
            repository: "nckrtl/conn".to_owned(),
            number,
            url: format!("https://github.com/nckrtl/conn/pull/{number}"),
            repository_web_url: None,
            source,
            linked_at: linked_at.to_owned(),
            snapshot: Some(ThreadPullRequestSnapshot {
                state,
                title: format!("PR #{number}"),
                head_branch: "feat".to_owned(),
                base_branch: "main".to_owned(),
                is_draft: false,
                updated_at: None,
                synced_at: linked_at.to_owned(),
                closed_at: None,
                merged_at: None,
                author: None,
                additions: None,
                deletions: None,
                changed_files: None,
                review_decision: None,
                checks_state: None,
                mergeability: None,
            }),
            stack: None,
            watch: None,
            ended_watch: None,
        };

        let links = vec![
            make_link(
                10,
                ThreadPullRequestLinkSource::Created,
                PullRequestState::Merged,
                "2026-11-21T10:00:00Z",
            ),
            make_link(
                11,
                ThreadPullRequestLinkSource::Manual,
                PullRequestState::Open,
                "2026-11-20T10:00:00Z",
            ),
            make_link(
                12,
                ThreadPullRequestLinkSource::StackDismissed,
                PullRequestState::Open,
                "2026-11-21T12:00:00Z",
            ),
        ];
        let picked = select_current_thread_pr_link(&links).expect("should select open link");
        assert_eq!(picked.number, 11);
    }

    #[test]
    fn resolves_primary_control_for_each_pr_state() {
        let mut detail = sample_detail();
        assert_eq!(
            resolve_primary_control(&detail, Some(ChecksState::Passing)),
            PrimaryControl::Merge
        );

        detail.auto_merge_enabled = Some(false);
        assert_eq!(
            resolve_primary_control(&detail, Some(ChecksState::Pending)),
            PrimaryControl::EnableAutoMerge
        );

        detail.auto_merge_enabled = Some(true);
        assert_eq!(
            resolve_primary_control(&detail, Some(ChecksState::Pending)),
            PrimaryControl::AutoMergeArmed
        );

        detail.auto_merge_enabled = None;
        detail.is_draft = true;
        assert_eq!(
            resolve_primary_control(&detail, None),
            PrimaryControl::Ready
        );

        detail.is_draft = false;
        detail.mergeability = PullRequestMergeability::Conflicting;
        assert_eq!(
            resolve_primary_control(&detail, None),
            PrimaryControl::Resolve
        );

        detail.state = PullRequestState::Merged;
        assert_eq!(
            resolve_primary_control(&detail, None),
            PrimaryControl::Merged
        );
    }

    #[test]
    fn classifies_and_summarizes_checks() {
        let check =
            |name: &str, status: PullRequestCheckStatus, url: Option<&str>| PullRequestCheck {
                name: name.to_owned(),
                status,
                description: None,
                url: url.map(ToOwned::to_owned),
                required: None,
                placeholder: None,
            };

        assert_eq!(classify_checks(&[]), None);
        assert_eq!(summarize_checks(&[]), "No checks reported");

        let passing = vec![check("ci", PullRequestCheckStatus::Success, None)];
        assert_eq!(classify_checks(&passing), Some(ChecksState::Passing));
        assert_eq!(summarize_checks(&passing), "All checks passed");

        let failing = vec![
            check("ci", PullRequestCheckStatus::Success, None),
            check("lint", PullRequestCheckStatus::Failure, None),
        ];
        assert_eq!(classify_checks(&failing), Some(ChecksState::Failing));
        assert_eq!(summarize_checks(&failing), "1 of 2 checks failing");

        let workflow = vec![check(
            "deploy",
            PullRequestCheckStatus::ActionRequired,
            Some("https://github.com/a/b/actions/runs/98765"),
        )];
        assert_eq!(classify_checks(&workflow), Some(ChecksState::Pending));
        assert_eq!(summarize_checks(&workflow), "1 workflow awaiting approval");
        assert_eq!(check_status_label(&workflow[0]), "Awaiting approval");
    }

    #[test]
    fn strips_html_comments_in_visible_body_and_groups_timeline() {
        assert_eq!(visible_body("<!-- bot marker -->  \n "), None);
        assert_eq!(
            visible_body("<!-- marker -->Looks good!"),
            Some("<!-- marker -->Looks good!".to_owned())
        );

        let detail = sample_detail();
        let comments = vec![
            PullRequestComment {
                id: "c1".to_owned(),
                kind: PullRequestCommentKind::IssueComment,
                author: Some(PullRequestActor {
                    is_bot: Some(true),
                    login: "dependabot[bot]".to_owned(),
                    name: None,
                    avatar_url: None,
                }),
                body: "Bumped deps".to_owned(),
                created_at: "2026-11-20T11:00:00Z".to_owned(),
                edited_at: None,
                url: None,
                path: None,
                review_state: None,
                reactions: None,
                can_edit: None,
            },
            PullRequestComment {
                id: "c2".to_owned(),
                kind: PullRequestCommentKind::Review,
                author: Some(PullRequestActor {
                    is_bot: Some(false),
                    login: "alice".to_owned(),
                    name: None,
                    avatar_url: None,
                }),
                body: "LGTM".to_owned(),
                created_at: "2026-11-20T12:00:00Z".to_owned(),
                edited_at: None,
                url: None,
                path: None,
                review_state: Some("APPROVED".to_owned()),
                reactions: None,
                can_edit: None,
            },
        ];

        let all = build_timeline(&detail, &comments, &[], &[]);
        assert_eq!(all.len(), 3, "opened + 2 comments");
        let filtered = filter_timeline_events(&all, CommentFilter::default());
        assert_eq!(filtered.len(), 2, "bot chatter hidden, human verdict kept");
        let outcomes = latest_review_outcomes(&comments, &[]);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].outcome, ReviewOutcome::Approved);
    }

    #[test]
    fn builds_unified_diff_hunks_from_file_contents() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nb\nC\nd\ne\nf\ng\nh\ni\n";
        let diff = build_unified_diff_from_contents("src/lib.rs", "src/lib.rs", old, new);
        assert_eq!(diff.display_path, "src/lib.rs");
        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 1);
        assert!(!diff.hunks.is_empty());
    }

    #[test]
    fn formats_grouped_counts_and_relative_times() {
        assert_eq!(format_grouped_count(1234567), "1,234,567");
        assert_eq!(format_grouped_count(42), "42");
        let now = parse_date_ms("2026-11-21T12:00:00Z").unwrap_or(0);
        assert_eq!(
            format_relative_time("2026-11-21T11:59:30Z", now),
            "just now"
        );
        assert_eq!(format_relative_time("2026-11-21T11:45:00Z", now), "15m ago");
        assert_eq!(format_relative_time("2026-11-21T09:00:00Z", now), "3h ago");
        assert_eq!(format_relative_time("2026-11-18T12:00:00Z", now), "3d ago");
    }
}
