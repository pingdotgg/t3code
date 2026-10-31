import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type LinearIssue,
  type LinearIssueContextRecord,
  type LinearIssueDetail,
  type LinearLinkedPullRequest,
  type LinearMapping,
  type LinearStateType,
  type ProjectId,
} from "@t3tools/contracts";

import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";
import { isStateMoveEligible } from "./linearWriteBack.ts";
import { formatLinearIssueMarkdown, type LinearIssueSnapshot } from "./linearIssueMarkdown.ts";

/** Limits for what an agent reads about one issue. Mirrors the contract record's bounds. */
const LINEAR_CONTEXT_DESCRIPTION_MAX_CHARS = 16_000;
const LINEAR_CONTEXT_SUB_ISSUES_MAX = 50;
const LINEAR_CONTEXT_COMMENTS_MAX = 10;
const LINEAR_CONTEXT_COMMENT_MAX_CHARS = 2_000;
const LINEAR_CONTEXT_LABELS_MAX = 50;
const LINEAR_CONTEXT_LINKED_PRS_MAX = 20;
const LINEAR_CONTEXT_SHORT_MAX_CHARS = 2_048;

const DESCRIPTION_TRUNCATION_MARKER = "\n\n[description truncated]";
const COMMENT_TRUNCATION_MARKER = " [comment truncated]";
const INPUT_TRUNCATION_NOTE =
  "\n\n[The rest of this issue was left out: it exceeds the input size limit.]";

// ── Mapping ───────────────────────────────────────────────────────────────

export interface LinearMappingResolution {
  /** The T3 project (in the mapping's environment) the issue opens in. */
  readonly projectRef: ProjectId;
  readonly baseBranch: string | null;
  readonly source: "project" | "team";
  readonly mappingId: string;
}

/** A project mapping beats its team's mapping; null means "ask each time". */
export function resolveLinearMapping(
  issue: {
    readonly team: { readonly id: string };
    readonly project: { readonly id: string } | null;
  },
  mappings: ReadonlyArray<LinearMapping>,
): LinearMappingResolution | null {
  const projectMapping =
    issue.project === null
      ? undefined
      : mappings.find(
          (mapping) => mapping.kind === "project" && mapping.linearId === issue.project?.id,
        );
  const teamMapping = mappings.find(
    (mapping) => mapping.kind === "team" && mapping.linearId === issue.team.id,
  );
  const mapping = projectMapping ?? teamMapping;
  if (mapping === undefined) return null;
  return {
    projectRef: mapping.projectId,
    baseBranch: mapping.baseBranch ?? null,
    source: projectMapping !== undefined ? "project" : "team",
    mappingId: mapping.id,
  };
}

// ── State move ────────────────────────────────────────────────────────────

/**
 * The state a launch moves an issue to: the configured state when it belongs to the issue's team,
 * else the team's first `started` state. Null when the issue is not eligible or no state fits.
 */
export function resolveLinearMoveTarget(input: {
  readonly currentStateType: LinearStateType;
  readonly teamStates: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: LinearStateType;
    readonly position: number;
  }>;
  readonly preferredStateId: string | null;
}): { readonly id: string; readonly name: string } | null {
  if (!isStateMoveEligible(input.currentStateType)) return null;
  const preferred =
    input.preferredStateId === null
      ? undefined
      : input.teamStates.find((state) => state.id === input.preferredStateId);
  if (preferred !== undefined) return { id: preferred.id, name: preferred.name };
  const firstStarted = [...input.teamStates]
    .filter((state) => state.type === "started")
    .sort((left, right) => left.position - right.position)[0];
  return firstStarted ? { id: firstStarted.id, name: firstStarted.name } : null;
}

// ── Prompt ────────────────────────────────────────────────────────────────

/** The composer text a launch starts from; the issue itself travels as attached context. */
export function buildLinearIssuePrompt(issue: Pick<LinearIssue, "identifier" | "title">): string {
  return [
    `Implement ${issue.identifier}: ${issue.title}.`,
    "Read the attached issue, its sub-issues and comments first.",
    "When done, open a PR. Keep the branch name so Linear links it.",
  ].join("\n\n");
}

// ── Token estimate ────────────────────────────────────────────────────────

