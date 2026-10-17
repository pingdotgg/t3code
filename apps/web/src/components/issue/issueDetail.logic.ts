import type {
  EnvironmentId,
  IssueActor,
  IssueDetail,
  IssueCapabilities,
  IssueAssigneeCandidate,
  IssueLabel,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueRef,
  IssueState,
  IssueReactionContent,
  IssueReaction,
  PullRequestRef,
} from "@t3tools/contracts";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { findProjectOnChangeRequestHost } from "../../lib/openPullRequestLink";
import { PULL_REQUEST_REACTION_ORDER } from "../pullRequest/pullRequestReactions.logic";

export function issueStateActionLabel(state: IssueState): string {
  if (state.category === "open" && state.name === "open") return "Reopen";
  if (state.category === "closed" && state.name === "closed") return "Close";
  return state.name;
}

export function sameIssueState(left: IssueState, right: IssueState): boolean {
  return (
    left.category === right.category &&
    (left.id !== undefined && right.id !== undefined
      ? left.id === right.id
      : left.name === right.name)
  );
}

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

export type IssueLinkedPullRequestTarget = Pick<
  PullRequestRef,
  "projectId" | "repository" | "number"
> & {
  host?: string;
  url: string;
};

export const issueAssigneeId = (actor: IssueActor) => actor.id ?? actor.login;

const sameAssignee = (actor: IssueActor, id: string) =>
  actor.id === undefined ? actor.login.toLowerCase() === id.toLowerCase() : actor.id === id;

export function isIssueAssignee(current: ReadonlyArray<IssueActor>, id: string): boolean {
  return current.some((actor) => sameAssignee(actor, id));
}

export function nextIssueAssignees(
  current: ReadonlyArray<IssueActor>,
  candidate: IssueAssigneeCandidate,
  maxAssignees?: number,
): string[] {
  const ids = current.map(issueAssigneeId);
  if (isIssueAssignee(current, candidate.id)) {
    return current.filter((actor) => !sameAssignee(actor, candidate.id)).map(issueAssigneeId);
  }
  return maxAssignees === 1 ? [candidate.id] : [...ids, candidate.id];
}

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  fields.some((field) => (field ?? "").toLowerCase().includes(needle));

export function issueLabelId(label: Pick<IssueLabel, "id" | "name">): string {
  return label.id ?? label.name;
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
  const wanted = new Set(confirmed.ids);
  return native.length === confirmed.ids.length &&
    (kind === "assignees"
      ? issue.assignees.every((actor) => confirmed.ids.some((id) => sameAssignee(actor, id)))
      : native.every((id) => wanted.has(id)))
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
    .filter((actor) => !fetched.some((candidate) => sameAssignee(actor, candidate.id)))
    .map((actor) => ({ ...actor, id: issueAssigneeId(actor) }));
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
): IssueLinkedPullRequestTarget | null {
  const provider = sourceControlClients.find(link.provider ?? reference.tracker)?.kind;
  const parsed = parseChangeRequestUrl(link.url);
  if (provider === undefined || parsed === null) return null;
  const project = findProjectOnChangeRequestHost(
    projects.filter(
      (project) =>
        project.environmentId === environmentId &&
        project.repositoryIdentity?.provider === provider,
    ),
    parsed,
  );
  if (project === undefined) return null;
  const host = parsed.authority ?? link.host ?? parsed.host;
  return {
    projectId: project.id,
    host,
    repository: link.repository,
    number: link.number,
    url: link.url,
  };
}

export function issueDisplayLabel(scope: string, key: string): string {
  if (key.startsWith("#")) return `${scope}${key}`;
  return /^\d+$/.test(key) ? `${scope}#${key}` : key;
}
