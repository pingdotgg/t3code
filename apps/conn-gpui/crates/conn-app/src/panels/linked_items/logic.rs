//! Pure domain, chain-resolution, parsing, and presentation logic for the Linked items surface.
//!
//! Mirrors Conn's `packages/shared/src/threadPullRequests.ts`,
//! `packages/source-control-core/src/shared/threadPullRequests.ts`,
//! `packages/client-runtime/src/pullRequestLinkInput.ts`,
//! `apps/web/src/components/pullRequest/pullRequestPresentation.tsx`,
//! `apps/web/src/components/pullRequest/pullRequestIcons.tsx`, and
//! `apps/web/src/components/issue/issuePresentation.tsx`.

use std::collections::{HashMap, HashSet};

use conn_contract::{
    IssueActor, OrchestrationProjectShell, PullRequestMergeability, PullRequestState,
    PullRequestSummaryChecksState, PullRequestSummaryReviewDecision, ThreadLinkedPullRequest,
    ThreadPullRequestLink, ThreadPullRequestLinkSource, ThreadPullRequestSnapshot,
};
use conn_desktop::orbit::insights::parse_date_ms;
use conn_theme::{Tokens, color_mix_srgb};
use gpui_kit::Hsla;
use serde::Deserialize;
use serde_json::Value;

use crate::panels::color::to_hsla;

/// Category of an issue's workflow state (`packages/contracts/src/issue.ts`: `IssueStateCategory`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum IssueStateCategory {
    Open,
    Closed,
}

/// Live state of an issue (`packages/contracts/src/issue.ts`: `IssueState`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueState {
    pub(super) category: IssueStateCategory,
    pub(super) name: String,
    #[serde(default)]
    pub(super) close_reason: Option<String>,
}

/// An issue linked to a thread (`packages/contracts/src/issue.ts`: `ThreadIssueLink`).
///
/// Defined locally because `conn-contract` does not generate issue RPCs yet; a server that
/// includes `thread.issues` deserializes directly into this shape.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadIssueLink {
    pub(super) tracker: String,
    pub(super) host: String,
    pub(super) scope: String,
    pub(super) key: String,
    pub(super) project_id: String,
    pub(super) url: String,
    pub(super) source: String,
    pub(super) linked_at: String,
    pub(super) display_key: String,
    pub(super) title: String,
}

/// Subset of Conn's `IssueDetail` needed to enrich a linked issue row (`ThreadDetailsIssueRows.tsx`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueDetailSummary {
    pub(super) title: String,
    pub(super) state: IssueState,
    #[serde(default)]
    pub(super) author: Option<IssueActor>,
    #[serde(default)]
    pub(super) comment_count: u64,
    #[serde(default)]
    pub(super) updated_at: Option<String>,
}

/// Subset of `ExecutionEnvironmentCapabilities` used by the Linked items panel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct ServerCapabilities {
    pub(super) pull_requests: bool,
    pub(super) thread_pull_request_linking: bool,
    pub(super) thread_pull_request_watch: bool,
    pub(super) issues: bool,
}

/// Repository identity extracted from a project shell so `#123` resolves against the project's
/// host and PR clicks find the best `project_id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProjectRepoInfo {
    pub(super) id: String,
    pub(super) workspace_root: String,
    pub(super) host: Option<String>,
    pub(super) repository: Option<String>,
    pub(super) web_url: Option<String>,
    pub(super) provider: Option<String>,
}

/// Linked pull requests and issues extracted from a thread snapshot or projection.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ThreadLinkedData {
    pub(super) project_id: Option<String>,
    pub(super) pull_requests: Vec<ThreadPullRequestLink>,
    pub(super) issues: Vec<ThreadIssueLink>,
}

/// Native host stack vs branch-derived stack (`ThreadPullRequestChain["kind"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ChainKind {
    Native,
    Derived,
}

/// A resolved pull-request stack chain (`ThreadPullRequestChain`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ThreadPullRequestChain {
    pub(super) kind: ChainKind,
    pub(super) layers: Vec<ThreadPullRequestLink>,
    pub(super) depths: Vec<usize>,
}

/// Stack badge metadata shown on the base row of a multi-PR chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StackSummary {
    pub(super) kind: ChainKind,
    pub(super) size: usize,
}

/// One display row produced by [`pull_request_list_lines`] (`PullRequestListLine`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct PullRequestListLine {
    pub(super) link: ThreadPullRequestLink,
    pub(super) depth: usize,
    pub(super) chain_key: String,
    pub(super) stack: Option<StackSummary>,
}

/// Theme-mapped semantic tone for state, check, and review glyphs (never hardcoded hex).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GlyphTone {
    Success,
    Warning,
    Destructive,
    Merged,
    Muted,
    DraftMuted,
    MutedSoft,
}

/// Resolved icon path, semantic tone, and accessible label for a glyph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct GlyphSpec {
    pub(super) icon_path: &'static str,
    pub(super) tone: GlyphTone,
    pub(super) label: &'static str,
}

/// Parsed pull request reference ready for `thread.pull-request.link`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedPullRequestRef {
    pub(crate) host: String,
    pub(crate) repository: String,
    pub(crate) number: i64,
    pub(crate) url: String,
}

/// Result of resolving the user's input in the Link pull request dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LinkInputResolution {
    Empty,
    Resolved(ParsedPullRequestRef),
    Error(String),
}

/// Maps a semantic [`GlyphTone`] to a GPUI [`Hsla`] strictly from `conn_theme::Tokens`.
#[must_use]
pub(super) fn resolve_tone_hsla(tokens: &Tokens, tone: GlyphTone) -> Hsla {
    match tone {
        GlyphTone::Success => to_hsla(tokens.success),
        GlyphTone::Warning => to_hsla(tokens.warning),
        GlyphTone::Destructive => to_hsla(tokens.destructive),
        // Matches `panels/tasks/board.rs`: merged violet derived from theme roles.
        GlyphTone::Merged => to_hsla(color_mix_srgb(
            tokens.info_foreground,
            0.52,
            tokens.destructive,
        )),
        GlyphTone::Muted => to_hsla(tokens.muted_foreground),
        GlyphTone::DraftMuted => to_hsla(tokens.muted_foreground.with_alpha(0.80)),
        GlyphTone::MutedSoft => to_hsla(tokens.muted_foreground.with_alpha(0.60)),
    }
}

