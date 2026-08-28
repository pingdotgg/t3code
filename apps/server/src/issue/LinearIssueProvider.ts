import * as Effect from "effect/Effect";
import type {
  IssueCapabilities,
  IssueReaction,
  IssueReactionContent,
  IssueState,
  IssueViewerPermissions,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import { IssueProviderError, type IssueAdapter, type ProviderIssue } from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  actions: [],
  closeReasons: [],
  create: false,
  issueTemplates: false,
  edit: false,
  editComment: false,
  reactions: true,
  labels: false,
  assignees: false,
  listLabelCandidates: false,
  listAssigneeCandidates: false,
  search: true,
  linkedPullRequests: false,
  timelineEvents: false,
};

const PERMISSIONS: IssueViewerPermissions = {
  actions: [],
  comment: true,
  edit: false,
  labels: false,
  assignees: false,
  create: false,
};

const EMOJI: Record<IssueReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};
const CONTENT = new Map(Object.entries(EMOJI).map(([content, emoji]) => [emoji, content] as const));

export function linearIssueState(type: string): IssueState {
  return type === "completed" || type === "canceled" || type === "duplicate" ? "closed" : "open";
}

export function linearReactions(
  reactions: ReadonlyArray<LinearApi.LinearReaction>,
  viewerId: string,
): ReadonlyArray<IssueReaction> {
  const grouped = new Map<
    IssueReactionContent,
    { actors: string[]; count: number; viewerHasReacted: boolean }
  >();
  for (const reaction of reactions) {
    const content = CONTENT.get(reaction.emoji) as IssueReactionContent | undefined;
    const actor = reaction.user?.id;
    if (content === undefined) continue;
    const group = grouped.get(content) ?? { actors: [], count: 0, viewerHasReacted: false };
    group.count += 1;
    if (actor !== undefined && !group.actors.includes(actor)) group.actors.push(actor);
    if (actor === viewerId) group.viewerHasReacted = true;
    grouped.set(content, group);
  }
  return [...grouped].map(([content, group]) => ({
    content,
    count: group.count,
    actors: group.actors,
    viewerHasReacted: group.viewerHasReacted,
  }));
}

function actor(user: LinearApi.LinearUser | null | undefined) {
  return user === null || user === undefined
    ? null
    : {
        login: user.id,
        name: user.name?.trim() || null,
        avatarUrl: user.avatarUrl?.trim() || null,
      };
}

function toIssue(issue: LinearApi.LinearIssue): ProviderIssue {
  const state = linearIssueState(issue.state.type);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: actor(issue.creator),
    state,
    stateReason: null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt:
      state === "closed" ? (issue.completedAt ?? issue.canceledAt ?? issue.updatedAt) : null,
    assignees:
      issue.assignee === null || issue.assignee === undefined ? [] : [actor(issue.assignee)!],
    labels: (issue.labels?.nodes ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? null,
    })),
    milestone: null,
    commentCount: 0,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* LinearApi.LinearApi;
  const settings = yield* ServerSettings.ServerSettingsService;

  const fail = (operation: string) => (error: LinearApi.LinearApiError) =>
    new IssueProviderError({
      provider: "linear",
      operation,
      reason: error.reason,
      detail: error.detail,
      cause: error,
    });
  const unsupported = (operation: string) =>
    Effect.fail(
      new IssueProviderError({
        provider: "linear",
        operation,
        reason: "failed",
        detail: "This Linear write is not enabled in this release.",
      }),
    );
  const identifier = (repository: string, number: number) => `${repository}-${number}`;

  return {
    kind: "linear",
    capabilities: CAPABILITIES,
    resolveSource: (project) =>
      settings.getSettings.pipe(
        Effect.map((value) => {
          const binding = value.issueTracking.linear.projectBindings[project.id];
          if (binding === null) return null;
          if (binding !== undefined) {
            return {
              host: "linear.app",
              repository: binding.teamKey,
              credentialId: binding.credentialId,
            };
          }
          const legacyTeam = value.issueTracking.linear.projectTeams[project.id];
          return legacyTeam === undefined ? null : { host: "linear.app", repository: legacyTeam };
        }),
        Effect.orElseSucceed(() => null),
      ),
    getViewer: ({ credentialId }) =>
      api.getViewer(credentialId === undefined ? {} : { credentialId }).pipe(
        Effect.map((viewer) => viewer.id),
        Effect.mapError(fail("getViewer")),
      ),
    listIssues: (input) =>
      api
        .listIssues({
          teamKey: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { updatedBefore: input.cursor.updatedBefore }),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("listIssues")),
          Effect.map(({ issues, truncated }) => ({
            items: issues.map(toIssue),
            truncated,
            continues: true,
          })),
        ),
    getIssue: (input) =>
      api
        .getIssue({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssue")),
          Effect.map((issue) => ({
            ...toIssue(issue),
            body: issue.description ?? "",
            linkedPullRequests: [],
            viewerPermissions: PERMISSIONS,
          })),
        ),
    getIssueActivity: (input) =>
      api
        .getActivity({
          identifier: identifier(input.repository, input.number),
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(
          Effect.mapError(fail("getIssueActivity")),
          Effect.map((activity) => ({
            comments: activity.comments.map((comment) => ({
              id: comment.id,
              author: actor(comment.user),
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url ?? null,
              reactions: linearReactions(comment.reactions ?? [], activity.viewerId),
            })),
            commentCount: activity.comments.length,
            commentsTruncated: activity.commentsTruncated,
            events: [],
            reactions: linearReactions(activity.reactions, activity.viewerId),
          })),
        ),
    getViewerPermissions: () => Effect.succeed(PERMISSIONS),
    runAction: () => unsupported("runAction"),
    comment: (input) =>
      api
        .comment({
          issueId: identifier(input.repository, input.number),
          body: input.body,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("comment"))),
    setReaction: (input) =>
      api
        .setReaction({
          issueId: identifier(input.repository, input.number),
          ...(input.subjectId === undefined ? {} : { commentId: input.subjectId }),
          emoji: EMOJI[input.content],
          reacted: input.reacted,
          ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        })
        .pipe(Effect.mapError(fail("setReaction"))),
    create: () => unsupported("create"),
    update: () => unsupported("update"),
    setLabels: () => unsupported("setLabels"),
    setAssignees: () => unsupported("setAssignees"),
    listLabelCandidates: () => unsupported("listLabelCandidates"),
    listAssigneeCandidates: () => unsupported("listAssigneeCandidates"),
  } satisfies IssueAdapter;
});