function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function formatTokenEstimate(chars: number): string {
  const tokens = estimateTokens(chars);
  if (tokens < 1_000) return `~${tokens} tokens`;
  return `~${(Math.round(tokens / 100) / 10).toFixed(1)}k tokens`;
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export interface LinearIssueIncludes {
  readonly subIssues: boolean;
  readonly comments: boolean;
  readonly linkedPrs: boolean;
}

function clip(value: string, max: number, marker = ""): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function clipShort(value: string): string {
  return clip(value, LINEAR_CONTEXT_SHORT_MAX_CHARS);
}

function formatLinkedPullRequest(pr: LinearLinkedPullRequest): string {
  const ref = pr.repository ? `${pr.repository}#${pr.number}` : `#${pr.number}`;
  return clipShort(`${ref}${pr.state ? ` (${pr.state})` : ""} ${pr.url}`);
}

/** Counts available to include, after the context limits: what the checkboxes show. */
export function linearIssueIncludeCounts(detail: LinearIssueDetail): {
  readonly subIssues: number;
  readonly comments: number;
  readonly linkedPrs: number;
} {
  return {
    subIssues: Math.min(detail.subIssues.length, LINEAR_CONTEXT_SUB_ISSUES_MAX),
    comments: Math.min(detail.comments.length, LINEAR_CONTEXT_COMMENTS_MAX),
    linkedPrs: Math.min(detail.issue.linkedPullRequests.length, LINEAR_CONTEXT_LINKED_PRS_MAX),
  };
}

const ALL_INCLUDED: LinearIssueIncludes = { subIssues: true, comments: true, linkedPrs: true };

function buildLinearIssueSnapshot(
  detail: LinearIssueDetail,
  include: LinearIssueIncludes,
): LinearIssueSnapshot {
  const { issue } = detail;
  return {
    issueId: issue.id,
    identifier: clip(issue.identifier, 64),
    title: clipShort(issue.title),
    url: clipShort(issue.url),
    teamName: clipShort(issue.team.name),
    projectName: issue.project ? clipShort(issue.project.name) : null,
    milestoneName: issue.milestone ? clipShort(issue.milestone.name) : null,
    stateName: clipShort(issue.state.name),
    stateType: issue.state.type,
    priorityLabel: clipShort(issue.priorityLabel),
    assigneeName: issue.assignee ? clipShort(issue.assignee.name) : null,
    labels: issue.labels.slice(0, LINEAR_CONTEXT_LABELS_MAX).map((label) => clipShort(label.name)),
    branchName: clipShort(issue.branchName),
    description: clip(
      detail.description,
      LINEAR_CONTEXT_DESCRIPTION_MAX_CHARS,
      DESCRIPTION_TRUNCATION_MARKER,
    ),
    subIssues: include.subIssues
      ? detail.subIssues.slice(0, LINEAR_CONTEXT_SUB_ISSUES_MAX).map((sub) => ({
          identifier: clipShort(sub.identifier),
          title: clipShort(sub.title),
          stateType: sub.state.type,
        }))
      : [],
    // Detail holds the last 20 oldest to newest; keep the newest ones in that order.
    comments: include.comments
      ? detail.comments.slice(-LINEAR_CONTEXT_COMMENTS_MAX).map((comment) => ({
          author: comment.author ? clipShort(comment.author.name) : null,
          createdAt: clipShort(comment.createdAt),
          body: clip(comment.body, LINEAR_CONTEXT_COMMENT_MAX_CHARS, COMMENT_TRUNCATION_MARKER),
        }))
      : [],
    linkedPullRequests: include.linkedPrs
      ? issue.linkedPullRequests
          .slice(0, LINEAR_CONTEXT_LINKED_PRS_MAX)
          .map(formatLinkedPullRequest)
      : [],
  };
}

/** "+ 3 sub-issues, 2 comments", or null when the snapshot carries neither. */
export function linearIssueExtrasSummary(record: {
  readonly subIssues: { readonly length: number };
  readonly comments: { readonly length: number };
}): string | null {
  const parts = [
    record.subIssues.length > 0
      ? `${record.subIssues.length} sub-issue${record.subIssues.length === 1 ? "" : "s"}`
      : null,
    record.comments.length > 0
      ? `${record.comments.length} comment${record.comments.length === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `+ ${parts.join(", ")}`;
}

/** Frozen copy of the issue for the agent: later Linear edits do not change what it reads. */
export function buildLinearIssueContextRecord(
  detail: LinearIssueDetail,
  include: LinearIssueIncludes = ALL_INCLUDED,
): LinearIssueContextRecord {
  const snapshot = buildLinearIssueSnapshot(detail, include);
  return {
    version: 1,
    kind: "linear-issue",
    contextId: toKindScopedComposerContextId("linear-issue", snapshot.issueId),
    label: sanitizeComposerContextLabel(
      `${snapshot.identifier} · ${snapshot.title}`,
      "linear-issue",
    ),
    ...snapshot,
  };
}

// ── Markdown ──────────────────────────────────────────────────────────────

function truncateToInputLimit(text: string): string {
  if (text.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return text;
  return `${text.slice(0, PROVIDER_SEND_TURN_MAX_INPUT_CHARS - INPUT_TRUNCATION_NOTE.length)}${INPUT_TRUNCATION_NOTE}`;
}

/** Text-only rendering of an issue for a pipeline's first step, within the provider input limit. */
export function buildLinearIssueMarkdown(
  detail: LinearIssueDetail,
  include: LinearIssueIncludes,
): string {
  return truncateToInputLimit(formatLinearIssueMarkdown(buildLinearIssueSnapshot(detail, include)));
}
