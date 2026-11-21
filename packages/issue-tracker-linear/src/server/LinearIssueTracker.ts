/**
 * Linear as an issue tracker. A scope is a team key (`ENG`) and an issue key its identifier
 * (`ENG-123`). A workflow state is closed when its type is `completed` or `canceled`, so closing
 * picks the team's first state of that type, as Linear's own "Done" and "Canceled" do.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
} from "@t3tools/source-control-core/server/IssueTracker";

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
  automationContainer: "team",
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
const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"];
/** The order Linear lists a workflow in; within a type, its own `position` decides. */
const STATE_TYPE_ORDER = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
];

function inWorkflowOrder(
  states: ReadonlyArray<LinearApi.LinearWorkflowState>,
): ReadonlyArray<LinearApi.LinearWorkflowState> {
  return states.toSorted(
    (a, b) =>
      STATE_TYPE_ORDER.indexOf(a.type) - STATE_TYPE_ORDER.indexOf(b.type) ||
      (a.position ?? 0) - (b.position ?? 0),
  );
}

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
/** Linear takes the emoji on a write and answers with its short name, so a read knows both. */
const EMOJI_NAME_BY_CONTENT: Record<IssueReactionContent, string> = {
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  laugh: "smile",
  hooray: "tada",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};
const CONTENT_BY_EMOJI = new Map(
  [EMOJI_BY_CONTENT, EMOJI_NAME_BY_CONTENT].flatMap((spellings) =>
    Object.entries(spellings).map(
      ([content, emoji]) => [emoji, content as IssueReactionContent] as const,
    ),
  ),
);

const teamOption = (team: {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}) => ({
  id: team.id,
  name: `${team.name} (${team.key})`,
});

/** Linear filters issues by number, at most this many per read. */
const STATUS_READ_BATCH = 250;

/** `ENG-123`, or null for anything that is not a Linear identifier. */
function parseIdentifier(key: string): string | null {
  return /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(key.trim()) ? key.trim().toUpperCase() : null;
}

/** `https://linear.app/<workspace>/issue/<TEAM>-<n>[/<slug>]`, keeping the workspace. */
function parseIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== DESCRIPTOR.host) return null;
  const [, workspace, resource, key] = url.pathname.split("/");
  if (!workspace || resource !== "issue" || key === undefined) return null;
  const scope = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: DESCRIPTOR.host, workspace, scope, key };
}

function toState(state: LinearApi.LinearWorkflowState): IssueState {
  return CLOSED_STATE_TYPES.includes(state.type)
    ? { category: "closed", name: state.name, closeReason: state.type }
    : { category: "open", name: state.name };
}

/**
 * The login is Linear's handle (its `displayName`, unique in a workspace), which is what people
 * see and what filters and writes are named by; the id stays inside this adapter.
 */
