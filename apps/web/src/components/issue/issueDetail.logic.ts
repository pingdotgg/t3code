import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  IssueActor,
  IssueCapabilities,
  IssueReactionContent,
  IssueReaction,
  IssueComment,
  IssueDetail,
  IssueAssigneeCandidate,
  IssueLabel,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueRef,
  PullRequestRef,
} from "@t3tools/contracts";
import { issueEntryKey, prependIssueComments } from "@t3tools/client-runtime/state/issues";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
} from "../../lib/openPullRequestLink";

import { PULL_REQUEST_REACTION_ORDER } from "../pullRequest/pullRequestReactions.logic";

export function retainUnacknowledgedIssueReactions(
  reactions: ReadonlyArray<IssueReaction>,
  desired: ReadonlyMap<IssueReactionContent, boolean>,
): ReadonlyMap<IssueReactionContent, boolean> {
  return new Map(
    [...desired].filter(
      ([content, reacted]) =>
        (reactions.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false) !==
        reacted,
    ),
  );
}

export function issueSupportsReactions(
  capabilities: Pick<IssueCapabilities, "reactions" | "commentReactions">,
  comment: boolean,
): boolean {
  return comment
    ? (capabilities.commentReactions ?? capabilities.reactions)
    : capabilities.reactions;
}

export function offeredIssueReactionContents(
  contents: ReadonlyArray<IssueReactionContent> | undefined,
) {
  return PULL_REQUEST_REACTION_ORDER.filter(
    (content) => contents === undefined || contents.includes(content),
  );
}

export type IssueOlderComments = {
  readonly issue: string;
  readonly viewer: string | null;
  readonly seed: string | null;
  readonly firstPage: ReadonlyArray<IssueComment>;
  readonly firstIds: ReadonlyArray<string>;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly cursor: string | null;
};

export function issueCommentsView(detail: IssueDetail, older: IssueOlderComments | null) {
  const held =
    older?.issue === issueEntryKey(detail) &&
    older.viewer === detail.viewer &&
    (detail.viewer !== null || older.firstPage === detail.comments) &&
    older.seed === detail.commentsCursor &&
    older.firstIds.length === detail.comments.length &&
    older.firstIds.every((id, index) => id === detail.comments[index]?.id)
      ? older
      : null;
  return {
    comments: prependIssueComments(detail.comments, held?.comments ?? []),
    cursor: held ? held.cursor : detail.commentsCursor,
    held,
  };
}

export function appendOlderIssueComments(
  detail: IssueDetail,
  older: IssueOlderComments | null,
  page: { readonly comments: ReadonlyArray<IssueComment>; readonly nextCursor: string | null },
): IssueOlderComments {
  return {
    issue: issueEntryKey(detail),
    viewer: detail.viewer,
    seed: detail.commentsCursor,
    firstPage: detail.comments,
    firstIds: detail.comments.map((comment) => comment.id),
    comments: prependIssueComments(
      issueCommentsView(detail, older).held?.comments ?? [],
      page.comments,
    ),
    cursor: page.nextCursor,
  };
}

export type IssueLinkedPullRequestTarget = Pick<
  PullRequestRef,
  "projectId" | "repository" | "number"
> & {
  host?: string;
  url: string;
};

export const issueAssigneeId = (actor: IssueActor) => actor.id ?? actor.login;

const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function isIssueAssignee(current: ReadonlyArray<string>, id: string): boolean {
  return current.some((currentId) => sameId(currentId, id));
}

export function nextIssueAssignees(
  ids: ReadonlyArray<string>,
  id: string,
  maxAssignees?: number,
): string[] {
  if (isIssueAssignee(ids, id)) return ids.filter((currentId) => !sameId(currentId, id));
  return maxAssignees === 1 ? [id] : [...ids, id];
}

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  fields.some((field) => (field ?? "").toLowerCase().includes(needle));

export function issueLabelId(label: Pick<IssueLabel, "id" | "name">): string {
  return label.id ?? label.name;
}

export function nextIssueLabels(ids: ReadonlyArray<string>, id: string): string[] {
  return ids.includes(id) ? ids.filter((selected) => selected !== id) : [...ids, id];
}