/// Stable composite key for a linked issue (`threadIssueKeyOf`).
#[must_use]
pub(super) fn thread_issue_key(link: &ThreadIssueLink) -> String {
    format!(
        "{}\u{0000}{}\u{0000}{}\u{0000}{}",
        link.tracker,
        link.host.trim().to_ascii_lowercase(),
        link.scope.trim().to_ascii_lowercase(),
        link.key.trim()
    )
}

/// Stable composite key for a pull request link (`threadPullRequestKeyOf`).
#[must_use]
pub(super) fn pull_request_key(link: &ThreadPullRequestLink) -> String {
    format!(
        "{}/{}#{}",
        link.host.trim().to_ascii_lowercase(),
        link.repository.trim().to_ascii_lowercase(),
        link.number
    )
}

/// Filters out `stack-dismissed` tombstones (`visibleThreadPullRequests`).
#[must_use]
pub(crate) fn visible_thread_pull_requests(
    links: &[ThreadPullRequestLink],
) -> Vec<ThreadPullRequestLink> {
    links
        .iter()
        .filter(|link| link.source != ThreadPullRequestLinkSource::StackDismissed)
        .cloned()
        .collect()
}

/// Parses `capabilities` from a `server.getConfig` JSON response.
#[must_use]
pub(super) fn parse_server_capabilities(config_json: &Value) -> ServerCapabilities {
    let caps = config_json
        .get("environment")
        .and_then(|env| env.get("capabilities"));
    let flag = |name: &str| {
        caps.and_then(|c| c.get(name))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    ServerCapabilities {
        pull_requests: flag("pullRequests"),
        thread_pull_request_linking: flag("threadPullRequestLinking"),
        thread_pull_request_watch: flag("threadPullRequestWatch"),
        issues: flag("issues"),
    }
}

/// Extracts repository info from a project shell for link resolution and PR routing.
#[must_use]
pub(super) fn parse_project_repo_info(project: &OrchestrationProjectShell) -> ProjectRepoInfo {
    let identity = project
        .repository_identity
        .as_ref()
        .and_then(|inner| inner.as_ref());
    let (host, repository, web_url, provider) = match identity {
        Some(id) => {
            let mut split = id.canonical_key.splitn(2, '/');
            let host = split
                .next()
                .filter(|s| !s.is_empty())
                .map(str::to_ascii_lowercase);
            let repo_from_key = split.next().filter(|s| !s.is_empty()).map(str::to_owned);
            let repo = id
                .display_name
                .clone()
                .or_else(|| {
                    id.owner
                        .as_deref()
                        .zip(id.name.as_deref())
                        .map(|(o, n)| format!("{o}/{n}"))
                })
                .or(repo_from_key);
            (host, repo, id.web_url.clone(), id.provider.clone())
        }
        None => (None, None, None, None),
    };
    ProjectRepoInfo {
        id: project.id.clone(),
        workspace_root: project.workspace_root.clone(),
        host,
        repository,
        web_url,
        provider,
    }
}

/// Extracts linked pull requests (with legacy `linkedPullRequest` fallback) and linked issues
/// from a thread JSON object (either `projection.thread` or `shell.thread`).
#[must_use]
pub(super) fn parse_thread_linked_data(thread_json: &Value) -> ThreadLinkedData {
    let project_id = thread_json
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let pull_requests = if let Some(raw_links) = thread_json.get("pullRequests")
        && !raw_links.is_null()
    {
        serde_json::from_value::<Vec<ThreadPullRequestLink>>(raw_links.clone()).unwrap_or_default()
    } else if let Some(raw_legacy) = thread_json.get("linkedPullRequest")
        && !raw_legacy.is_null()
    {
        serde_json::from_value::<ThreadLinkedPullRequest>(raw_legacy.clone())
            .ok()
            .map(|legacy| vec![legacy_link_to_thread_pr(legacy)])
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let issues = thread_json
        .get("issues")
        .and_then(|v| serde_json::from_value::<Vec<ThreadIssueLink>>(v.clone()).ok())
        .unwrap_or_default();

    ThreadLinkedData {
        project_id,
        pull_requests,
        issues,
    }
}

/// Converts a legacy single `ThreadLinkedPullRequest` into a `ThreadPullRequestLink`
/// (`threadPullRequestsOf`).
fn legacy_link_to_thread_pr(linked: ThreadLinkedPullRequest) -> ThreadPullRequestLink {
    let host = url::Url::parse(&linked.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    ThreadPullRequestLink {
        host,
        repository: linked.repository.trim().to_ascii_lowercase(),
        number: linked.number,
        url: linked.url,
        repository_web_url: None,
        source: ThreadPullRequestLinkSource::Manual,
        linked_at: "1970-01-01T00:00:00.000Z".to_owned(),
        snapshot: None,
        stack: None,
        watch: None,
        ended_watch: None,
    }
}

fn latest_updated_ms(link: &ThreadPullRequestLink) -> i64 {
    let value = link
        .snapshot
        .as_ref()
        .and_then(|s| s.updated_at.as_deref())
        .unwrap_or(link.linked_at.as_str());
    parse_date_ms(value).unwrap_or(0)
}

/// Groups visible pull request links into native host stacks and branch-derived chains
/// (`resolveThreadPullRequestChains`).
#[must_use]
pub(super) fn resolve_thread_pull_request_chains(
    links: &[ThreadPullRequestLink],
) -> Vec<ThreadPullRequestChain> {
    let visible = visible_thread_pull_requests(links);
    let mut chains: Vec<ThreadPullRequestChain> = Vec::new();
    let mut placed: HashSet<String> = HashSet::new();

    // 1. Native stacks grouped by `host/repo#stack:<id>`, preserving first-seen group order.
    let mut native_order: Vec<String> = Vec::new();
    let mut native_stacks: HashMap<String, Vec<ThreadPullRequestLink>> = HashMap::new();
    for link in &visible {
        let Some(stack) = &link.stack else {
            continue;
        };
        let stack_key = format!(
            "{}/{}#stack:{}",
            link.host.trim().to_ascii_lowercase(),
            link.repository.trim().to_ascii_lowercase(),
            stack.id
        );
        if !native_stacks.contains_key(&stack_key) {
            native_order.push(stack_key.clone());
        }
        native_stacks
            .entry(stack_key)
            .or_default()
            .push(link.clone());
    }

    for stack_key in native_order {
        let Some(mut members) = native_stacks.remove(&stack_key) else {
            continue;
        };
        let member_numbers: HashSet<i64> = members.iter().map(|m| m.number).collect();
        let mut best_layers = members
            .first()
            .and_then(|m| m.stack.as_ref())
            .map(|s| s.layers.as_slice())
            .unwrap_or(&[]);
        let mut best_coverage = best_layers
            .iter()
            .filter(|layer| member_numbers.contains(&layer.number))
            .count();

        for member in members.iter().skip(1) {
            let Some(stack) = &member.stack else {
                continue;
            };
            let candidate = stack.layers.as_slice();
            let candidate_coverage = candidate
                .iter()
                .filter(|layer| member_numbers.contains(&layer.number))
                .count();
            if candidate_coverage > best_coverage
                || (candidate_coverage == best_coverage && candidate.len() > best_layers.len())
            {
                best_layers = candidate;
                best_coverage = candidate_coverage;
            }
        }

        let order: HashMap<i64, usize> = best_layers
            .iter()
            .enumerate()
            .map(|(idx, layer)| (layer.number, idx))
            .collect();
        let fallback_rank = best_layers.len();
        members.sort_by_key(|m| order.get(&m.number).copied().unwrap_or(fallback_rank));
        for member in &members {
            placed.insert(pull_request_key(member));
        }
        let depths: Vec<usize> = (0..members.len()).collect();
        chains.push(ThreadPullRequestChain {
            kind: ChainKind::Native,
            layers: members,
            depths,
        });
    }

    // 2. Remaining links chained by `base_branch` -> `head_branch` within the same host/repo.
    let remaining: Vec<ThreadPullRequestLink> = visible
        .into_iter()
        .filter(|link| !placed.contains(&pull_request_key(link)))
        .collect();

    let branch_key = |link: &ThreadPullRequestLink, branch: &str| {
        format!(
            "{}/{}:{branch}",
            link.host.trim().to_ascii_lowercase(),
            link.repository.trim().to_ascii_lowercase()
        )
    };

    // Map unique `host/repo:headBranch` -> index in `remaining`; ambiguous heads become `None`.
    let mut by_head: HashMap<String, Option<usize>> = HashMap::new();
    for (idx, link) in remaining.iter().enumerate() {
        let Some(snapshot) = &link.snapshot else {
            continue;
        };
        let key = branch_key(link, &snapshot.head_branch);
        by_head
            .entry(key)
            .and_modify(|slot| *slot = None)
            .or_insert(Some(idx));
    }

    let parent_of = |idx: usize| -> Option<usize> {
        let link = remaining.get(idx)?;
        let snapshot = link.snapshot.as_ref()?;
        let parent_idx = by_head
            .get(&branch_key(link, &snapshot.base_branch))
            .copied()
            .flatten()?;
        (parent_idx != idx).then_some(parent_idx)
    };

    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for idx in 0..remaining.len() {
        let Some(parent_idx) = parent_of(idx) else {
            continue;
        };
        let parent_key = pull_request_key(&remaining[parent_idx]);
        children.entry(parent_key).or_default().push(idx);
    }

    for idx in 0..remaining.len() {
        if parent_of(idx).is_some() {
            continue;
        }
        let mut layers: Vec<ThreadPullRequestLink> = Vec::new();
        let mut depths: Vec<usize> = Vec::new();
        let mut pending: Vec<(usize, usize)> = vec![(idx, 0)];
        while let Some((cur_idx, depth)) = pending.pop() {
            let link = &remaining[cur_idx];
            let key = pull_request_key(link);
            if placed.contains(&key) {
                continue;
            }
            placed.insert(key.clone());
            layers.push(link.clone());
            depths.push(depth);
            if let Some(below) = children.get(&key) {
                for &child_idx in below.iter().rev() {
                    pending.push((child_idx, depth + 1));
                }
            }
        }
        if !layers.is_empty() {
            chains.push(ThreadPullRequestChain {
                kind: ChainKind::Derived,
                layers,
                depths,
            });
        }
    }

    // Any remaining links caught in a branch cycle become singletons at depth 0.
    for link in &remaining {
        let key = pull_request_key(link);
        if !placed.contains(&key) {
            placed.insert(key);
            chains.push(ThreadPullRequestChain {
                kind: ChainKind::Derived,
                layers: vec![link.clone()],
                depths: vec![0],
            });
        }
    }

    chains
}

/// Flattens resolved chains into ordered rows, newest-updated chain first (`pullRequestListLines`).
#[must_use]
pub(super) fn pull_request_list_lines(
    mut chains: Vec<ThreadPullRequestChain>,
) -> Vec<PullRequestListLine> {
    chains.sort_by(|left, right| {
        let left_max = left.layers.iter().map(latest_updated_ms).max().unwrap_or(0);
        let right_max = right
            .layers
            .iter()
            .map(latest_updated_ms)
            .max()
            .unwrap_or(0);
        right_max.cmp(&left_max)
    });

    let mut out = Vec::new();
    for chain in chains {
        let Some(bottom) = chain.layers.first() else {
            continue;
        };
        let chain_key = format!("{}/{}#{}", bottom.host, bottom.repository, bottom.number);
        let chain_len = chain.layers.len();
        let kind = chain.kind;
        for (idx, (link, depth)) in chain.layers.into_iter().zip(chain.depths).enumerate() {
            let stack = (idx == 0 && chain_len > 1).then_some(StackSummary {
                kind,
                size: chain_len,
            });
            out.push(PullRequestListLine {
                link,
                depth,
                chain_key: chain_key.clone(),
                stack,
            });
        }
    }
    out
}

/// Counts visible links that are open (or awaiting host state) (`ThreadPullRequestsPanel.tsx`).
#[must_use]
pub(super) fn open_pull_request_count(links: &[ThreadPullRequestLink]) -> usize {
    links
        .iter()
        .filter(|link| {
            link.snapshot
                .as_ref()
                .is_none_or(|s| s.state == PullRequestState::Open)
        })
        .count()
}

/// Most recent `snapshot.synced_at` across all visible links (`latestSyncedAt`).
#[must_use]
pub(super) fn latest_synced_at(links: &[ThreadPullRequestLink]) -> Option<&str> {
    let mut latest: Option<&str> = None;
    for link in links {
        let Some(at) = link.snapshot.as_ref().map(|s| s.synced_at.as_str()) else {
            continue;
        };
        if latest.is_none_or(|cur| at > cur) {
            latest = Some(at);
        }
    }
    latest
}

/// Formats Conn's footer status line: `"{open} open · {linked} linked · synced {rel}"`.
#[must_use]
pub(super) fn format_footer_summary(
    open_count: usize,
    link_count: usize,
    last_synced: Option<&str>,
    now_ms: i64,
) -> String {
    let mut summary = if link_count > 0 {
        format!("{open_count} open · {link_count} linked")
    } else {
        String::new()
    };
    if let Some(rel) = last_synced.and_then(|ts| format_relative_time(ts, now_ms)) {
        if !summary.is_empty() {
            summary.push_str(" · ");
        }
        summary.push_str("synced ");
        summary.push_str(&rel);
    }
    summary
}

/// Formats a non-negative integer with thousands separators (`Intl.NumberFormat` / `formatDiffCount`).
#[must_use]
pub(super) fn format_diff_count(count: i64) -> String {
    let digits = count.max(0).to_string();
    let len = digits.len();
    if len <= 3 {
        return digits;
    }
    let mut out = String::with_capacity(len + len / 3);
    for (idx, ch) in digits.chars().enumerate() {
        let remaining = len - idx;
        if idx > 0 && remaining.is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Formats an ISO-8601 timestamp relative to `now_ms` matching Conn's `RelativeTime`
/// (`timestampFormat.ts`: `just now`, `{m}m ago`, `{h}h ago`, `{d}d ago`).
#[must_use]
pub(crate) fn format_relative_time(iso: &str, now_ms: i64) -> Option<String> {
    let at_ms = parse_date_ms(iso)?;
    let elapsed_ms = (now_ms - at_ms).max(0);
    let seconds = elapsed_ms / 1_000;
    if seconds < 60 {
        return Some("just now".to_owned());
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h ago"));
    }
    Some(format!("{}d ago", hours / 24))
}

/// Current Unix wall-clock time in milliseconds.
#[must_use]
pub(crate) fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Middle-truncates a long repository or branch name while preserving the readable tail segment,
/// matching `MiddleTruncate.tsx` (`splitForMiddleTruncate`).
#[must_use]
pub(super) fn middle_truncate(value: &str, max_chars: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars || max_chars < 6 {
        return value.to_owned();
    }
    let default_tail = 10usize.min(max_chars / 2);
    let max_segment_tail = 16usize.min(max_chars.saturating_sub(4));
    let mut keep = default_tail;
    if let Some(slash) = chars.iter().rposition(|&c| c == '/')
        && slash > 0
        && slash < chars.len() - 1
    {
        let segment = chars.len() - slash - 1;
        if segment <= max_segment_tail {
            keep = segment;
        }
    }
    let head_len = max_chars.saturating_sub(keep + 1).max(2);
    let tail_start = chars.len().saturating_sub(keep);
    if head_len >= tail_start {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len());
    for &c in &chars[..head_len] {
        out.push(c);
    }
    out.push('…');
    for &c in &chars[tail_start..] {
        out.push(c);
    }
    out
}

/// Leading state glyph for a pull request row (`PullRequestRowGlyph` + waiting fallback).
#[must_use]
pub(super) fn pr_state_glyph(snapshot: Option<&ThreadPullRequestSnapshot>) -> GlyphSpec {
    let Some(s) = snapshot else {
        return GlyphSpec {
            icon_path: "superhero/pull-request.svg",
            tone: GlyphTone::Muted,
            label: "Waiting for host state",
        };
    };
    match (s.state, s.is_draft) {
        (PullRequestState::Open, true) => GlyphSpec {
            icon_path: "superhero/pull-request-draft.svg",
            tone: GlyphTone::DraftMuted,
            label: "Draft",
        },
        (PullRequestState::Open, false) => GlyphSpec {
            icon_path: "superhero/pull-request.svg",
            tone: GlyphTone::Success,
            label: "Open",
        },
        (PullRequestState::Closed, _) => GlyphSpec {
            icon_path: "superhero/pull-request-closed.svg",
            tone: GlyphTone::Destructive,
            label: "Closed",
        },
        (PullRequestState::Merged, _) => GlyphSpec {
            icon_path: "superhero/merge.svg",
            tone: GlyphTone::Merged,
            label: "Merged",
        },
    }
}

/// Whether the conflict overlay triangle draws on the PR glyph (`resolvePullRequestConflict`).
#[must_use]
pub(super) fn pr_has_conflict(snapshot: Option<&ThreadPullRequestSnapshot>) -> bool {
    snapshot.is_some_and(|s| {
        s.state == PullRequestState::Open
            && !s.is_draft
            && s.mergeability == Some(PullRequestMergeability::Conflicting)
    })
}

/// Checks status glyph (`CHECKS_STATE_PRESENTATION`).
#[must_use]
pub(super) fn pr_checks_glyph(state: PullRequestSummaryChecksState) -> GlyphSpec {
    match state {
        PullRequestSummaryChecksState::Passing => GlyphSpec {
            icon_path: "superhero/check-circle.svg",
            tone: GlyphTone::Success,
            label: "All checks have passed",
        },
        PullRequestSummaryChecksState::Failing => GlyphSpec {
            icon_path: "superhero/clear-circle.svg",
            tone: GlyphTone::Destructive,
            label: "Some checks were not successful",
        },
        PullRequestSummaryChecksState::Pending => GlyphSpec {
            icon_path: "superhero/circle-dot.svg",
            tone: GlyphTone::Warning,
            label: "Some checks haven't completed yet",
        },
    }
}

/// Review decision glyph (`reviewDecisionPresentation`).
#[must_use]
pub(super) fn pr_review_glyph(decision: PullRequestSummaryReviewDecision) -> GlyphSpec {
    match decision {
        PullRequestSummaryReviewDecision::Approved => GlyphSpec {
            icon_path: "superhero/user-approved.svg",
            tone: GlyphTone::Success,
            label: "Approved",
        },
        PullRequestSummaryReviewDecision::ChangesRequested => GlyphSpec {
            icon_path: "superhero/user-rejected.svg",
            tone: GlyphTone::Warning,
            label: "Changes requested",
        },
        PullRequestSummaryReviewDecision::ReviewRequired => GlyphSpec {
            icon_path: "superhero/user.svg",
            tone: GlyphTone::MutedSoft,
            label: "Awaiting review",
        },
    }
}

/// Issue state glyph (`issueStatePresentation` in `issuePresentation.tsx`).
#[must_use]
pub(super) fn issue_state_glyph(state: Option<&IssueState>) -> GlyphSpec {
    let Some(s) = state else {
        return GlyphSpec {
            icon_path: "superhero/circle-dot.svg",
            tone: GlyphTone::Muted,
            label: "Issue",
        };
    };
    if s.category == IssueStateCategory::Open {
        return GlyphSpec {
            icon_path: "superhero/circle-dot.svg",
            tone: GlyphTone::Success,
            label: "Open",
        };
    }
    if s.close_reason
        .as_deref()
        .is_some_and(|reason| reason != "completed")
    {
        return GlyphSpec {
            icon_path: "superhero/blocked.svg",
            tone: GlyphTone::DraftMuted,
            label: "Closed",
        };
    }
    GlyphSpec {
        icon_path: "superhero/check-circle.svg",
        tone: GlyphTone::Merged,
        label: "Completed",
    }
}

/// Human-readable source label (`SOURCE_LABELS` in `ThreadPullRequestsPanel.tsx`).
#[must_use]
#[expect(dead_code, reason = "ready for native tooltip wiring")]
pub(super) fn pr_source_label(source: ThreadPullRequestLinkSource) -> &'static str {
    match source {
        ThreadPullRequestLinkSource::Manual => "Linked by you",
        ThreadPullRequestLinkSource::Created => "Created from this thread",
        ThreadPullRequestLinkSource::Agent => "Linked by the agent",
        ThreadPullRequestLinkSource::Stack => "Found in the stack",
        ThreadPullRequestLinkSource::StackDismissed => "Dismissed",
    }
}

/// Finds the project id whose repository matches `link`, falling back to `thread_project_id`
/// (`findProjectForChangeRequest` fallback in `ThreadPullRequestsPanel.tsx:571`).
#[must_use]
pub(super) fn find_project_for_link(
    projects: &[ProjectRepoInfo],
    thread_project_id: Option<&str>,
    link: &ThreadPullRequestLink,
) -> Option<String> {
    let target_host = link.host.trim().to_ascii_lowercase();
    let target_repo = link.repository.trim().to_ascii_lowercase();
    let matched = projects.iter().find(|project| {
        project
            .host
            .as_deref()
            .is_some_and(|h| h.eq_ignore_ascii_case(&target_host))
            && project
                .repository
                .as_deref()
                .is_some_and(|r| r.eq_ignore_ascii_case(&target_repo))
    });
    matched
        .map(|p| p.id.clone())
        .or_else(|| thread_project_id.map(str::to_owned))
}

/// Parses a pull request URL across GitHub/GHE/Forgejo/Gitea, GitLab, Bitbucket, and Azure DevOps.
#[must_use]
pub(crate) fn parse_change_request_url(raw: &str) -> Option<ParsedPullRequestRef> {
    let trimmed = raw.trim();
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str()?.to_ascii_lowercase()),
        None => parsed.host_str()?.to_ascii_lowercase(),
    };
    let segments: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();

    // GitLab: /<group...>/<repo>/-/merge_requests/<n>
    if let Some(pos) = segments
        .windows(2)
        .position(|w| w == ["-", "merge_requests"])
        && pos >= 2
        && let Some(number) = segments
            .get(pos + 2)
            .and_then(|n| n.parse::<i64>().ok())
            .filter(|&n| n > 0)
    {
        let repository = segments[..pos].join("/");
        let canonical = format!(
            "{}://{}/{}/-/merge_requests/{number}",
            parsed.scheme(),
            host,
            repository
        );
        return Some(ParsedPullRequestRef {
            host,
            repository,
            number,
            url: canonical,
        });
    }

    // Azure DevOps: /<org>/<project>/_git/<repo>/pullrequest/<n>
    if let Some(pos) = segments.iter().position(|&s| s == "pullrequest")
        && pos >= 4
        && segments.get(pos - 2) == Some(&"_git")
        && let Some(number) = segments
            .get(pos + 1)
            .and_then(|n| n.parse::<i64>().ok())
            .filter(|&n| n > 0)
    {
        let repository = segments[..pos].join("/");
        let canonical = format!(
            "{}://{}/{}/pullrequest/{number}",
            parsed.scheme(),
            host,
            repository
        );
        return Some(ParsedPullRequestRef {
            host,
            repository,
            number,
            url: canonical,
        });
    }

    // GitHub / Forgejo / Gitea: /<owner>/<repo>/pull/<n> or /pulls/<n>
    // Bitbucket: /<workspace>/<repo>/pull-requests/<n>
    for marker in ["pull", "pulls", "pull-requests"] {
        if let Some(pos) = segments.iter().position(|&s| s == marker)
            && pos >= 2
            && let Some(number) = segments
                .get(pos + 1)
                .and_then(|n| n.parse::<i64>().ok())
                .filter(|&n| n > 0)
        {
            let repository = segments[..pos].join("/");
            let canonical = format!(
                "{}://{}/{}/{marker}/{number}",
                parsed.scheme(),
                host,
                repository
            );
            return Some(ParsedPullRequestRef {
                host,
                repository,
                number,
                url: canonical,
            });
        }
    }

    None
}

/// Resolves a user's input in the Link pull request dialog (full URL or `123` / `#123`)
/// matching Conn's `resolveLinkPullRequestInput`.
#[must_use]
pub(super) fn resolve_link_pull_request_input(
    input: &str,
    project: Option<&ProjectRepoInfo>,
) -> LinkInputResolution {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return LinkInputResolution::Empty;
    }
    if let Some(parsed) = parse_change_request_url(trimmed) {
        return LinkInputResolution::Resolved(parsed);
    }
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && let Ok(number) = digits.parse::<i64>()
        && number > 0
    {
        let Some(proj) = project else {
            return LinkInputResolution::Error(
                "Paste the full pull request URL; this thread has no repository to resolve the number against.".to_owned(),
            );
        };
        let (Some(host), Some(repo)) = (proj.host.as_deref(), proj.repository.as_deref()) else {
            return LinkInputResolution::Error(
                "Paste the full pull request URL; this thread has no repository to resolve the number against.".to_owned(),
            );
        };
        let url = build_change_request_url(proj, host, repo, number);
        return LinkInputResolution::Resolved(ParsedPullRequestRef {
            host: host.to_owned(),
            repository: repo.to_owned(),
            number,
            url,
        });
    }
    LinkInputResolution::Error("Use a pull request URL, 123, or #123.".to_owned())
}

fn build_change_request_url(
    project: &ProjectRepoInfo,
    host: &str,
    repository: &str,
    number: i64,
) -> String {
    let base = project
        .web_url
        .as_deref()
        .map(|u| u.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| format!("https://{host}/{repository}"));
    match project.provider.as_deref() {
        Some("gitlab") => format!("{base}/-/merge_requests/{number}"),
        Some("bitbucket") => format!("{base}/pull-requests/{number}"),
        Some("azure-devops") => format!("{base}/pullrequest/{number}"),
        Some("forgejo") | Some("gitea") => format!("{base}/pulls/{number}"),
        _ => format!("{base}/pull/{number}"),
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::{ThreadPullRequestStack, ThreadPullRequestStackLayer, lit};
    use serde_json::json;

    use super::*;

    fn make_pr(
        number: i64,
        source: ThreadPullRequestLinkSource,
        head: &str,
        base: &str,
        updated_at: &str,
    ) -> ThreadPullRequestLink {
        ThreadPullRequestLink {
            host: "github.com".to_owned(),
            repository: "nckrtl/conn".to_owned(),
            number,
            url: format!("https://github.com/nckrtl/conn/pull/{number}"),
            repository_web_url: None,
            source,
            linked_at: updated_at.to_owned(),
            snapshot: Some(ThreadPullRequestSnapshot {
                state: PullRequestState::Open,
                title: format!("PR #{number}"),
                head_branch: head.to_owned(),
                base_branch: base.to_owned(),
                is_draft: false,
                updated_at: Some(updated_at.to_owned()),
                synced_at: updated_at.to_owned(),
                closed_at: None,
                merged_at: None,
                author: None,
                additions: Some(12),
                deletions: Some(3),
                changed_files: Some(2),
                review_decision: None,
                checks_state: None,
                mergeability: None,
                rebase_required: None,
            }),
            stack: None,
            watch: None,
            ended_watch: None,
        }
    }

    #[test]
    fn filters_stack_dismissed_tombstones() {
        let links = vec![
            make_pr(
                1,
                ThreadPullRequestLinkSource::Manual,
                "feat/a",
                "main",
                "2026-11-20T10:00:00Z",
            ),
            make_pr(
                2,
                ThreadPullRequestLinkSource::StackDismissed,
                "feat/b",
                "feat/a",
                "2026-11-20T11:00:00Z",
            ),
            make_pr(
                3,
                ThreadPullRequestLinkSource::Agent,
                "feat/c",
                "main",
                "2026-11-20T12:00:00Z",
            ),
        ];
        let visible = visible_thread_pull_requests(&links);
        let nums: Vec<i64> = visible.iter().map(|l| l.number).collect();
        assert_eq!(nums, vec![1, 3], "stack-dismissed tombstone must be hidden");
    }

    #[test]
    fn resolves_derived_branch_chains_and_sorts_newest_chain_first() {
        let base = make_pr(
            10,
            ThreadPullRequestLinkSource::Created,
            "feat/base",
            "main",
            "2026-11-20T10:00:00Z",
        );
        let top = make_pr(
            11,
            ThreadPullRequestLinkSource::Stack,
            "feat/top",
            "feat/base",
            "2026-11-20T12:00:00Z",
        );
        let solo = make_pr(
            9,
            ThreadPullRequestLinkSource::Manual,
            "fix/other",
            "main",
            "2026-11-20T11:00:00Z",
        );

        let chains = resolve_thread_pull_request_chains(&[solo, top, base]);
        let lines = pull_request_list_lines(chains);

        let summary: Vec<(i64, usize, Option<usize>)> = lines
            .iter()
            .map(|l| (l.link.number, l.depth, l.stack.map(|s| s.size)))
            .collect();
        assert_eq!(
            summary,
            vec![(10, 0, Some(2)), (11, 1, None), (9, 0, None)],
            "derived chain with newest layer at 12:00 sorts before solo at 11:00, with base at depth 0 carrying stack size 2"
        );
    }

    #[test]
    fn resolves_native_stacks_by_layer_order() {
        let mut a = make_pr(
            21,
            ThreadPullRequestLinkSource::Stack,
            "stack/2",
            "stack/1",
            "2026-11-20T10:00:00Z",
        );
        let mut b = make_pr(
            20,
            ThreadPullRequestLinkSource::Stack,
            "stack/1",
            "main",
            "2026-11-20T09:00:00Z",
        );
        let stack = ThreadPullRequestStack {
            kind: lit::Native,
            id: "stk-1".to_owned(),
            number: 1,
            url: "https://example.com/stack/1".to_owned(),
            base: "main".to_owned(),
            layers: vec![
                ThreadPullRequestStackLayer {
                    number: 20,
                    head_branch: "stack/1".to_owned(),
                    state: PullRequestState::Open,
                },
                ThreadPullRequestStackLayer {
                    number: 21,
                    head_branch: "stack/2".to_owned(),
                    state: PullRequestState::Open,
                },
            ],
        };
        a.stack = Some(stack.clone());
        b.stack = Some(stack);

        let lines = pull_request_list_lines(resolve_thread_pull_request_chains(&[a, b]));
        let summary: Vec<(i64, usize, Option<ChainKind>)> = lines
            .iter()
            .map(|l| (l.link.number, l.depth, l.stack.map(|s| s.kind)))
            .collect();
        assert_eq!(
            summary,
            vec![(20, 0, Some(ChainKind::Native)), (21, 1, None)],
            "native stack members order by layer index with Native stack badge on base"
        );
    }

    #[test]
    fn parses_legacy_linked_pull_request_and_issues_from_thread_json() {
        let thread = json!({
            "projectId": "proj-1",
            "linkedPullRequest": {
                "projectId": "proj-1",
                "repository": "Nckrtl/Conn",
                "number": 42,
                "url": "https://github.com/Nckrtl/Conn/pull/42"
            },
            "issues": [{
                "tracker": "github",
                "host": "github.com",
                "scope": "nckrtl/conn",
                "key": "99",
                "projectId": "proj-1",
                "url": "https://github.com/nckrtl/conn/issues/99",
                "source": "agent",
                "linkedAt": "2026-11-20T10:00:00Z",
                "displayKey": "#99",
                "title": "Fix linked items"
            }]
        });
        let data = parse_thread_linked_data(&thread);
        assert_eq!(
            data.project_id.as_deref(),
            Some("proj-1"),
            "project id parsed"
        );
        assert_eq!(data.pull_requests.len(), 1, "legacy PR converted");
        assert_eq!(
            data.pull_requests[0].host, "github.com",
            "host derived from legacy URL"
        );
        assert_eq!(
            data.pull_requests[0].repository, "nckrtl/conn",
            "repository normalized to lowercase"
        );
        assert_eq!(data.issues.len(), 1, "linked issue parsed");
        assert_eq!(data.issues[0].display_key, "#99", "issue display key");
    }

    #[test]
    fn formats_diff_counts_relative_times_and_footer_summary() {
        assert_eq!(format_diff_count(0), "0", "zero");
        assert_eq!(format_diff_count(999), "999", "under thousand");
        assert_eq!(format_diff_count(1_234), "1,234", "thousands grouped");
        assert_eq!(
            format_diff_count(1_234_567),
            "1,234,567",
            "millions grouped"
        );

        let now = parse_date_ms("2026-11-21T12:00:00Z").unwrap_or(0);
        assert_eq!(
            format_relative_time("2026-11-21T11:59:30Z", now).as_deref(),
            Some("just now"),
            "under 60s"
        );
        assert_eq!(
            format_relative_time("2026-11-21T11:55:00Z", now).as_deref(),
            Some("5m ago"),
            "minutes"
        );
        assert_eq!(
            format_relative_time("2026-11-21T09:00:00Z", now).as_deref(),
            Some("3h ago"),
            "hours"
        );
        assert_eq!(
            format_relative_time("2026-11-19T12:00:00Z", now).as_deref(),
            Some("2d ago"),
            "days"
        );
        assert_eq!(
            format_footer_summary(2, 3, Some("2026-11-21T11:55:00Z"), now),
            "2 open · 3 linked · synced 5m ago",
            "footer summary matches Conn format"
        );
    }

    #[test]
    fn parses_change_request_urls_and_number_inputs() {
        let gh = parse_change_request_url("https://github.com/nckrtl/conn/pull/123/files");
        assert_eq!(
            gh,
            Some(ParsedPullRequestRef {
                host: "github.com".to_owned(),
                repository: "nckrtl/conn".to_owned(),
                number: 123,
                url: "https://github.com/nckrtl/conn/pull/123".to_owned(),
            }),
            "GitHub PR URL with trailing path"
        );

        let gl = parse_change_request_url("https://gitlab.com/org/sub/repo/-/merge_requests/77");
        assert_eq!(
            gl.as_ref().map(|r| (r.repository.as_str(), r.number)),
            Some(("org/sub/repo", 77)),
            "GitLab nested group MR URL"
        );

        let project = ProjectRepoInfo {
            id: "p1".to_owned(),
            workspace_root: "/tmp/repo".to_owned(),
            host: Some("github.com".to_owned()),
            repository: Some("nckrtl/conn".to_owned()),
            web_url: Some("https://github.com/nckrtl/conn".to_owned()),
            provider: Some("github".to_owned()),
        };
        assert_eq!(
            resolve_link_pull_request_input("#42", Some(&project)),
            LinkInputResolution::Resolved(ParsedPullRequestRef {
                host: "github.com".to_owned(),
                repository: "nckrtl/conn".to_owned(),
                number: 42,
                url: "https://github.com/nckrtl/conn/pull/42".to_owned(),
            }),
            "#42 resolves against project repository"
        );
        assert!(
            matches!(
                resolve_link_pull_request_input("42", None),
                LinkInputResolution::Error(_)
            ),
            "number without project returns helpful error"
        );
    }

    #[test]
    fn maps_glyphs_for_all_pr_and_issue_states() {
        let mut pr = make_pr(
            1,
            ThreadPullRequestLinkSource::Manual,
            "a",
            "main",
            "2026-11-20T10:00:00Z",
        );
        assert_eq!(
            pr_state_glyph(None).icon_path,
            "superhero/pull-request.svg",
            "waiting uses muted PR glyph"
        );
        assert_eq!(
            pr_state_glyph(pr.snapshot.as_ref()).tone,
            GlyphTone::Success,
            "open PR is success green"
        );
        if let Some(s) = &mut pr.snapshot {
            s.is_draft = true;
            assert_eq!(
                pr_state_glyph(Some(s)).icon_path,
                "superhero/pull-request-draft.svg",
                "draft PR uses draft glyph"
            );
            s.is_draft = false;
            s.mergeability = Some(PullRequestMergeability::Conflicting);
            assert!(pr_has_conflict(Some(s)), "open non-draft conflicting PR");
            s.state = PullRequestState::Merged;
            assert!(!pr_has_conflict(Some(s)), "merged PR hides conflict badge");
            assert_eq!(
                pr_state_glyph(Some(s)).tone,
                GlyphTone::Merged,
                "merged PR uses merged violet tone"
            );
        }

        let open_issue = IssueState {
            category: IssueStateCategory::Open,
            name: "In Progress".to_owned(),
            close_reason: None,
        };
        let completed_issue = IssueState {
            category: IssueStateCategory::Closed,
            name: "Done".to_owned(),
            close_reason: Some("completed".to_owned()),
        };
        let not_planned = IssueState {
            category: IssueStateCategory::Closed,
            name: "Closed as not planned".to_owned(),
            close_reason: Some("not_planned".to_owned()),
        };
        assert_eq!(
            issue_state_glyph(Some(&open_issue)).tone,
            GlyphTone::Success,
            "open issue uses open PR green"
        );
        assert_eq!(
            issue_state_glyph(Some(&completed_issue)).tone,
            GlyphTone::Merged,
            "completed issue uses merged violet"
        );
        assert_eq!(
            issue_state_glyph(Some(&not_planned)).icon_path,
            "superhero/blocked.svg",
            "non-completed closed issue uses circle-slash/blocked"
        );
    }

    #[test]
    fn middle_truncates_long_paths_and_resolves_capabilities_and_project_match() {
        assert_eq!(
            middle_truncate("short/repo", 24),
            "short/repo",
            "short string stays untouched"
        );
        let cut = middle_truncate("very-long-organization/conn-gpui", 20);
        assert!(cut.contains('…'), "long repo gets middle ellipsis: {cut}");
        assert!(
            cut.ends_with("conn-gpui"),
            "middle truncate keeps trailing repo segment: {cut}"
        );

        let caps = parse_server_capabilities(&json!({
            "environment": {
                "capabilities": {
                    "pullRequests": true,
                    "threadPullRequestLinking": true,
                    "threadPullRequestWatch": true,
                    "issues": true
                }
            }
        }));
        assert_eq!(
            caps,
            ServerCapabilities {
                pull_requests: true,
                thread_pull_request_linking: true,
                thread_pull_request_watch: true,
                issues: true,
            },
            "capabilities parsed from server.getConfig"
        );

        let projects = vec![ProjectRepoInfo {
            id: "p-matched".to_owned(),
            workspace_root: "/tmp/conn".to_owned(),
            host: Some("github.com".to_owned()),
            repository: Some("nckrtl/conn".to_owned()),
            web_url: None,
            provider: Some("github".to_owned()),
        }];
        let pr = make_pr(
            5,
            ThreadPullRequestLinkSource::Manual,
            "a",
            "main",
            "2026-11-20T10:00:00Z",
        );
        assert_eq!(
            find_project_for_link(&projects, Some("p-thread"), &pr).as_deref(),
            Some("p-matched"),
            "matching repo project takes precedence over thread project"
        );
        assert_eq!(
            find_project_for_link(&[], Some("p-thread"), &pr).as_deref(),
            Some("p-thread"),
            "falls back to thread project when no repo matches"
        );
    }

    #[test]
    fn every_linked_items_superhero_icon_exists_in_embedded_assets() {
        use gpui_kit::AssetSource as _;
        let assets = crate::superhero::AppAssets;
        for path in [
            "superhero/pull-request.svg",
            "superhero/pull-request-draft.svg",
            "superhero/pull-request-closed.svg",
            "superhero/merge.svg",
            "superhero/warning.svg",
            "superhero/layers.svg",
            "superhero/link.svg",
            "superhero/unlink.svg",
            "superhero/add.svg",
            "superhero/show.svg",
            "superhero/hide.svg",
            "superhero/more-horizontal.svg",
            "superhero/arrow-up-right.svg",
            "superhero/check-circle.svg",
            "superhero/clear-circle.svg",
            "superhero/circle-dot.svg",
            "superhero/blocked.svg",
            "superhero/user-approved.svg",
            "superhero/user-rejected.svg",
            "superhero/user.svg",
            "superhero/thread.svg",
            "superhero/ticket.svg",
            "superhero/refresh.svg",
            "superhero/spinner.svg",
        ] {
            let loaded = assets.load(path).ok().flatten();
            assert!(
                loaded.is_some(),
                "linked items superheroicon `{path}` must exist in embedded assets"
            );
        }
    }
}
