/**
 * Linear as an issue tracker. A scope is a team key (`ENG`), an issue key is its identifier
 * (`ENG-123`), and Linear's workflow states travel by name with the category read off their
 * type: `completed` and `canceled` are closed, every other type is open. Closing therefore picks
 * the team's first state of the matching type, which is what Linear's own "Done" and "Canceled"
 * buttons do.
 *
 * Templates: a plain template becomes a draft here; one with form fields or rich (non-markdown)
 * content opens the exact template in Linear instead, through the template list's contact links.
 *
 * @module issue-tracker-linear/server/LinearIssueTracker
 */
import * as Effect from "effect/Effect";
import {
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueEvent,
  type IssueExternalTemplate,
  type IssueInvolvement,
  type IssueLinkedPullRequest,
  type IssueReaction,
  type IssueReactionContent,
  type IssueState,
  type IssueTemplate,
  type IssueViewerPermissions,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
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
 * detail page through `getIssue`'s state, while the service's `setState` guard needs a fixed list.
 * The driver maps `open` to the team's default state and `closed` to its first completed state,
 * with `canceled` as the close reason for its first canceled state.
 */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
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

const COMMENTS_PAGE = 50;
const CLOSED_STATE_TYPES = ["completed", "canceled"];

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

function toState(state: LinearApi.LinearWorkflowState): IssueState {
  return CLOSED_STATE_TYPES.includes(state.type)
    ? { category: "closed", name: state.name, closeReason: state.type }
    : { category: "open", name: state.name };
}

/** Linear identifies people by id, so that is the login; the display name is what people see. */
function toActor(user: LinearApi.LinearUser): IssueActor {
  return {
    login: user.id,
    name: user.displayName ?? user.name,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/** How a user shows in a picker and an event: display name first, falling back to the id. */
function userName(user: LinearApi.LinearUser): string {
  return user.displayName ?? user.name ?? user.email ?? user.id;
}

/** Linear's connections report no totals, so a listing shows no comment count. */
function toSummary(issue: LinearApi.LinearIssue, commentCount = 0): TrackerIssueSummary {
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
    labels: issue.labels.nodes.map((label) => ({ name: label.name, color: label.color })),
    commentCount,
  };
}

function toReactions(
  reactions: ReadonlyArray<LinearApi.LinearReaction>,
  viewerId: string | null,
): IssueReaction[] {
  const grouped = new Map<IssueReactionContent, IssueReaction>();
  for (const reaction of reactions) {
    const content = CONTENT_BY_EMOJI.get(reaction.emoji);
    if (content === undefined) continue;
    const mine = reaction.user !== null && reaction.user.id === viewerId;
    const existing = grouped.get(content);
    const actor = reaction.user === null || mine ? [] : [userName(reaction.user)];
    grouped.set(
      content,
      existing === undefined
        ? { content, count: 1, actors: actor, viewerHasReacted: mine }
        : {
            ...existing,
            count: existing.count + 1,
            actors: [...existing.actors, ...actor],
            viewerHasReacted: existing.viewerHasReacted || mine,
          },
    );
  }
  return [...grouped.values()];
}

function toComment(comment: LinearApi.LinearComment, viewerId: string | null): IssueComment {
  return {
    id: comment.id,
    author: comment.user === null ? null : toActor(comment.user),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    reactions: toReactions(comment.reactions, viewerId),
  };
}

function toEvents(history: ReadonlyArray<LinearApi.LinearHistoryEntry>): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const entry of history) {
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
        number: Number(match[3]),
        title: attachment.title.trim() || attachment.url,
        url: attachment.url,
        state: status === "merged" ? "merged" : status === "closed" ? "closed" : "open",
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
  labelNames: ReadonlyMap<string, string>,
): { readonly template: IssueTemplate } | { readonly link: IssueExternalTemplate } {
  const data = template.templateData;
  const body = template.content ?? (typeof data.description === "string" ? data.description : null);
  if (template.hasFormFields || (body === null && data.descriptionData != null)) {
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
      labels: (data.labelIds ?? []).flatMap((id) => {
        const name = labelNames.get(id);
        return name === undefined ? [] : [name];
      }),
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
      return { subscribers: { some: { id: { eq: input.viewer } } } };
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

    const requireTeam = (operation: string, scope: string) =>
      linear.getTeam(scope.trim().toUpperCase()).pipe(
        Effect.filterOrFail(
          (team): team is LinearApi.LinearTeamScope => team !== null,
          () => failed(operation, `No Linear team has the key "${scope}".`),
        ),
      );

    /** Names to label ids, within the team's and the workspace's labels. */
    const labelIds = (
      operation: string,
      scope: LinearApi.LinearTeamScope,
      names: ReadonlyArray<string>,
    ) =>
      Effect.forEach(names, (name) => {
        const match = [...scope.team.labels.nodes, ...scope.workspaceLabels].find(
          (label) => label.name.toLowerCase() === name.trim().toLowerCase(),
        );
        return match === undefined
          ? Effect.fail(failed(operation, `Linear has no label named "${name}" for this team.`))
          : Effect.succeed(match.id);
      });

    /** One assignee at most: Linear issues have a single assignee. */
    const assigneeId = (
      operation: string,
      scope: LinearApi.LinearTeamScope,
      assignees: ReadonlyArray<string>,
    ): Effect.Effect<string | null, IssueTrackerError> => {
      const [first, ...rest] = assignees;
      if (first === undefined) return Effect.succeed(null);
      if (rest.length > 0)
        return Effect.fail(failed(operation, "A Linear issue has one assignee at most."));
      const member = scope.team.members.nodes.find(
        (user) =>
          user.id === first ||
          user.email?.toLowerCase() === first.toLowerCase() ||
          user.displayName?.toLowerCase() === first.toLowerCase(),
      );
      return member === undefined
        ? Effect.fail(failed(operation, `"${first}" is not a member of this Linear team.`))
        : Effect.succeed(member.id);
    };

    const viewerId: Effect.Effect<string | null> = linear.viewer().pipe(
      Effect.map((data) => data.viewer.id),
      Effect.orElseSucceed(() => null),
    );

    const api: StandaloneIssueTrackerApi = {
      kind: LinearApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,

      probeCredential: (token) =>
        linear.viewer(token).pipe(
          Effect.map((data) => ({
            account: userName(data.viewer),
            scopes: data.teams.map((team) => ({ key: team.key, name: team.name })),
          })),
        ),

      // The id, not the display name: it is what the involvement filters compare against.
      getViewer: () => linear.viewer().pipe(Effect.map((data) => data.viewer.id)),

      listIssues: (input) => {
        const filter: Record<string, unknown> = {
          team: { key: { eq: input.scope.trim().toUpperCase() } },
          ...involvementFilter(input),
        };
        if (input.state !== "all") {
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
          const reference = /^(?:[A-Za-z][A-Za-z0-9]*-|#)?(\d+)$/.exec(input.query.trim());
          if (reference !== null) or.push({ number: { eq: Number(reference[1]) } });
          filter.or = or;
        }
        return linear.listIssues({ filter, first: input.limit, after: input.cursor }).pipe(
          Effect.map((page) => ({
            items: page.nodes.map(toSummary),
            nextCursor: page.nextCursor,
          })),
        );
      },

      getIssue: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("getIssue", input.key);
          const [issue, viewer] = yield* Effect.all([
            linear.getIssue(identifier, COMMENTS_PAGE),
            viewerId,
          ]);
          if (issue === null) return yield* notFound("getIssue");
          return {
            ...toSummary(issue, issue.comments.nodes.length),
            body: issue.description ?? "",
            viewer,
            viewerPermissions: VIEWER_PERMISSIONS,
            reactions: toReactions(issue.reactions, viewer),
            comments: issue.comments.nodes.map((comment) => toComment(comment, viewer)),
            commentsCursor: issue.comments.pageInfo.hasNextPage
              ? issue.comments.pageInfo.endCursor
              : null,
            events: toEvents(issue.history.nodes),
            linkedPullRequests: toLinkedPullRequests(issue.attachments.nodes),
          };
        }),

      getComments: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("getComments", input.key);
          const [page, viewer] = yield* Effect.all([
            linear.getComments({ identifier, first: COMMENTS_PAGE, after: input.cursor }),
            viewerId,
          ]);
          return {
            comments: page.nodes.map((comment) => toComment(comment, viewer)),
            nextCursor: page.nextCursor,
          };
        }),

      getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

      create: (input) =>
        Effect.gen(function* () {
          const scope = yield* requireTeam("create", input.scope);
          const labels = yield* labelIds("create", scope, input.labels);
          const assignee = yield* assigneeId("create", scope, input.assignees);
          const created = yield* linear.createIssue({
            teamId: scope.team.id,
            title: input.title,
            description: input.body,
            labelIds: labels,
            ...(assignee === null ? {} : { assigneeId: assignee }),
          });
          return { key: created.identifier, displayKey: created.identifier, url: created.url };
        }),

      comment: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("comment", input.key);
          const issue = yield* linear.getIssue(identifier, 0);
          if (issue === null) return yield* notFound("comment");
          yield* linear.createComment({ issueId: issue.id, body: input.body });
        }),

      update: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("update", input.key);
          const patch: Record<string, unknown> = {};
          if (input.title !== undefined) patch.title = input.title;
          if (input.body !== undefined) patch.description = input.body;
          if (input.labels !== undefined || input.assignees !== undefined) {
            const scope = yield* requireTeam("update", input.scope);
            if (input.labels !== undefined)
              patch.labelIds = yield* labelIds("update", scope, input.labels);
            if (input.assignees !== undefined)
              patch.assigneeId = yield* assigneeId("update", scope, input.assignees);
          }
          yield* linear.updateIssue(identifier, patch);
        }),

      setState: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("setState", input.key);
          const scope = yield* requireTeam("setState", input.scope);
          const states = scope.team.states.nodes.toSorted(
            (a, b) => (a.position ?? 0) - (b.position ?? 0),
          );
          const wanted =
            input.state === "closed"
              ? states.find((state) => state.type === (input.closeReason ?? "completed"))
              : (states.find((state) => state.type === "unstarted") ??
                states.find((state) => state.type === "backlog") ??
                states.find((state) => state.type === "triage"));
          if (wanted === undefined)
            return yield* failed("setState", "This team has no workflow state for that change.");
          yield* linear.updateIssue(identifier, { stateId: wanted.id });
        }),

      setReaction: (input) =>
        Effect.gen(function* () {
          const identifier = yield* requireIdentifier("setReaction", input.key);
          const emoji = EMOJI_BY_CONTENT[input.content];
          const target =
            input.subjectId === undefined
              ? yield* linear
                  .getIssue(identifier, 0)
                  .pipe(
                    Effect.flatMap((issue) =>
                      issue === null
                        ? Effect.fail(notFound("setReaction"))
                        : Effect.succeed({ issueId: issue.id }),
                    ),
                  )
              : { commentId: input.subjectId };
          if (input.reacted) {
            yield* linear.createReaction({ ...target, emoji });
            return;
          }
          const viewer = yield* viewerId;
          const reactions = yield* linear.listReactions(target);
          const own = reactions.find(
            (reaction) => reaction.emoji === emoji && reaction.user?.id === viewer,
          );
          if (own !== undefined) yield* linear.deleteReaction(own.id);
        }),

      listTemplates: (input) =>
        requireTeam("listTemplates", input.scope).pipe(
          Effect.map((scope) => {
            const labelNames = new Map(
              [...scope.team.labels.nodes, ...scope.workspaceLabels].map((label) => [
                label.id,
                label.name,
              ]),
            );
            const templates: IssueTemplate[] = [];
            const externalTemplates: IssueExternalTemplate[] = [];
            for (const template of scope.team.templates.nodes) {
              if (template.type !== "issue") continue;
              const mapped = toTemplate(template, scope.team.key, labelNames);
              if ("template" in mapped) templates.push(mapped.template);
              else externalTemplates.push(mapped.link);
            }
            return { templates, externalTemplates, blankIssuesEnabled: true };
          }),
        ),

      listCandidates: (input) =>
        requireTeam("listCandidates", input.scope).pipe(
          Effect.map((scope) => ({
            labels: [...scope.team.labels.nodes, ...scope.workspaceLabels].map((label) => ({
              name: label.name,
              color: label.color,
              description: label.description ?? null,
            })),
            assignees: scope.team.members.nodes.map((user) => ({ ...toActor(user), id: user.id })),
            truncated: scope.truncated,
          })),
        ),
    };
    return api;
  });