function toActor(user: LinearApi.LinearUser): IssueActor {
  return {
    login: user.displayName || user.id,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

type LinearBot = NonNullable<LinearApi.LinearIssue["botActor"]>;

/**
 * Who did it: the person, else the integration that acted (GitHub moving an issue, a form filing
 * one), which Linear reports beside an empty user.
 */
function actorOf(user: LinearApi.LinearUser | null, bot: LinearBot | null): IssueActor | null {
  if (user !== null) return toActor(user);
  const name = bot?.userDisplayName ?? bot?.name;
  if (bot == null || !name) return null;
  return { isBot: true, login: bot.name ?? name, name, avatarUrl: bot.avatarUrl ?? null };
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
    author: actorOf(issue.creator, issue.botActor),
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
    author: actorOf(comment.user, comment.botActor),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    reactions: toReactions(comment.reactions, viewerId),
  };
}

function toEvents(history: ReadonlyArray<LinearApi.LinearHistoryEntry>): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const entry of history) {
    const actor = actorOf(entry.actor, entry.botActor);
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

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

/** Linear's GitHub and GitLab integrations record change requests as attachments. */
function toLinkedPullRequests(
  attachments: ReadonlyArray<LinearApi.LinearAttachment>,
): IssueLinkedPullRequest[] {
  const seen = new Set<string>();
  return attachments.flatMap((attachment) => {
    const match = PULL_REQUEST_URL.exec(attachment.url);
    if (match === null || seen.has(attachment.url)) return [];
    seen.add(attachment.url);
    const fields = isJsonObject(attachment.metadata) ? attachment.metadata : {};
    const status = fields["status"];
    return [
      {
        repository: match[1] ?? match[2]!,
        number: Number(match[3]),
        title: attachment.title.trim() || attachment.url,
        url: attachment.url,
        state: status === "merged" ? "merged" : status === "closed" ? "closed" : "open",
        isDraft: status === "draft" || fields["draft"] === true,
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
}): LinearApi.IssueFilter {
  switch (input.involvement) {
    case "assigned":
      return { assignee: { displayName: { eq: input.viewer } } };
    case "authored":
      return { creator: { displayName: { eq: input.viewer } } };
    case "mentioned":
      return { subscribers: { some: { displayName: { eq: input.viewer } } } };
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

    /**
     * The issue a write names, refused unless it sits in the bound team: an identifier from
     * another team, or one that moved away, still resolves in Linear.
     */
    const requireTeamIssue = Effect.fn("LinearIssueTracker.requireTeamIssue")(function* (
      operation: string,
      input: { readonly scope: string; readonly key: string },
    ) {
      const identifier = yield* requireIdentifier(operation, input.key);
      // One comment, not none: Linear refuses a page of zero.
      const issue = yield* linear.getIssue(identifier, 1);
      if (issue === null) return yield* notFound(operation);
      const team = input.scope.trim().toUpperCase();
      if (issue.team.key !== team) {
        return yield* failed(
          operation,
          `${issue.identifier} belongs to Linear team ${issue.team.key}, not ${team}.`,
        );
      }
      return issue;
    });

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
      parseIssueUrl,

      probeCredential: ({ token }) =>
        linear.viewer(token).pipe(
          Effect.map((data) => ({
            account: userName(data.viewer),
            scopes: data.teams.map((team) => ({ key: team.key, name: team.name })),
          })),
        ),

      // Team ids are unique across workspaces, so another workspace's credential finds none.
      automation: {
        // One read holds every team, so a search filters it and there is no next page.
        listContainers: Effect.fn("LinearIssueTracker.listContainers")(({ query }) =>
          linear.viewer().pipe(
            Effect.map((data) => ({
              workspace: data.workspace,
              containers: data.teams
                .map(teamOption)
                .filter(
                  (team) =>
                    query === undefined ||
                    team.name.toLowerCase().includes(query.trim().toLowerCase()),
                ),
              nextCursor: null,
            })),
          ),
        ),
        getContainer: Effect.fn("LinearIssueTracker.getContainer")((containerId) =>
          linear.viewer().pipe(
            Effect.map((data) => {
              const team = data.teams.find((candidate) => candidate.id === containerId);
              return {
                workspace: data.workspace,
                container: team === undefined ? null : teamOption(team),
              };
            }),
          ),
        ),
        listStates: Effect.fn("LinearIssueTracker.listStates")(({ containerId }) =>
          linear
            .getTeamStates(containerId)
            .pipe(
              Effect.map((states) => inWorkflowOrder(states).map(({ id, name }) => ({ id, name }))),
            ),
        ),
        readStatuses: Effect.fn("LinearIssueTracker.readStatuses")(({ containerId, keys }) => {
          const numbers = [
            ...new Set(
              keys.flatMap((key) => {
                const identifier = parseIdentifier(key);
                return identifier === null ? [] : [Number(identifier.split("-")[1])];
              }),
            ),
          ];
          const batches = Array.from(
            { length: Math.ceil(numbers.length / STATUS_READ_BATCH) },
            (_, index) => numbers.slice(index * STATUS_READ_BATCH, (index + 1) * STATUS_READ_BATCH),
          );
          return Effect.forEach(batches, (batch) =>
            linear.getIssueStates({ teamId: containerId, numbers: batch }),
          ).pipe(
            Effect.map((pages) =>
              pages.flat().map((issue) => ({ key: issue.identifier, stateId: issue.stateId })),
            ),
          );
        }),
      },

      // The id, not the display name: it is what the involvement filters compare against.
      getViewer: () => linear.viewer().pipe(Effect.map((data) => toActor(data.viewer).login)),

      listIssues: (input) => {
        // `ENG-12`, `#12` or `12` asks for one issue of this team by number.
        const reference =
          input.query === undefined
            ? null
            : /^(?:[A-Za-z][A-Za-z0-9]*-|#)?(\d+)$/.exec(input.query.trim());
        // Each is its own clause: an assignee filter must narrow "assigned to me", not replace it.
        const clauses: LinearApi.IssueFilter[] = [
          ...(input.assignee === undefined
            ? []
            : [{ assignee: { displayName: { eq: input.assignee } } }]),
          ...(input.labels ?? []).map((name) => ({ labels: { some: { name: { eq: name } } } })),
        ];
        const filter: LinearApi.IssueFilter = {
          team: { key: { eq: input.scope.trim().toUpperCase() } },
          ...involvementFilter(input),
          ...(input.state === "all"
            ? {}
            : {
                state: {
                  type:
                    input.state === "closed"
                      ? { in: CLOSED_STATE_TYPES }
                      : { nin: CLOSED_STATE_TYPES },
                },
              }),
          ...(clauses.length === 0 ? {} : { and: clauses }),
          ...(input.query === undefined
            ? {}
            : {
                or: [
                  { title: { containsIgnoreCase: input.query } },
                  { description: { containsIgnoreCase: input.query } },
                  ...(reference === null ? [] : [{ number: { eq: Number(reference[1]) } }]),
                ],
              }),
        };
        return linear
          .listIssues({
            filter,
            first: input.limit,
            after: input.cursor,
            orderBy: input.sort === "created" ? "createdAt" : "updatedAt",
          })
          .pipe(
            Effect.map((page) => ({
              items: page.nodes.map((node) => toSummary(node)),
              nextCursor: page.nextCursor,
            })),
          );
      },

      getIssue: Effect.fn("LinearIssueTracker.getIssue")(function* (input) {
        const identifier = yield* requireIdentifier("getIssue", input.key);
        // One read of the viewer: the id matches reactions, the handle is what the client sees.
        const [issue, me] = yield* Effect.all([
          linear.getIssue(identifier, COMMENTS_PAGE),
          linear.viewer().pipe(
            Effect.map((data) => data.viewer),
            Effect.orElseSucceed(() => null),
          ),
        ]);
        const viewer = me?.id ?? null;
        if (issue === null) return yield* notFound("getIssue");
        return {
          ...toSummary(issue, issue.comments.nodes.length),
          body: issue.description ?? "",
          viewer: me === null ? null : toActor(me).login,
          viewerPermissions: VIEWER_PERMISSIONS,
          states: inWorkflowOrder(issue.team.states.nodes).map(toState),
          reactions: toReactions(issue.reactions, viewer),
          comments: issue.comments.nodes.map((comment) => toComment(comment, viewer)),
          commentsCursor: issue.comments.pageInfo.hasNextPage
            ? issue.comments.pageInfo.endCursor
            : null,
          events: toEvents(issue.history.nodes),
          linkedPullRequests: toLinkedPullRequests(issue.attachments.nodes),
        };
      }),

      getComments: Effect.fn("LinearIssueTracker.getComments")(function* (input) {
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

      create: Effect.fn("LinearIssueTracker.create")(function* (input) {
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

      comment: Effect.fn("LinearIssueTracker.comment")(function* (input) {
        const issue = yield* requireTeamIssue("comment", input);
        yield* linear.createComment({ issueId: issue.id, body: input.body });
      }),

      update: Effect.fn("LinearIssueTracker.update")(function* (input) {
        const { identifier } = yield* requireTeamIssue("update", input);
        const scope =
          input.labels !== undefined || input.assignees !== undefined
            ? yield* requireTeam("update", input.scope)
            : null;
        yield* linear.updateIssue(identifier, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
          ...(scope === null || input.labels === undefined
            ? {}
            : { labelIds: yield* labelIds("update", scope, input.labels) }),
          ...(scope === null || input.assignees === undefined
            ? {}
            : { assigneeId: yield* assigneeId("update", scope, input.assignees) }),
        });
      }),

      setState: Effect.fn("LinearIssueTracker.setState")(function* (input) {
        const { identifier } = yield* requireTeamIssue("setState", input);
        const scope = yield* requireTeam("setState", input.scope);
        const wanted = scope.team.states.nodes.find((state) => state.name === input.state);
        if (wanted === undefined)
          return yield* failed("setState", `This team's workflow has no "${input.state}" state.`);
        yield* linear.updateIssue(identifier, { stateId: wanted.id });
      }),

      setReaction: Effect.fn("LinearIssueTracker.setReaction")(function* (input) {
        const issue = yield* requireTeamIssue("setReaction", input);
        const emoji = EMOJI_BY_CONTENT[input.content];
        const target =
          input.subjectId === undefined ? { issueId: issue.id } : { commentId: input.subjectId };
        // Comment ids are global: prove the comment belongs to this issue before writing.
        const subject =
          input.subjectId === undefined && input.reacted
            ? null
            : yield* linear.listReactions(target);
        if (subject !== null && subject.issueId !== issue.id) {
          return yield* failed("setReaction", "The comment does not belong to the selected issue.");
        }
        if (subject === null || input.reacted) {
          yield* linear.createReaction({ ...target, emoji });
          return;
        }
        const viewer = yield* viewerId;
        const { reactions } = subject;
        const own = reactions.find(
          (reaction) =>
            CONTENT_BY_EMOJI.get(reaction.emoji) === input.content && reaction.user?.id === viewer,
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
