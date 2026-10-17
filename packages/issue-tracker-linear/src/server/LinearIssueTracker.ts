/**
 * Linear as an issue tracker. An issue key is its identifier
 * (`ENG-123`), and Linear's workflow states travel by name with the category read off their
 * type. Closing picks
 * the team's first state of the matching type, which is what Linear's own "Done" and "Canceled"
 * buttons do.
 *
 * Templates: a plain template becomes a draft here; one with form fields or rich (non-markdown)
 * content opens the exact template in Linear instead, through the template list's contact links.
 *
 * @module issue-tracker-linear/server/LinearIssueTracker
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderKind,
  type IssueCapabilities,
  type IssueComment,
  type IssueEvent,
  type IssueExternalTemplate,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueReaction,
  type IssueReactionContent,
  type IssueState,
  type IssueWorkflowCategory,
  type IssueRelation,
  type IssuePageInput,
  type IssueListOrder,
  type IssueTemplate,
  type IssueViewerPermissions,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
  type IssueTarget,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as LinearApi from "./LinearApi.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: LinearApi.KIND,
  displayName: "Linear",
  host: "linear.app",
  scopeNoun: "team",
  credential: {
    label: "Personal API key",
    helpUrl: "https://linear.app/settings/account/security",
  },
};

/**
 * Only the two categories here: Linear's actual columns differ per team and are offered to the
 * detail page through `getIssue`'s states.
 * The driver maps `open` to the team's default state and `closed` to its first completed state,
 * with `canceled` as the close reason for its first canceled state.
 */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  listSorts: ["created", "updated"],
  listOrders: ["asc", "desc"],
  labels: true,
  assignees: true,
  maxAssignees: 1,
  involvements: ["all", "assigned", "authored"],
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  closeReasons: ["completed", "canceled"],
};

/** Everything granted: Linear's API reports no per-issue permissions and refuses with a message. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const decodeActivityCursor = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const COMMENTS_PAGE = 50;
const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"];

/** Linear reacts with the emoji itself; GitHub's names are the contract's vocabulary. */
const EMOJI_BY_CONTENT: Record<IssueReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};
const CONTENT_BY_EMOJI = new Map(
  Object.entries(EMOJI_BY_CONTENT).map(([content, emoji]) => [
    emoji,
    content as IssueReactionContent,
  ]),
);

/** `ENG-123`, or null for anything that is not a Linear identifier. */
function parseIdentifier(key: string): string | null {
  return /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(key.trim()) ? key.trim().toUpperCase() : null;
}

function parseScope(scope: string) {
  const match = /^(?:([^/\s]+)\/)?([A-Za-z][A-Za-z0-9]*)$/u.exec(scope.trim());
  return match === null
    ? null
    : { workspace: match[1]?.toLowerCase(), team: match[2]!.toUpperCase() };
}

function issueWorkspace(url: string): string | null {
  try {
    const native = new URL(url);
    return native.protocol === "https:" && native.host === "linear.app"
      ? (native.pathname.split("/")[1]?.toLowerCase() ?? null)
      : null;
  } catch {
    return null;
  }
}

function toState(state: LinearApi.LinearWorkflowState): IssueState {
  const category =
    state.type === "triage" ? "backlog" : state.type === "duplicate" ? "canceled" : state.type;
  const workflowCategory: IssueWorkflowCategory =
    category === "unstarted" ||
    category === "started" ||
    category === "completed" ||
    category === "canceled"
      ? category
      : "backlog";
  return {
    id: state.id,
    name: state.name,
    workflowCategory,
    category: CLOSED_STATE_TYPES.includes(state.type) ? "closed" : "open",
    ...(CLOSED_STATE_TYPES.includes(state.type) ? { closeReason: state.type } : {}),
  };
}

function toActor(user: LinearApi.LinearUser) {
  const name = user.displayName?.trim() || user.name?.trim() || null;
  return {
    id: user.id,
    login: name ?? user.id,
    name,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/** How a user shows in a picker and an event: display name first, falling back to the id. */
function userName(user: LinearApi.LinearUser): string {
  return user.displayName ?? user.name ?? user.email ?? user.id;
}

/** Linear's connections report no totals, so a listing shows no comment count. */
function toSummary(
  issue: LinearApi.LinearIssue,
  commentCount: TrackerIssueSummary["commentCount"] = null,
  viewerId: string | null = null,
) {
  const reactions = issue.reactions === undefined ? null : toReactions(issue.reactions, viewerId);
  return {
    key: issue.identifier,
    displayKey: issue.identifier,
    title: issue.title,
    url: issue.url,
    author: issue.creator === null ? null : toActor(issue.creator),
    state: toState(issue.state),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.completedAt ?? issue.canceledAt ?? null,
    assignees: issue.assignee === null ? [] : [toActor(issue.assignee)],
    labels: issue.labels.nodes.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
    })),
    labelsTruncated: issue.labels.pageInfo.hasNextPage,
    milestone: issue.projectMilestone?.name ?? null,
    commentCount,
    ...(reactions === null
      ? {}
      : { reactions: reactions.values, reactionsTruncated: reactions.truncated }),
  };
}

