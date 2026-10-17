import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  SourceControlProviderKind,
  issueHostKey,
  type IssueCapabilities,
  type IssueListOrder,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTarget,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as Hosts from "./gitCafeHosts.ts";
import * as Json from "./gitCafeIssueJson.ts";
import * as PullJson from "./gitCafePullRequestJson.ts";
import { makeListTemplates, parseTemplateKey } from "./gitCafeIssueTemplates.ts";

const KIND = IssueTrackerKind.make("gitcafe");
const isCursor = Schema.is(Json.Cursor);
const isApiError = Schema.is(GitCafeApi.GitCafeApiError);
const decodeCommentCursor = Schema.decodeEffect(Schema.fromJsonString(Json.CommentCursor));
const STATES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  labels: true,
  assignees: true,
  maxAssignees: 20,
  reactions: true,
  commentReactions: true,
  templates: true,
  linkedPullRequests: true,
  events: false,
  search: true,
  subIssues: false,
  createSubIssue: false,
  updateParent: false,
  involvements: ["all", "assigned", "authored"],
  listSorts: ["created", "updated"],
  listOrders: ["asc", "desc"],
  states: STATES.map((value) => Json.state(value)),
  closeReasons: [],
};

const fail = (operation: string, detail: string, cause?: unknown) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const make = Effect.gen(function* () {
  const api = yield* GitCafeApi.GitCafeApi;
  const commentIdentity = (input: IssueTarget, order: IssueListOrder) =>
    JSON.stringify([
      KIND,
      input.cwd,
      issueHostKey(input.host),
      input.scope,
      input.key,
      input.connectionId ?? null,
      order,
    ]);
  const commentCursor = (
    operation: string,
    input: IssueTarget,
    native: string | null,
    last: typeof Json.Comment.Type | undefined,
  ) => {
    if (native === null || last === undefined) return Effect.succeed(null);
    const cursor = JSON.stringify({
      version: 1,
      identity: commentIdentity(input, "asc"),
      native,
      lastId: last.id,
      lastAt: last.createdAt,
    });
    return cursor.length <= 8192
      ? Effect.succeed(cursor)
      : Effect.fail(fail(operation, "The GitCafe comment cursor exceeds the supported size."));
  };
  const send = (
    operation: string,
    input: { readonly host: string },
    request: Omit<GitCafeApi.GitCafeApiRequest, "host" | "operation">,
  ) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerError({
            tracker: KIND,
            operation,
            reason: cause.reason,
            detail: cause.detail,
            ...(cause.retryAt === undefined ? {} : { retryAt: cause.retryAt }),
            cause,
          }),
      ),
    );
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: { readonly host: string },
    request: Omit<GitCafeApi.GitCafeApiRequest, "host" | "operation">,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError(() =>
            fail(operation, "GitCafe returned an unreadable response.", raw.slice(0, 2048)),
          ),
        ),
      ),
    );
  const repositoryPath = (
    operation: string,
    input: IssueScopeTarget,
  ): Effect.Effect<string, IssueTrackerError> =>
    Hosts.isGitCafeHost(input.host) && Hosts.gitCafeRepositoryPath(input.scope) === input.scope
      ? Effect.succeed(`/repos/${input.scope}`)
      : Effect.fail(
          fail(operation, "GitCafe requires a supported host and an owner/repository scope."),
        );
  const issuePath = (operation: string, input: IssueTarget) =>
    /^[1-9]\d{0,9}$/u.test(input.key) && Number(input.key) <= 2147483647
      ? repositoryPath(operation, input).pipe(Effect.map((path) => `${path}/issues/${input.key}`))
      : Effect.fail(fail(operation, "GitCafe requires a valid issue number."));
  const detail = (operation: string, input: IssueTarget) =>
    issuePath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, input, { path }, Json.Detail)),
    );
  const principal = (operation: string, input: { readonly host: string }) =>
    read(operation, input, { path: "/auth/principal" }, Json.Principal);
  const page = <
    S extends Schema.Codec<
      { readonly items: ReadonlyArray<unknown>; readonly next: string | null },
      unknown,
      never,
      never
    >,
  >(
    operation: string,
    input: { readonly host: string },
    path: string,
    schema: S,
    cursor?: string,
    limit = 100,
    query = new URLSearchParams(),
  ) =>
    Effect.gen(function* () {
      if (!Number.isInteger(limit) || limit < 1 || (cursor !== undefined && !isCursor(cursor)))
        return yield* fail(operation, "GitCafe received invalid page parameters.");
      const size = Math.min(limit, 100);
      query.set("limit", String(size));
      if (cursor !== undefined) query.set("after", cursor);
      const result = yield* read(operation, input, { path: `${path}?${query}` }, schema);
      if (result.items.length > size || (result.next !== null && result.next === cursor))
        return yield* fail(operation, "GitCafe returned an invalid continuation page.");
      return result;
    });
  const readComments = (operation: string, input: IssueTarget, cursor?: string) =>
    issuePath(operation, input).pipe(
      Effect.flatMap((path) => page(operation, input, `${path}/comments/`, Json.Comments, cursor)),
    );
  const readConversation = (
    operation: string,
    input: IssueTarget,
    cursor: string | undefined,
    order: IssueListOrder = "desc",
    fallback = false,
  ) =>
    Effect.gen(function* () {
      if (cursor !== undefined && cursor.length > 8192)
        return yield* fail(operation, "The GitCafe comment cursor exceeds the supported size.");
      const continuation =
        cursor === undefined
          ? undefined
          : yield* decodeCommentCursor(cursor).pipe(
              Effect.mapError(() => fail(operation, "The GitCafe comment cursor is invalid.")),
            );
      if (cursor !== undefined && continuation?.identity !== commentIdentity(input, order))
        return yield* fail(
          operation,
          "The GitCafe comment cursor does not match this account, issue or order. Refresh the conversation.",
        );
      const result = yield* readComments(operation, input, continuation?.native);
      if (
        new Set(result.items.map((row) => row.id)).size !== result.items.length ||
        (result.next !== null && result.items.length === 0) ||
        (continuation !== undefined &&
          result.items.some(
            (row) => row.id === continuation.lastId || row.createdAt < continuation.lastAt,
          ))
      )
        return yield* fail(operation, "GitCafe returned a repeated or invalid comment page.");
      const partial = result.next !== null || continuation !== undefined;
      if (partial && order === "desc" && !fallback)
        return yield* fail(
          operation,
          "GitCafe supports oldest-first comments only for a paged conversation.",
        );
      const selectedOrder = partial ? "asc" : order;
      const items = [...result.items].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      if (selectedOrder === "desc") items.reverse();
      return {
        items,
        next: yield* commentCursor(operation, input, result.next, items.at(-1)),
        partial,
      };
    });
  const readReactions = (operation: string, input: IssueTarget) =>
    Effect.gen(function* () {
      const path = yield* issuePath(operation, input);
      const items: Array<(typeof PullJson.GitCafeReactions.Type.items)[number]> = [];
      const seen = new Set<string>();
      let next: string | null = null;
      for (let count = 0; count < 10; count++) {
        const result: typeof PullJson.GitCafeReactions.Type = yield* page(
          operation,
          input,
          `${path}/reactions/`,
          PullJson.GitCafeReactions,
          next ?? undefined,
        );
        items.push(...result.items);
        next = result.next;
        if (next === null) break;
        if (!isCursor(next) || seen.has(next))
          return yield* fail(operation, "GitCafe returned an invalid reaction cursor.");
        seen.add(next);
      }
      return { items, next };
    });
  const optionalReactions = (operation: string, input: IssueTarget) =>
    readReactions(operation, input).pipe(
      Effect.catchIf(
        (error) => isApiError(error.cause) && error.cause.status === 403,
        () => Effect.void,
      ),
    );
  const linkedPullRequests: NonNullable<IssueTrackerApi["getLinkedPullRequests"]> = (input) =>
    Effect.gen(function* () {
      const path = yield* issuePath("getLinkedPullRequests", input);
      const links = yield* page(
        "getLinkedPullRequests",
        input,
        `${path}/links/`,
        Json.Links,
        input.cursor,
        input.limit,
      );
      const items = links.items.map((link) => ({
        provider: SourceControlProviderKind.make("gitcafe"),
        host: input.host,
        repository: input.scope,
        number: link.number,
        title: link.title,
        url: `https://${input.host}/${input.scope}/pulls/${link.number}`,
        state: link.state,
        closesIssue: link.linkType === "closes",
      }));
      return { items, nextCursor: links.next };
    });
  const labelCandidates: NonNullable<IssueTrackerApi["listLabelCandidates"]> = (input) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("listLabelCandidates", input);
      const rows = yield* page(
        "listLabelCandidates",
        input,
        `${path}/labels`,
        Json.Labels,
        input.cursor,
        input.limit,
      );
      return {
        items: rows.items.map((label) => ({ ...label, description: label.description ?? null })),
        nextCursor: rows.next,
      };
    });
  const assigneeCandidates: NonNullable<IssueTrackerApi["listAssigneeCandidates"]> = (input) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("listAssigneeCandidates", input);
      const rows = yield* page(
        "listAssigneeCandidates",
        input,
        `${path}/issues/assignee-candidates`,
        Json.Assignees,
        input.cursor,
        input.limit,
      );
      return {
        items: rows.items.map((value) => Json.assignee(value, input.host)),
        nextCursor: rows.next,
      };
    });
  const validateMetadata = (
    operation: string,
    labels: ReadonlyArray<string> | undefined,
    assignees: ReadonlyArray<string> | undefined,
  ) =>
    (labels?.length ?? 0) > 100 ||
    (assignees?.length ?? 0) > 20 ||
    [...(labels ?? []), ...(assignees ?? [])].some((value) => !value.trim())
      ? Effect.fail(fail(operation, "GitCafe requires at most 100 label IDs and 20 assignee IDs."))
      : Effect.void;
  const tracker: IssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer: (input) => principal("getViewer", input).pipe(Effect.map((value) => value.handle)),
    listIssues: (input) =>
      Effect.gen(function* () {
        const path = yield* repositoryPath("listIssues", input);
        if (input.involvement === "mentioned" || input.sort === "comments")
          return yield* fail("listIssues", "GitCafe does not support this issue filter or sort.");
        if (input.stateCategories?.length === 0) return { items: [], nextCursor: null };
        const query = new URLSearchParams();
        const states =
          input.stateCategories === undefined
            ? undefined
            : STATES.filter(
                (value) =>
                  (value === "triage"
                    ? input.stateCategories!.some(
                        (category) =>
                          category === "backlog" ||
                          category === "unstarted" ||
                          category === "started",
                      )
                    : input.stateCategories!.includes(value)) &&
                  (input.state === "all" || Json.state(value).category === input.state),
              );
        if (states?.length === 0) return { items: [], nextCursor: null };
        if (states !== undefined) for (const value of states) query.append("states", value);
        else if (input.state === "all") {
          query.append("statuses", "open");
          query.append("statuses", "closed");
        } else query.set("statuses", input.state);
        if (input.query?.trim()) query.set("q", input.query.trim());
        query.set("sort", input.sort ?? "updated");
        query.set("direction", input.order ?? "desc");
        if (input.involvement !== "all") {
          const viewer = yield* principal("listIssues", input);
          if (viewer.handle !== input.viewer)
            return yield* fail(
              "listIssues",
              "The GitCafe account changed. Refresh the issue list.",
            );
          query.set(input.involvement === "assigned" ? "assignee" : "author", viewer.actorId);
        }
        const rows = yield* page(
          "listIssues",
          input,
          `${path}/issues/`,
          Json.Issues,
          input.cursor,
          input.limit,
          query,
        );
        return {
          items: rows.items.map((value) => Json.summary(value, input.host, input.scope)),
          nextCursor: rows.next,
        };
      }),
    getIssue: (input) =>
      Effect.gen(function* () {
        const value = yield* detail("getIssue", input);
        const [viewer, comments, links, reactions] = yield* Effect.all(
          [
            principal("getIssue", input),
            readConversation("getIssue", input, undefined, "desc", true),
            linkedPullRequests({ ...input, limit: 30 }),
            optionalReactions("getIssue", input),
          ],
          { concurrency: 4 },
        );
        if (
          value.number !== Number(input.key) ||
          comments.items.some((item) => item.issueId !== value.id)
        )
          return yield* fail("getIssue", "GitCafe returned a different issue conversation.");
        return {
          ...Json.summary(value, input.host, input.scope),
          ...(comments.partial
            ? { capabilities: { ...CAPABILITIES, commentOrders: ["asc"] as const } }
            : {}),
          body: value.description ?? "",
          viewer: viewer.handle,
          viewerPermissions: Json.permissions(value),
          states: CAPABILITIES.states.filter((target) =>
            target.category === "closed"
              ? value.capabilities.close
              : Json.state(value.stateType).category === "closed"
                ? value.capabilities.reopen && value.capabilities.edit
                : value.capabilities.edit,
          ),
          comments: comments.items.map((item) => ({
            ...Json.comment(item, input.host),
            ...Json.reactionFields(reactions, item.id, "issue_comment", input.host, viewer.handle),
          })),
          commentsCursor: comments.next,
          events: [],
          linkedPullRequests: links.items,
          ...Json.reactionFields(reactions, value.id, "issue", input.host, viewer.handle),
        };
      }),
    getComments: (input) =>
      Effect.gen(function* () {
        const rows = yield* readConversation("getComments", input, input.cursor, input.order);
        const reactions = yield* optionalReactions("getComments", input);
        return {
          comments: rows.items.map((value) => ({
            ...Json.comment(value, input.host),
            ...Json.reactionFields(
              reactions,
              value.id,
              "issue_comment",
              input.host,
              input.viewer ?? null,
            ),
          })),
          nextCursor: rows.next,
        };
      }),
    getViewerPermissions: (input) =>
      detail("getViewerPermissions", input).pipe(Effect.map(Json.permissions)),
    listLabelCandidates: labelCandidates,
    listAssigneeCandidates: assigneeCandidates,
    listCandidates: (input) =>
      Effect.all([labelCandidates(input), assigneeCandidates(input)], { concurrency: 2 }).pipe(
        Effect.map(([labels, assignees]) => ({
          labels: labels.items.map((value) => ({
            ...value,
            description: value.description ?? null,
          })),
          assignees: assignees.items.flatMap((value) =>
            value.id === undefined ? [] : [{ ...value, id: value.id }],
          ),
          truncated: labels.nextCursor !== null || assignees.nextCursor !== null,
        })),
      ),
    getLinkedPullRequests: linkedPullRequests,
    listTemplates: makeListTemplates((input, path) =>
      repositoryPath("listTemplates", input).pipe(
        Effect.andThen(send("listTemplates", input, { path })),
      ),
    ),
    create: (input) =>
      Effect.gen(function* () {
        const path = yield* repositoryPath("create", input);
        yield* validateMetadata("create", input.labels, input.assignees);
        if (
          input.parentKey !== undefined ||
          input.issueType !== undefined ||
          (input.templateKey !== undefined && parseTemplateKey(input.templateKey) === null)
        )
          return yield* fail("create", "GitCafe does not support this creation option.");
        const value = yield* read(
          "create",
          input,
          {
            method: "POST",
            path: `${path}/issues/`,
            body: {
              title: input.title,
              description: input.body,
              labelIds: input.labels,
              assigneeIds: input.assignees,
            },
          },
          Json.Issue,
        );
        return {
          key: String(value.number),
          displayKey: `#${value.number}`,
          url: `https://${input.host}/${input.scope}/issues/${value.number}`,
        };
      }),
    update: (input) =>
      Effect.gen(function* () {
        const path = yield* issuePath("update", input);
        yield* validateMetadata("update", input.labels, input.assignees);
        const current = yield* detail("update", input);
        const words = input.title !== undefined || input.body !== undefined;
        if (
          (words && !current.capabilities.edit) ||
          (input.labels !== undefined && !current.capabilities.manageLabels) ||
          (input.assignees !== undefined && !current.capabilities.manageAssignees)
        )
          return yield* fail("update", "GitCafe does not allow this issue edit.");
        let version = current.version;
        let changed = false;
        const write = (request: Omit<GitCafeApi.GitCafeApiRequest, "host" | "operation">) =>
          read("update", input, request, Json.Versioned).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                version = result.version;
                changed = true;
              }),
            ),
            Effect.mapError((cause) =>
              changed
                ? new IssueTrackerError({
                    ...cause,
                    detail:
                      "GitCafe saved part of the edit. Refresh the issue before trying again.",
                    cause,
                  })
                : cause,
            ),
          );
        if (words)
          yield* write({
            method: "PATCH",
            path,
            body: {
              expectedVersion: version,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { description: input.body }),
            },
          });
        if (input.labels !== undefined)
          yield* write({
            method: "PUT",
            path: `${path}/labels`,
            body: { expectedVersion: version, labelIds: input.labels },
          });
        if (input.assignees !== undefined)
          yield* write({
            method: "PUT",
            path: `${path}/assignees`,
            body: { expectedVersion: version, actorIds: input.assignees },
          });
      }),
    setState: (input) =>
      Effect.gen(function* () {
        const path = yield* issuePath("setState", input);
        const next = STATES.find((value) => value === input.state);
        if (next === undefined || input.closeReason !== undefined)
          return yield* fail("setState", "GitCafe received an unsupported state or close reason.");
        let current = yield* detail("setState", input);
        if (current.stateType === next) return;
        const closing = Json.state(next).category === "closed";
        const reopening = Json.state(current.stateType).category === "closed" && !closing;
        if (
          (closing && !current.capabilities.close) ||
          (reopening && (!current.capabilities.reopen || !current.capabilities.edit)) ||
          (!closing && !reopening && !current.capabilities.edit)
        )
          return yield* fail("setState", "GitCafe does not allow this state change.");
        if (reopening)
          current = yield* read(
            "setState",
            input,
            { method: "POST", path: `${path}/reopen`, body: { expectedVersion: current.version } },
            Json.Detail,
          );
        if (current.stateType === next) return;
        yield* read(
          "setState",
          input,
          closing
            ? {
                method: "POST",
                path: `${path}/close`,
                body: { expectedVersion: current.version, state: next },
              }
            : { method: "PATCH", path, body: { expectedVersion: current.version, state: next } },
          Json.Detail,
        ).pipe(
          Effect.mapError((cause) =>
            reopening
              ? new IssueTrackerError({
                  ...cause,
                  detail:
                    "GitCafe reopened the issue but could not set the requested state. Refresh the issue.",
                  cause,
                })
              : cause,
          ),
        );
      }),
    comment: (input) =>
      Effect.gen(function* () {
        const path = yield* issuePath("comment", input);
        const current = yield* detail("comment", input);
        if (!current.capabilities.comment)
          return yield* fail("comment", "GitCafe does not allow a comment on this issue.");
        yield* read(
          "comment",
          input,
          { method: "POST", path: `${path}/comments/`, body: { body: input.body } },
          Json.Comment,
        );
      }),
    editComment: (input) =>
      Effect.gen(function* () {
        const path = yield* issuePath("editComment", input);
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let count = 0; count < 10; count++) {
          const rows = yield* readComments("editComment", input, cursor);
          const found = rows.items.find((value) => value.id === input.commentId);
          if (found !== undefined) {
            if (!found.capabilities.edit)
              return yield* fail("editComment", "GitCafe does not allow this comment edit.");
            yield* read(
              "editComment",
              input,
              {
                method: "PATCH",
                path: `${path}/comments/${encodeURIComponent(found.id)}`,
                body: { body: input.body, expectedVersion: found.version },
              },
              Json.Comment,
            );
            return;
          }
          if (rows.next === null)
            return yield* fail("editComment", "GitCafe did not return this comment.");
          if (seen.has(rows.next))
            return yield* fail("editComment", "GitCafe returned a repeated comment cursor.");
          seen.add(rows.next);
          cursor = rows.next;
        }
        return yield* fail(
          "editComment",
          "The GitCafe comment is outside the supported search bound. Refresh the conversation.",
        );
      }),
    setReaction: (input) =>
      Effect.gen(function* () {
        const path = yield* issuePath("setReaction", input);
        const current = yield* detail("setReaction", input);
        const subject = {
          kind: input.subjectId === undefined ? "issue" : "issue_comment",
          id: input.subjectId ?? current.id,
        };
        const values = yield* readReactions("setReaction", input);
        const mine = values.items.find(
          (item) =>
            item.subject.kind === subject.kind &&
            item.subject.id === subject.id &&
            item.emoji.kind === "unicode" &&
            PullJson.reactionContent(item.emoji.value) === input.content,
        )?.viewerReactionId;
        if (values.next !== null && mine == null)
          return yield* fail(
            "setReaction",
            "GitCafe reactions are incomplete. Refresh before changing a reaction.",
          );
        if (input.reacted === (mine != null)) return;
        yield* send(
          "setReaction",
          input,
          input.reacted
            ? {
                method: "POST",
                path: `${path}/reactions/`,
                body: {
                  subject,
                  emoji: { kind: "unicode", value: PullJson.REACTION_EMOJI[input.content] },
                },
              }
            : { method: "DELETE", path: `${path}/reactions/${encodeURIComponent(mine!)}` },
        );
      }),
  };
  return tracker;
});