type IssuePickerKind = "labels" | "assignees";

export type IssuePickerConfirmed = {
  readonly base: IssueDetail;
  readonly environmentId: string;
  readonly kind: IssuePickerKind;
  readonly ids: ReadonlyArray<string>;
};

const nativeIssuePickerIds = (issue: IssueDetail, kind: IssuePickerKind) =>
  kind === "labels" ? issue.labels.map(issueLabelId) : issue.assignees.map(issueAssigneeId);

export function heldIssuePicker(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): IssuePickerConfirmed | null {
  if (
    confirmed === null ||
    confirmed.environmentId !== environmentId ||
    confirmed.kind !== kind ||
    confirmed.base.viewer !== issue.viewer ||
    (issue.viewer === null && confirmed.base !== issue) ||
    confirmed.base.tracker !== issue.tracker ||
    issueEntryKey(confirmed.base) !== issueEntryKey(issue)
  )
    return null;
  if (confirmed.base === issue) return confirmed;
  const native = nativeIssuePickerIds(issue, kind);
  const wanted = new Set(confirmed.ids.map((id) => (kind === "assignees" ? id.toLowerCase() : id)));
  return native.length === confirmed.ids.length &&
    native.every((id) => wanted.has(kind === "assignees" ? id.toLowerCase() : id))
    ? null
    : confirmed;
}

export function issuePickerIds(
  issue: IssueDetail,
  kind: IssuePickerKind,
  confirmed: IssuePickerConfirmed | null,
  environmentId: string,
): ReadonlyArray<string> {
  return (
    heldIssuePicker(issue, kind, confirmed, environmentId)?.ids ?? nativeIssuePickerIds(issue, kind)
  );
}

export function issueLabelOptions(
  applied: ReadonlyArray<IssueLabel>,
  fetched: ReadonlyArray<IssueLabelCandidate>,
  query: string,
): IssueLabelCandidate[] {
  const missing = applied
    .filter(
      (label) => !fetched.some((candidate) => issueLabelId(candidate) === issueLabelId(label)),
    )
    .map((label) => ({ ...label, description: null }));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((label) => matches(needle, label.name, label.description));
}

export function issueAssigneeOptions(
  current: ReadonlyArray<IssueActor>,
  fetched: ReadonlyArray<IssueAssigneeCandidate>,
  query: string,
): IssueAssigneeCandidate[] {
  const missing = current
    .map((actor) => ({ ...actor, id: issueAssigneeId(actor) }))
    .filter((actor) => !fetched.some((candidate) => sameId(candidate.id, actor.id)));
  const needle = query.toLowerCase();
  return [...fetched, ...missing].filter((candidate) =>
    matches(needle, candidate.login, candidate.name, candidate.id),
  );
}

export function linkedPullRequestTarget(
  link: IssueLinkedPullRequest,
  reference: IssueRef,
  environmentId: EnvironmentId,
  projects: ReadonlyArray<EnvironmentProject>,
  capabilities:
    | Pick<ExecutionEnvironmentCapabilities, "pullRequests" | "threadPullRequests">
    | undefined,
): IssueLinkedPullRequestTarget | null {
  const provider = sourceControlClients.find(link.provider ?? reference.tracker)?.kind;
  const parsed = parseChangeRequestUrl(link.url);
  if (provider === undefined || parsed === null || capabilities?.pullRequests !== true) return null;
  const lends = capabilities.threadPullRequests === true;
  const candidates = projects.filter(
    (project) =>
      project.environmentId === environmentId && project.repositoryIdentity?.provider === provider,
  );
  const project = lends
    ? findProjectOnChangeRequestHost(candidates, parsed)
    : findProjectForChangeRequest(candidates, parsed);
  if (project === undefined) return null;
  return {
    projectId: project.id,
    ...(lends ? { host: parsed.authority ?? parsed.host } : {}),
    repository: lends
      ? parsed.repository
      : (sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository),
    number: link.number,
    url: link.url,
  };
}

export function issueDisplayLabel(scope: string, key: string): string {
  if (key.startsWith("#")) return `${scope}${key}`;
  return /^\d+$/.test(key) ? `${scope}#${key}` : key;
}