function toReactions(reactions: ReadonlyArray<LinearApi.LinearReaction>, viewerId: string | null) {
  const grouped = new Map<
    IssueReactionContent,
    { count: number; actors: string[]; viewerHasReacted: boolean }
  >();
  let truncated = false;
  for (const reaction of reactions) {
    const content = CONTENT_BY_EMOJI.get(reaction.emoji);
    if (content === undefined) continue;
    const mine = reaction.user !== null && reaction.user.id === viewerId;
    let group = grouped.get(content);
    if (group === undefined) {
      group = { count: 0, actors: [], viewerHasReacted: false };
      grouped.set(content, group);
    }
    group.count++;
    group.viewerHasReacted ||= mine;
    if (reaction.user !== null && !mine) {
      if (group.actors.length < 20) group.actors.push(userName(reaction.user));
      else truncated = true;
    }
  }
  const values: IssueReaction[] = [...grouped].map(([content, group]) => ({ content, ...group }));
  return { values, truncated };
}

function toComment(comment: LinearApi.LinearComment, viewerId: string | null): IssueComment {
  const reactions = toReactions(comment.reactions, viewerId);
  return {
    id: comment.id,
    author: comment.user === null ? null : toActor(comment.user),
    body: comment.body,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt ?? null,
    canEdit: viewerId !== null && comment.user?.id === viewerId,
    url: comment.url,
    reactions: reactions.values,
    reactionsTruncated: reactions.truncated,
  };
}

function toEvents(history: ReadonlyArray<LinearApi.LinearHistoryEntry>): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const entry of history) {
    const before = events.length;
    const actor = entry.actor === null ? null : toActor(entry.actor);
    const add = (kind: IssueEvent["kind"], detail: string | null, suffix: string) =>
      events.push({ id: `${entry.id}:${suffix}`, kind, actor, createdAt: entry.createdAt, detail });
    if (entry.toState !== null && entry.toState.id !== entry.fromState?.id) {
      const wasClosed =
        entry.fromState !== null && CLOSED_STATE_TYPES.includes(entry.fromState.type);
      const isClosed = CLOSED_STATE_TYPES.includes(entry.toState.type);
      add(
        isClosed && !wasClosed ? "closed" : wasClosed && !isClosed ? "reopened" : "state-changed",
        entry.toState.name,
        "state",
      );
    }
    for (const label of entry.addedLabels ?? []) add("labeled", label.name, `label+${label.id}`);
    for (const label of entry.removedLabels ?? [])
      add("unlabeled", label.name, `label-${label.id}`);
    if (entry.fromAssignee !== null && entry.fromAssignee.id !== entry.toAssignee?.id)
      add("unassigned", userName(entry.fromAssignee), "unassigned");
    if (entry.toAssignee !== null && entry.toAssignee.id !== entry.fromAssignee?.id)
      add("assigned", userName(entry.toAssignee), "assigned");
    if (entry.toTitle !== null && entry.toTitle !== entry.fromTitle)
      add("renamed", entry.toTitle, "title");
    if (events.length === before) add("updated", "Issue updated", "updated");
  }
  return events;
}

const PULL_REQUEST_URL =
  /^https:\/\/(?:github\.com\/([^/]+\/[^/]+)\/pull|gitlab\.com\/(.+?)\/-\/merge_requests)\/(\d+)\/?(?:[?#]|$)/u;

/** Linear's GitHub and GitLab integrations record change requests as attachments. */
function toLinkedPullRequests(
  attachments: ReadonlyArray<LinearApi.LinearAttachment>,
): IssueLinkedPullRequest[] {
  const seen = new Set<string>();
  return attachments.flatMap((attachment) => {
    const match = PULL_REQUEST_URL.exec(attachment.url);
    if (match === null || seen.has(attachment.url)) return [];
    seen.add(attachment.url);
    const status = attachment.metadata?.status;
    return [
      {
        repository: match[1] ?? match[2]!,
        provider: SourceControlProviderKind.make(match[1] === undefined ? "gitlab" : "github"),
        host: match[1] === undefined ? "gitlab.com" : "github.com",
        number: Number(match[3]),
        title: attachment.title.trim() || attachment.url,
        url: attachment.url,
        state:
          status === "open" || status === "closed" || status === "merged"
            ? status
            : status === "draft"
              ? "open"
              : null,
        isDraft: status === "draft" || attachment.metadata?.draft === true,
        closesIssue: false,
      } as const,
    ];
  });
}

/**
 * A template the composer can hold: markdown content, no form fields. Anything else is offered
 * as a link into Linear, where the exact template renders.
 */
export function toTemplate(
  template: LinearApi.LinearTemplate,
  teamKey: string,
): { readonly template: IssueTemplate } | { readonly link: IssueExternalTemplate } {
  const data = template.templateData;
  const body = template.content ?? (typeof data.description === "string" ? data.description : null);
  if (
    template.hasFormFields ||
    (body === null &&
      (data.descriptionData != null ||
        (data.description != null && typeof data.description !== "string")))
  ) {
    const url = new URL(`https://linear.app/team/${encodeURIComponent(teamKey)}/new`);
    url.searchParams.set("template", template.id);
    return { link: { name: template.name, about: template.description ?? "", url: url.href } };
  }
  return {
    template: {
      key: template.id,
      name: template.name,
      about: template.description ?? "",
      title: data.title ?? "",
      body: body ?? "",
      labels: data.labelIds ?? [],
      assignees: data.assigneeId ? [data.assigneeId] : [],
    },
  };
}

function involvementFilter(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
}): Record<string, unknown> {
  switch (input.involvement) {
    case "assigned":
      return { assignee: { id: { eq: input.viewer } } };
    case "authored":
      return { creator: { id: { eq: input.viewer } } };
    case "mentioned":
    case "all":
      return {};
  }
}

const notFound = (operation: string) =>
  new IssueTrackerError({
    tracker: LinearApi.KIND,
    operation,
    reason: "not-found",
    detail: "Linear has no issue by that identifier, or this account cannot see it.",
  });

const failed = (operation: string, detail: string) =>
  new IssueTrackerError({ tracker: LinearApi.KIND, operation, reason: "failed", detail });

export const make: Effect.Effect<StandaloneIssueTrackerApi, never, LinearApi.LinearApi> =
  Effect.gen(function* () {
    const linear = yield* LinearApi.LinearApi;

    const requireIdentifier = (operation: string, key: string) => {
      const identifier = parseIdentifier(key);
      return identifier === null ? Effect.fail(notFound(operation)) : Effect.succeed(identifier);
    };
    const requireScope = (operation: string, scope: string) =>
      Effect.gen(function* () {
        const parsed = parseScope(scope);
        if (parsed === null) return yield* failed(operation, "This Linear team scope is invalid.");
        return parsed;
      });
    const requireWorkspace = (operation: string, scope: string, workspace: string) =>
      requireScope(operation, scope).pipe(
        Effect.flatMap((parsed) =>
          parsed.workspace !== undefined && parsed.workspace !== workspace.toLowerCase()
            ? Effect.fail(failed(operation, "This scope belongs to another Linear workspace."))
            : Effect.void,
        ),
      );
    const requireIssueReference = <T extends LinearApi.LinearIssueReference>(
      operation: string,
      scope: string,
      reference: T | null,
    ) =>
      requireScope(operation, scope).pipe(
        Effect.flatMap((parsed) =>
          reference === null
            ? Effect.fail(notFound(operation))
            : reference.team.key.toUpperCase() !== parsed.team ||
                (parsed.workspace !== undefined &&
                  issueWorkspace(reference.url) !== parsed.workspace)
              ? Effect.fail(
                  failed(operation, "This issue belongs to another Linear team or workspace."),
                )
              : Effect.succeed(reference),
        ),
      );
    const resolveIssue = (operation: string, key: string, scope: string) =>
      requireIdentifier(operation, key).pipe(
        Effect.flatMap(linear.getIssueReference),
        Effect.flatMap((reference) => requireIssueReference(operation, scope, reference)),
      );

    const resolveParent = (operation: string, key: string, workspace: string | null) =>
      requireIdentifier(operation, key).pipe(
        Effect.flatMap(linear.getIssueReference),
        Effect.flatMap((parent) =>
          parent === null
            ? Effect.fail(notFound(operation))
            : workspace === null || issueWorkspace(parent.url) !== workspace.toLowerCase()
              ? Effect.fail(failed(operation, "This parent belongs to another Linear workspace."))
              : Effect.succeed(parent),
        ),
      );

    const requireTeam = (operation: string, scope: string, includeAncestorLabels = false) =>
      requireScope(operation, scope).pipe(
        Effect.flatMap((parsed) => linear.getTeam(parsed.team, includeAncestorLabels)),
        Effect.filterOrFail(
          (team): team is LinearApi.LinearTeamScope => team !== null,
          () => failed(operation, `No Linear team has the key "${scope}".`),
        ),
        Effect.tap((team) => requireWorkspace(operation, scope, team.organization.urlKey)),
      );

    /** Names to label ids, within the team's and the workspace's labels. */
    const labelIds = (
      operation: string,
      scope: LinearApi.LinearTeamScope,
      names: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const labels = [
          ...new Map(
            [
              ...scope.team.labels.nodes,
              ...scope.team.ancestors.flatMap((ancestor) => ancestor.labels?.nodes ?? []),
              ...scope.workspaceLabels,
            ].map((label) => [label.id, label]),
          ).values(),
        ];
        const unresolved = [...new Set(names)].filter(
          (name) =>
            !labels.some(
              (label) =>
                label.id === name || label.name.toLowerCase() === name.trim().toLowerCase(),
            ),
        );
        if (scope.labelsTruncated && unresolved.length > 0) {
          if (unresolved.length > 200)
            return yield* failed(operation, "Choose at most 200 additional Linear labels.");
          const found = yield* linear.listLabelCandidates({
            key: scope.team.key,
            first: unresolved.length,
            ids: unresolved,
            teamIds: [scope.team.id, ...scope.team.ancestors.map((ancestor) => ancestor.id)],
          });
          if (
            found.organization.id !== scope.organization.id ||
            found.teams.nodes[0]?.id !== scope.team.id ||
            found.issueLabels.pageInfo.hasNextPage ||
            found.issueLabels.nodes.length !== unresolved.length ||
            unresolved.some(
              (id) => !found.issueLabels.nodes.some((label) => label.id === id && !label.isGroup),
            ) ||
            found.issueLabels.nodes.some((label) => !unresolved.includes(label.id))
          )
            return yield* failed(operation, "Choose labels available to this Linear team.");
          labels.push(...found.issueLabels.nodes);
        }
        return yield* Effect.forEach(names, (name) => {
          const byId = labels.find((label) => !label.isGroup && label.id === name);
          if (byId !== undefined) return Effect.succeed(byId.id);
          const matches = labels.filter(
            (label) => !label.isGroup && label.name.toLowerCase() === name.trim().toLowerCase(),
          );
          if (matches.length > 1 || scope.labelsTruncated)
            return Effect.fail(
              failed(
                operation,
                `Use a label ID. "${name}" is ambiguous, or the label list is incomplete.`,
              ),
            );
          return matches[0] === undefined
            ? Effect.fail(
                failed(operation, `Linear has no applicable label named "${name}" for this team.`),
              )
            : Effect.succeed(matches[0].id);
        });
      });

    const teamAssignees = (operation: string, scope: LinearApi.LinearTeamScope) =>
      Effect.gen(function* () {
        if (scope.team.visibility === "private") return scope.team.members;
        const result = yield* linear.listAssigneeCandidates({
          key: scope.team.key,
          visibility: scope.team.visibility,
          membershipTeamIds: scope.assigneeTeamIds,
          first: 250,
        });
        const team = result.teams.nodes[0];
        if (
          result.organization.id !== scope.organization.id ||
          result.organization.urlKey !== scope.organization.urlKey ||
          team?.id !== scope.team.id
        )
          return yield* failed(operation, "This Linear team or workspace changed.");
        return team.members;
      });

    /** One assignee at most: Linear issues have a single assignee. */
    const assigneeId = (
      operation: string,
      scope: LinearApi.LinearTeamScope,
      assignees: ReadonlyArray<string>,
    ): Effect.Effect<string | null, IssueTrackerError> =>
      Effect.gen(function* () {
        const [first, ...rest] = assignees;
        if (first === undefined) return null;
        if (rest.length > 0)
          return yield* failed(operation, "A Linear issue has one assignee at most.");
        const members = yield* teamAssignees(operation, scope);
        const byId = members.nodes.find((user) => user.id === first);
        if (byId !== undefined) return byId.id;
        const matches = members.nodes.filter(
          (user) =>
            user.email?.toLowerCase() === first.toLowerCase() ||
            user.displayName?.toLowerCase() === first.toLowerCase(),
        );
        if (matches.length === 0 && members.pageInfo.hasNextPage) {
          const found = yield* linear.listAssigneeCandidates({
            key: scope.team.key,
            visibility: scope.team.visibility,
            membershipTeamIds: scope.assigneeTeamIds,
            first: 1,
            id: first,
          });
          const team = found.teams.nodes[0];
          if (
            found.organization.id !== scope.organization.id ||
            found.organization.urlKey !== scope.organization.urlKey ||
            team?.id !== scope.team.id ||
            team.members.pageInfo.hasNextPage ||
            team.members.nodes.length !== 1 ||
            team.members.nodes[0]?.id !== first
          )
            return yield* failed(operation, "Choose an active assignee for this Linear team.");
          return first;
        }
        if (matches.length > 1 || members.pageInfo.hasNextPage)
          return yield* failed(
            operation,
            "Use a member ID. The name or email is ambiguous, or the member list is incomplete.",
          );
        return matches[0] === undefined
          ? yield* failed(operation, `"${first}" is not an active assignee for this Linear team.`)
          : matches[0].id;
      });

    const viewerId: Effect.Effect<string | null> = linear.viewer().pipe(
      Effect.map((data) => data.viewer.id),
      Effect.orElseSucceed(() => null),
    );

    const pageInput = (operation: string, input: IssuePageInput) => {
      const limit = input.limit ?? 100;
      return !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
        ? Effect.fail(failed(operation, "Invalid Linear page."))
        : Effect.succeed(limit);
    };
    const pageCursor = <T>(
      operation: string,
      input: IssuePageInput,
      connection: {
        readonly nodes: ReadonlyArray<T>;
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      },
    ) =>
      connection.nodes.length > (input.limit ?? 100) ||
      (connection.pageInfo.hasNextPage &&
        (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === input.cursor))
        ? Effect.fail(failed(operation, "Linear returned an inconsistent page."))
        : Effect.succeed(connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null);
    const activityIdentity = (
      operation: "getComments" | "getHistory",
      input: IssueTarget & {
        readonly order?: IssueListOrder | undefined;
        readonly limit?: number | undefined;
      },
    ) =>
      JSON.stringify([
        "linear-activity-v1",
        operation,
        input.cwd,
        input.host.toLowerCase(),
        input.scope.toLowerCase(),
        input.key.toUpperCase(),
        input.connectionId ?? null,
        input.order ?? "desc",
        operation === "getComments" ? COMMENTS_PAGE : (input.limit ?? 100),
      ]);
    const activityCursor = (
      operation: "getComments" | "getHistory",
      input: IssueTarget & {
        readonly cursor?: string | undefined;
        readonly order?: IssueListOrder | undefined;
        readonly limit?: number | undefined;
      },
    ) =>
      input.cursor === undefined
        ? Effect.succeed<string | undefined>(undefined)
        : decodeActivityCursor(input.cursor).pipe(
            Effect.filterOrFail(
              ([identity, cursor]) =>
                identity === activityIdentity(operation, input) &&
                cursor.trim().length > 0 &&
                cursor.length <= 4096,
              () =>
                failed(
                  operation,
                  "The activity cursor does not match this issue, account or order.",
                ),
            ),
            Effect.map(([, cursor]) => cursor),
            Effect.mapError(() =>
              failed(operation, "The activity cursor does not match this issue, account or order."),
            ),
          );
    const activityNext = (
      operation: "getComments" | "getHistory",
      input: IssueTarget & {
        readonly order?: IssueListOrder | undefined;
        readonly limit?: number | undefined;
      },
      cursor: string | null,
    ) => (cursor === null ? null : JSON.stringify([activityIdentity(operation, input), cursor]));
    const relation = (native: LinearApi.LinearRelation, scope: string): IssueRelation => {
      const selected = parseScope(scope);
      const workspace = issueWorkspace(native.url);
      const sameScope =
        selected?.team === native.team.key.toUpperCase() &&
        (selected.workspace === undefined || selected.workspace === workspace);
      return {
        scope: sameScope
          ? scope
          : workspace === null
            ? native.team.key
            : `${workspace}/${native.team.key}`,
        key: native.identifier,
        displayKey: native.identifier,
        title: native.title,
        url: native.url,
        state: toState(native.state),
      };
    };

    const api: StandaloneIssueTrackerApi = {
      kind: LinearApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,

      probeCredential: (token) =>
        linear.probeCredential(token).pipe(
          Effect.map((data) => ({
            account: userName(data.viewer),
            accountId: `${data.organization.id}/${data.viewer.id}`,
            scopes: data.teams.map((team) => ({
              key: `${data.organization.urlKey}/${team.key}`,
              name: team.name,
            })),
            scopesTruncated: data.scopesTruncated,
            scopesCursor: data.scopesCursor,
          })),
        ),
      listScopes: (token, input) =>
        linear.listScopes(token, input).pipe(
          Effect.map((page) => ({
            items: page.teams.map((team) => ({
              key: `${page.organization.urlKey}/${team.key}`,
              name: team.name,
            })),
            nextCursor: page.nextCursor,
          })),
        ),
      getScope: (token, scope) =>
        requireScope("getScope", scope).pipe(
          Effect.flatMap((parsed) =>
            linear
              .getScope(parsed.team, token)
              .pipe(
                Effect.map((team) =>
                  team === null ||
                  (parsed.workspace !== undefined &&
                    parsed.workspace !== team.organization.urlKey.toLowerCase())
                    ? null
                    : { key: `${team.organization.urlKey}/${team.key}`, name: team.name },
                ),
              ),
          ),
        ),

      // The id, not the display name: it is what the involvement filters compare against.
      getViewer: () => linear.viewer().pipe(Effect.map((data) => data.viewer.id)),

      listIssues: (input) => {
        if (input.involvement === "mentioned" || input.sort === "comments")
          return Effect.fail(
            failed("listIssues", "Linear does not support mentions or sorting by comment count."),
          );
        return Effect.gen(function* () {
          const scope = yield* requireScope("listIssues", input.scope);
          if (input.stateCategories?.length === 0) return { items: [], nextCursor: null };
          const filter: Record<string, unknown> = {
            team: { key: { eq: scope.team } },
            ...involvementFilter(input),
          };
          if (input.stateCategories !== undefined && input.stateCategories.length > 0) {
            filter.state = {
              type: {
                in: [
                  ...new Set(
                    input.stateCategories.flatMap((category) =>
                      category === "backlog"
                        ? ["backlog", "triage"]
                        : category === "canceled"
                          ? ["canceled", "duplicate"]
                          : [category],
                    ),
                  ),
                ],
              },
            };
          } else if (input.state !== "all") {
            filter.state = {
              type: { [input.state === "closed" ? "in" : "nin"]: CLOSED_STATE_TYPES },
            };
          }
          if (input.query !== undefined) {
            const or: unknown[] = [
              { title: { containsIgnoreCase: input.query } },
              { description: { containsIgnoreCase: input.query } },
            ];
            // `ENG-12`, `#12` or `12` asks for one issue of this team by number.
            const reference = /^(?:([A-Za-z][A-Za-z0-9]*)-|#)?(\d+)$/.exec(input.query.trim());
            if (
              reference !== null &&
              (reference[1] === undefined || reference[1].toUpperCase() === scope.team)
            )
              or.push({ number: { eq: Number(reference[2]) } });
            filter.or = or;
          }
          const page = yield* linear.listIssues({
            filter,
            first: input.limit,
            after: input.cursor,
            sort: input.sort === "created" ? "created" : "updated",
            order: input.order ?? "desc",
          });
          yield* requireWorkspace("listIssues", input.scope, page.organization.urlKey);
          const issues = yield* Effect.forEach(page.nodes, (issue) =>
            requireIssueReference("listIssues", input.scope, issue),
          );
          if (page.nextCursor !== null && page.nextCursor === input.cursor)
            return yield* failed("listIssues", "Linear returned an inconsistent page.");
          return {
            items: issues.map((issue) => toSummary(issue, null, page.viewerId)),
            nextCursor: page.nextCursor,
          };
        });
      },

      getIssue: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("getIssue", input.key);
          const [nativeIssue, viewer] = yield* Effect.all([
            linear.getIssue(identifier, COMMENTS_PAGE),
            viewerId,
          ]);
          const issue = yield* requireIssueReference("getIssue", input.scope, nativeIssue);
          return {
            ...toSummary(
              issue,
              issue.comments.pageInfo.hasNextPage ? null : issue.comments.nodes.length,
              viewer,
            ),
            body: issue.description ?? "",
            ...(issue.team.states === undefined
              ? {}
              : { states: issue.team.states.nodes.map(toState) }),
            viewer,
            viewerPermissions: VIEWER_PERMISSIONS,
            comments: issue.comments.nodes.map((comment) => toComment(comment, viewer)),
            commentsCursor: activityNext(
              "getComments",
              input,
              issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null,
            ),
            events: toEvents(issue.history.nodes),
            historyTruncated: issue.history.pageInfo.hasNextPage,
            linkedPullRequests: toLinkedPullRequests(issue.attachments.nodes),
          };
        }),

      getComments: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("getComments", input.key);
          const cursor = yield* activityCursor("getComments", input);
          const page = yield* linear.getComments({
            identifier,
            first: COMMENTS_PAGE,
            after: cursor,
            order: input.order ?? "desc",
          });
          const viewer = input.viewer ?? null;
          yield* requireIssueReference("getComments", input.scope, page.issue);
          if (page.nextCursor !== null && page.nextCursor === cursor)
            return yield* failed("getComments", "Linear returned an inconsistent page.");
          return {
            comments: page.nodes.map((comment) => toComment(comment, viewer)),
            nextCursor: activityNext("getComments", input, page.nextCursor),
          };
        }),

      getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

      create: (input) =>
        Effect.gen(function* () {
          const scope = yield* requireTeam("create", input.scope, input.labels.length > 0);
          const labels = yield* labelIds("create", scope, input.labels);
          const assignee = yield* assigneeId("create", scope, input.assignees);
          const parent =
            input.parentKey === undefined
              ? null
              : yield* resolveParent("create", input.parentKey, scope.organization.urlKey);
          if (
            input.templateKey !== undefined &&
            !scope.templates.some(
              (template) =>
                template.id === input.templateKey &&
                template.type === "issue" &&
                "template" in toTemplate(template, scope.team.key),
            )
          )
            return yield* failed("create", "Choose an available plain Linear issue template.");
          const created = yield* linear.createIssue({
            teamId: scope.team.id,
            title: input.title,
            description: input.body,
            labelIds: labels,
            ...(parent === null ? {} : { parentId: parent.id }),
            ...(input.templateKey === undefined ? {} : { templateId: input.templateKey }),
            assigneeId: assignee,
          });
          return {
            key: created.identifier,
            displayKey: created.identifier,
            url: created.url,
            ...(parent === null ? {} : { parentLinked: true }),
          };
        }),

      comment: (input) =>
        Effect.gen(function* () {
          const issue = yield* resolveIssue("comment", input.key, input.scope);
          yield* linear.createComment({ issueId: issue.id, body: input.body });
        }),

      editComment: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("editComment", input.key);
          const selected = yield* linear.getCommentTarget(identifier, input.commentId);
          const issue = yield* requireIssueReference("editComment", input.scope, selected.issue);
          if (selected.comment === null || selected.comment.issue?.id !== issue.id)
            return yield* notFound("editComment");
          yield* requireIssueReference("editComment", input.scope, selected.comment.issue);
          yield* linear.updateComment(selected.comment.id, input.body);
        }),
      setParent: (input) =>
        Effect.gen(function* () {
          const selected = yield* resolveIssue("setParent", input.key, input.scope);
          const parent =
            input.parentKey === null
              ? null
              : yield* resolveParent("setParent", input.parentKey, issueWorkspace(selected.url));
          if (parent?.id === selected.id)
            return yield* failed("setParent", "An issue cannot be its own parent.");
          yield* linear.updateIssue(selected.id, { parentId: parent?.id ?? null });
        }),
      getHierarchy: (input) =>
        Effect.gen(function* () {
          const first = yield* pageInput("getHierarchy", input);
          const identifier = yield* requireIdentifier("getHierarchy", input.key);
          const result = yield* linear.getHierarchy({ identifier, first, after: input.cursor });
          const selected = yield* requireIssueReference("getHierarchy", input.scope, result.issue);
          const nextCursor = yield* pageCursor("getHierarchy", input, selected.children);
          return {
            parent: selected.parent === null ? null : relation(selected.parent, input.scope),
            children: {
              items: selected.children.nodes.map((value) => relation(value, input.scope)),
              nextCursor,
            },
          };
        }),
      getHistory: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("getHistory", input.key);
          const cursor = yield* activityCursor("getHistory", input);
          const first = yield* pageInput("getHistory", { ...input, cursor });
          const result = yield* linear.getHistory({
            identifier,
            first,
            after: cursor,
            order: input.order ?? "desc",
          });
          const selected = yield* requireIssueReference("getHistory", input.scope, result.issue);
          const history = selected.history;
          const backward = input.order === "asc";
          const more = backward ? history.pageInfo.hasPreviousPage : history.pageInfo.hasNextPage;
          const next = backward ? history.pageInfo.startCursor : history.pageInfo.endCursor;
          if (
            more === undefined ||
            history.nodes.length > first ||
            (more && (!next?.trim() || next === cursor || history.nodes.length === 0))
          )
            return yield* failed("getHistory", "Linear returned an inconsistent page.");
          return {
            items: toEvents(backward ? history.nodes.toReversed() : history.nodes),
            nextCursor: activityNext("getHistory", input, more ? next! : null),
          };
        }),
      getLinkedPullRequests: (input) =>
        Effect.gen(function* () {
          const first = yield* pageInput("getLinkedPullRequests", input);
          const identifier = yield* requireIdentifier("getLinkedPullRequests", input.key);
          const result = yield* linear.getAttachments({ identifier, first, after: input.cursor });
          const selected = yield* requireIssueReference(
            "getLinkedPullRequests",
            input.scope,
            result.issue,
          );
          return {
            items: toLinkedPullRequests(selected.attachments.nodes),
            nextCursor: yield* pageCursor("getLinkedPullRequests", input, selected.attachments),
          };
        }),
      listLabelCandidates: (input) =>
        Effect.gen(function* () {
          const first = yield* pageInput("listLabelCandidates", input);
          const scope = yield* requireTeam("listLabelCandidates", input.scope);
          const result = yield* linear.listLabelCandidates({
            key: scope.team.key,
            teamIds: [scope.team.id, ...scope.team.ancestors.map((ancestor) => ancestor.id)],
            first,
            after: input.cursor,
          });
          yield* requireWorkspace("listLabelCandidates", input.scope, result.organization.urlKey);
          if (
            result.teams.nodes[0]?.id !== scope.team.id ||
            result.organization.id !== scope.organization.id
          )
            return yield* notFound("listLabelCandidates");
          return {
            items: result.issueLabels.nodes
              .filter((label) => !label.isGroup && label.archivedAt == null)
              .map((label) => ({
                id: label.id,
                name: label.name,
                color: label.color,
                description: label.description ?? null,
              })),
            nextCursor: yield* pageCursor("listLabelCandidates", input, result.issueLabels),
          };
        }),
      listAssigneeCandidates: (input) =>
        Effect.gen(function* () {
          const first = yield* pageInput("listAssigneeCandidates", input);
          const scope = yield* requireScope("listAssigneeCandidates", input.scope);
          const result = yield* linear.listAssigneeCandidates({
            key: scope.team,
            workspace: scope.workspace,
            first,
            after: input.cursor,
          });
          yield* requireWorkspace(
            "listAssigneeCandidates",
            input.scope,
            result.organization.urlKey,
          );
          const team = result.teams.nodes[0];
          if (team?.key.toUpperCase() !== scope.team)
            return yield* notFound("listAssigneeCandidates");
          return {
            items: team.members.nodes.map(toActor),
            nextCursor: yield* pageCursor("listAssigneeCandidates", input, team.members),
          };
        }),
      update: (input) =>
        Effect.gen(function* () {
          const issue = yield* resolveIssue("update", input.key, input.scope);
          const patch: Record<string, unknown> = {};
          if (input.title !== undefined) patch.title = input.title;
          if (input.body !== undefined) patch.description = input.body;
          if (input.labels !== undefined || input.assignees !== undefined) {
            const scope = yield* requireTeam(
              "update",
              input.scope,
              (input.labels?.length ?? 0) > 0,
            );
            if (input.labels !== undefined)
              patch.labelIds = yield* labelIds("update", scope, input.labels);
            if (input.assignees !== undefined)
              patch.assigneeId = yield* assigneeId("update", scope, input.assignees);
          }
          yield* linear.updateIssue(issue.id, patch);
        }),

      setState: (input) =>
        Effect.gen(function* () {
          const issue = yield* resolveIssue("setState", input.key, input.scope);
          const parsed = yield* requireScope("setState", input.scope);
          const scope = yield* linear.getTeamStates(parsed.team);
          if (scope === null) return yield* failed("setState", "This Linear team is unavailable.");
          yield* requireWorkspace("setState", input.scope, scope.organization.urlKey);
          if (scope.states.pageInfo.hasNextPage)
            return yield* failed(
              "setState",
              "This team has more workflow states than the supported limit.",
            );
          const states = scope.states.nodes.toSorted(
            (a, b) => (a.position ?? 0) - (b.position ?? 0),
          );
          const wanted =
            states.find((state) => state.id === input.state || state.name === input.state) ??
            (input.state === "closed"
              ? states.find((state) => state.type === (input.closeReason ?? "completed"))
              : input.state === "open"
                ? (states.find((state) => state.type === "unstarted") ??
                  states.find((state) => state.type === "backlog") ??
                  states.find((state) => state.type === "triage"))
                : undefined);
          if (wanted === undefined)
            return yield* failed("setState", "This team has no workflow state for that change.");
          yield* linear.updateIssue(issue.id, { stateId: wanted.id });
        }),

      setReaction: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("setReaction", input.key);
          const emoji = EMOJI_BY_CONTENT[input.content];
          let target: { issueId?: string; commentId?: string };
          if (input.subjectId === undefined) {
            const issue = yield* resolveIssue("setReaction", identifier, input.scope);
            target = { issueId: issue.id };
          } else {
            const resolved = yield* linear.getCommentTarget(identifier, input.subjectId);
            const issue = yield* requireIssueReference("setReaction", input.scope, resolved.issue);
            if (resolved.comment === null || resolved.comment.issue?.id !== issue.id)
              return yield* notFound("setReaction");
            yield* requireIssueReference("setReaction", input.scope, resolved.comment.issue);
            target = { commentId: resolved.comment.id };
          }
          if (input.reacted) {
            yield* linear.createReaction({ ...target, emoji });
            return;
          }
          const viewer = (yield* linear.viewer()).viewer.id;
          const reactions = yield* linear.listReactions(target);
          const own = reactions.find(
            (reaction) => reaction.emoji === emoji && reaction.user?.id === viewer,
          );
          if (own !== undefined) yield* linear.deleteReaction(own.id);
        }),

      listTemplates: (input) =>
        Effect.gen(function* () {
          const scope = yield* requireTeam("listTemplates", input.scope);
          if (scope.templatesTruncated)
            return yield* failed(
              "listTemplates",
              "This team or workspace has more issue templates than the supported limit. Use Linear to see all templates.",
            );
          const templates: IssueTemplate[] = [];
          const externalTemplates: IssueExternalTemplate[] = [];
          for (const template of scope.templates) {
            if (template.type !== "issue") continue;
            const mapped = toTemplate(template, scope.team.key);
            if ("template" in mapped) templates.push(mapped.template);
            else externalTemplates.push(mapped.link);
          }
          return { templates, externalTemplates, blankIssuesEnabled: true };
        }),

      listCandidates: (input) =>
        Effect.gen(function* () {
          const scope = yield* requireTeam("listCandidates", input.scope, true);
          const assignees = yield* teamAssignees("listCandidates", scope);
          return {
            labels: [
              ...scope.team.labels.nodes,
              ...scope.team.ancestors.flatMap((ancestor) => ancestor.labels?.nodes ?? []),
              ...scope.workspaceLabels,
            ]
              .filter((label) => !label.isGroup && label.archivedAt == null)
              .map((label) => ({
                id: label.id,
                name: label.name,
                color: label.color,
                description: label.description ?? null,
              })),
            assignees: assignees.nodes.map(toActor),
            states: scope.team.states.nodes.map(toState),
            truncated: scope.truncated || assignees.pageInfo.hasNextPage,
          };
        }),
    };
    return api;
  });
