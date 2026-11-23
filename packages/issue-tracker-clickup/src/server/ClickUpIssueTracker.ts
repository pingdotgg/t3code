/**
 * ClickUp as an issue tracker. A scope is a list id and an issue key a task id. A status is
 * closed when its type is `closed` or `done`. ClickUp tags are the labels, scoped to the
 * list's space. Its API has no free-text search, history, or reactions, so none are offered.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueState,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { CLICKUP_HOST, CLICKUP_LINK_WORKSPACE, parseClickUpIssueUrl } from "../shared/issueUrl.ts";
import * as ClickUpApi from "./ClickUpApi.ts";

const { Responses } = ClickUpApi;

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: ClickUpApi.KIND,
  displayName: "ClickUp",
  host: CLICKUP_HOST,
  scopeNoun: "list",
  credential: {
    label: "Personal API token",
    helpUrl: "https://app.clickup.com/settings/apps",
  },
};

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: false,
};

/** Everything granted: ClickUp reports no per-task permissions and refuses with a message. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

/** ClickUp's fixed page sizes. */
const TASKS_PAGE = 100;
const COMMENTS_PAGE = 25;
const CLOSED_STATUS_TYPES = ["closed", "done"];
const SCOPE_CONCURRENCY = 4;

const isoFromMillis = (value: string | null | undefined): string | null =>
  value == null || !/^\d+$/.test(value)
    ? null
    : DateTime.formatIso(DateTime.makeUnsafe(Number(value)));
const EPOCH = DateTime.formatIso(DateTime.makeUnsafe(0));

function toState(status: ClickUpApi.ClickUpStatus): IssueState {
  return CLOSED_STATUS_TYPES.includes(status.type)
    ? {
        category: "closed",
        name: status.status,
        closeReason: status.type === "done" ? "completed" : "closed",
      }
    : { category: "open", name: status.status };
}

const orderOf = (status: ClickUpApi.ClickUpStatus) => Number(status.orderindex ?? 0) || 0;

/** The login is the username, which is what people see; the numeric id stays inside. */
function toActor(user: ClickUpApi.ClickUpUser): IssueActor {
  return {
    login: user.username?.trim() || user.email?.trim() || String(user.id),
    name: user.username ?? null,
    avatarUrl: user.profilePicture ?? null,
  };
}

const sameLogin = (user: ClickUpApi.ClickUpUser, login: string) =>
  toActor(user).login.toLowerCase() === login.trim().toLowerCase();

/** A custom task id where the workspace uses them, else ClickUp's own `#id`. */
const displayKeyOf = (task: {
  readonly id: string;
  readonly custom_id?: string | null | undefined;
}) => task.custom_id?.trim() || `#${task.id}`;

function toSummary(task: ClickUpApi.ClickUpTask, commentCount = 0): TrackerIssueSummary {
  const createdAt = isoFromMillis(task.date_created) ?? EPOCH;
  return {
    key: task.id,
    displayKey: displayKeyOf(task),
    title: task.name.trim() || `#${task.id}`,
    url: task.url,
    author: task.creator == null ? null : toActor(task.creator),
    state: toState(task.status),
    createdAt,
    updatedAt: isoFromMillis(task.date_updated) ?? createdAt,
    closedAt: isoFromMillis(task.date_done) ?? isoFromMillis(task.date_closed),
    assignees: task.assignees.map(toActor),
    labels: task.tags.map((tag) => ({ name: tag.name, color: tag.tag_bg ?? null })),
    commentCount,
  };
}

/** ClickUp answers newest first; the contract reads oldest first with older pages before. */
function toComments(comments: ReadonlyArray<ClickUpApi.ClickUpComment>): IssueComment[] {
  return comments.toReversed().map((comment) => ({
    id: comment.id,
    author: comment.user === null ? null : toActor(comment.user),
    body: comment.comment_text,
    createdAt: isoFromMillis(comment.date) ?? EPOCH,
    url: null,
  }));
}

/** Where older comments carry on: the oldest comment's date and id, as ClickUp pages by them. */
function commentsCursor(comments: ReadonlyArray<ClickUpApi.ClickUpComment>): string | null {
  const oldest = comments.at(-1);
  return comments.length < COMMENTS_PAGE || oldest === undefined
    ? null
    : `${oldest.date}:${oldest.id}`;
}

/** `<page>:<offset>`: ClickUp pages are a fixed hundred, and a listing asks for fewer. */
function parseListCursor(cursor: string | undefined): { page: number; offset: number } {
  const match = /^(\d+):(\d+)$/.exec(cursor ?? "");
  return match === null
    ? { page: 0, offset: 0 }
    : { page: Number(match[1]), offset: Number(match[2]) };
}

const failed = (operation: string, detail: string) =>
  new IssueTrackerError({ tracker: ClickUpApi.KIND, operation, reason: "failed", detail });

const requireListId = (
  operation: string,
  scope: string,
): Effect.Effect<string, IssueTrackerError> => {
  const id = scope.trim();
  return /^\d+$/.test(id)
    ? Effect.succeed(id)
    : Effect.fail(failed(operation, `"${scope}" is not a ClickUp list id.`));
};

const requireTaskId = (
  operation: string,
  key: string,
): Effect.Effect<string, IssueTrackerError> => {
  const id = key.trim().replace(/^#/, "");
  return /^[a-z0-9]+$/i.test(id)
    ? Effect.succeed(id)
    : Effect.fail(
        new IssueTrackerError({
          tracker: ClickUpApi.KIND,
          operation,
          reason: "not-found",
          detail: "ClickUp has no task by that id.",
        }),
      );
};

export const make: Effect.Effect<StandaloneIssueTrackerApi, never, ClickUpApi.ClickUpApi> =
  Effect.gen(function* () {
    const clickup = yield* ClickUpApi.ClickUpApi;

    const viewer = (token?: string) =>
      clickup
        .request({
          operation: "viewer",
          method: "GET",
          path: "/user",
          decode: Responses.user,
          token,
        })
        .pipe(Effect.map((data) => data.user));

    const getTask = (operation: string, id: string) =>
      clickup.request({
        operation,
        method: "GET",
        path: `/task/${encodeURIComponent(id)}`,
        query: { include_markdown_description: true },
        decode: Responses.task,
      });

    const getList = (operation: string, id: string) =>
      clickup.request({
        operation,
        method: "GET",
        path: `/list/${encodeURIComponent(id)}`,
        decode: Responses.list,
      });

    const listMembers = (operation: string, listId: string) =>
      clickup
        .request({
          operation,
          method: "GET",
          path: `/list/${encodeURIComponent(listId)}/member`,
          decode: Responses.members,
        })
        .pipe(Effect.map((data) => data.members));

    const spaceTags = (operation: string, spaceId: string) =>
      clickup
        .request({
          operation,
          method: "GET",
          path: `/space/${encodeURIComponent(spaceId)}/tag`,
          decode: Responses.tags,
        })
        .pipe(Effect.map((data) => data.tags));

    const listComments = (
      operation: string,
      taskId: string,
      after?: { readonly start: string; readonly startId: string },
    ) =>
      clickup
        .request({
          operation,
          method: "GET",
          path: `/task/${encodeURIComponent(taskId)}/comment`,
          query: after === undefined ? {} : { start: after.start, start_id: after.startId },
          decode: Responses.comments,
        })
        .pipe(
          Effect.map((data) =>
            after === undefined
              ? data.comments
              : data.comments.filter((comment) => comment.id !== after.startId),
          ),
        );

    /** Tag names as the space spells them, refusing one the space does not have. */
    const tagNames = (operation: string, spaceId: string, names: ReadonlyArray<string>) =>
      names.length === 0
        ? Effect.succeed([])
        : spaceTags(operation, spaceId).pipe(
            Effect.flatMap((tags) =>
              Effect.forEach(names, (name) => {
                const match = tags.find(
                  (tag) => tag.name.toLowerCase() === name.trim().toLowerCase(),
                );
                return match === undefined
                  ? Effect.fail(
                      failed(operation, `ClickUp has no tag named "${name}" in this space.`),
                    )
                  : Effect.succeed(match.name);
              }),
            ),
          );

    /** Logins, emails or ids to ClickUp user ids, among the list's members. */
    const memberIds = (operation: string, listId: string, assignees: ReadonlyArray<string>) =>
      assignees.length === 0
        ? Effect.succeed([])
        : listMembers(operation, listId).pipe(
            Effect.flatMap((members) =>
              Effect.forEach(assignees, (wanted) => {
                const value = wanted.trim().toLowerCase();
                const member = members.find(
                  (user) =>
                    String(user.id) === value ||
                    user.email?.toLowerCase() === value ||
                    sameLogin(user, value),
                );
                return member === undefined
                  ? Effect.fail(
                      failed(operation, `"${wanted}" is not a member of this ClickUp list.`),
                    )
                  : Effect.succeed(member.id);
              }),
            ),
          );

    const listStates = (list: ClickUpApi.ClickUpList, current: ClickUpApi.ClickUpStatus) => {
      const statuses = list.statuses ?? [];
      const all = statuses.some((status) => status.status === current.status)
        ? statuses
        : [...statuses, current];
      return all.toSorted((a, b) => orderOf(a) - orderOf(b));
    };

    /** Every list the token reaches, named by where it sits: space, folder, list. */
    const reachableLists = Effect.fn("ClickUpIssueTracker.reachableLists")(function* (
      token: string,
    ) {
      const { teams } = yield* clickup.request({
        operation: "probe",
        method: "GET",
        path: "/team",
        decode: Responses.teams,
        token,
      });
      const perTeam = yield* Effect.forEach(
        teams,
        (team) =>
          Effect.gen(function* () {
            const { spaces } = yield* clickup.request({
              operation: "probe",
              method: "GET",
              path: `/team/${encodeURIComponent(team.id)}/space`,
              query: { archived: false },
              decode: Responses.spaces,
              token,
            });
            return yield* Effect.forEach(
              spaces,
              (space) =>
                Effect.all(
                  [
                    clickup.request({
                      operation: "probe",
                      method: "GET",
                      path: `/space/${encodeURIComponent(space.id)}/folder`,
                      query: { archived: false },
                      decode: Responses.folders,
                      token,
                    }),
                    clickup.request({
                      operation: "probe",
                      method: "GET",
                      path: `/space/${encodeURIComponent(space.id)}/list`,
                      query: { archived: false },
                      decode: Responses.lists,
                      token,
                    }),
                  ],
                  { concurrency: 2 },
                ).pipe(
                  Effect.map(([{ folders }, { lists }]) => {
                    const prefix = teams.length > 1 ? [team.name, space.name] : [space.name];
                    return [
                      ...lists.map((list) => ({
                        key: list.id,
                        name: [...prefix, list.name].join(" / "),
                      })),
                      ...folders.flatMap((folder) =>
                        folder.lists.map((list) => ({
                          key: list.id,
                          name: [...prefix, folder.name, list.name].join(" / "),
                        })),
                      ),
                    ];
                  }),
                ),
              { concurrency: SCOPE_CONCURRENCY },
            );
          }),
        { concurrency: SCOPE_CONCURRENCY },
      );
      return perTeam.flat(2);
    });

    const api: StandaloneIssueTrackerApi = {
      kind: ClickUpApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,
      parseIssueUrl: parseClickUpIssueUrl,

      probeCredential: (token) =>
        Effect.all([viewer(token), reachableLists(token)], { concurrency: 2 }).pipe(
          Effect.map(([user, scopes]) => ({
            account: toActor(user).login,
            workspace: CLICKUP_LINK_WORKSPACE,
            scopes,
          })),
        ),

      getViewer: () => viewer().pipe(Effect.map((user) => toActor(user).login)),

      issueScope: (input) =>
        requireTaskId("issueScope", input.key).pipe(
          Effect.flatMap((id) => getTask("issueScope", id)),
          Effect.map((task) => task.list.id),
        ),

      listIssues: Effect.fn("ClickUpIssueTracker.listIssues")(function* (input) {
        const listId = yield* requireListId("listIssues", input.scope);
        const { page, offset } = parseListCursor(input.cursor);
        // ClickUp ORs repeated assignees, so only one narrows the read; the rest filter below.
        const assigneeLogins = [
          ...(input.involvement === "assigned" ? [input.viewer] : []),
          ...(input.assignee === undefined ? [] : [input.assignee]),
        ];
        const narrowBy =
          assigneeLogins[0] === undefined
            ? undefined
            : input.involvement === "assigned"
              ? yield* viewer().pipe(Effect.map((user) => user.id))
              : (yield* listMembers("listIssues", listId)).find((user) =>
                  sameLogin(user, assigneeLogins[0]!),
                )?.id;
        if (assigneeLogins.length > 0 && narrowBy === undefined) {
          return { items: [], nextCursor: null };
        }
        const data = yield* clickup.request({
          operation: "listIssues",
          method: "GET",
          path: `/list/${encodeURIComponent(listId)}/task`,
          query: {
            page,
            order_by: input.sort === "created" ? "created" : "updated",
            subtasks: true,
            include_closed: input.state !== "open",
            assignees: narrowBy === undefined ? undefined : [String(narrowBy)],
            tags: input.labels,
          },
          decode: Responses.tasks,
        });
        const labels = (input.labels ?? []).map((label) => label.toLowerCase());
        const matching = data.tasks
          .filter((task) => {
            const category = toState(task.status).category;
            if (input.state !== "all" && category !== input.state) return false;
            if (
              !assigneeLogins.every((login) =>
                task.assignees.some((user) => sameLogin(user, login)),
              )
            )
              return false;
            if (!labels.every((label) => task.tags.some((tag) => tag.name.toLowerCase() === label)))
              return false;
            if (input.involvement === "authored")
              return task.creator != null && sameLogin(task.creator, input.viewer);
            // ClickUp has no mentions; following a task is the nearest thing.
            if (input.involvement === "mentioned")
              return (task.watchers ?? []).some((user) => sameLogin(user, input.viewer));
            return true;
          })
          .map((task) => toSummary(task))
          .toSorted((a, b) =>
            input.sort === "created"
              ? b.createdAt.localeCompare(a.createdAt)
              : b.updatedAt.localeCompare(a.updatedAt),
          );
        const end = offset + input.limit;
        const lastPage = data.last_page ?? data.tasks.length < TASKS_PAGE;
        return {
          items: matching.slice(offset, end),
          nextCursor: end < matching.length ? `${page}:${end}` : lastPage ? null : `${page + 1}:0`,
        };
      }),

      getIssue: Effect.fn("ClickUpIssueTracker.getIssue")(function* (input) {
        const id = yield* requireTaskId("getIssue", input.key);
        const task = yield* getTask("getIssue", id);
        const [comments, list, me] = yield* Effect.all(
          [
            listComments("getIssue", id),
            getList("getIssue", task.list.id).pipe(Effect.option),
            viewer().pipe(Effect.option),
          ],
          { concurrency: 3 },
        );
        return {
          ...toSummary(task, comments.length),
          body: task.markdown_description ?? task.description ?? "",
          viewer: me._tag === "Some" ? toActor(me.value).login : null,
          viewerPermissions: VIEWER_PERMISSIONS,
          states:
            list._tag === "Some"
              ? listStates(list.value, task.status).map(toState)
              : [toState(task.status)],
          comments: toComments(comments),
          commentsCursor: commentsCursor(comments),
          events: [],
          linkedPullRequests: [],
        };
      }),

      getComments: Effect.fn("ClickUpIssueTracker.getComments")(function* (input) {
        const id = yield* requireTaskId("getComments", input.key);
        const match = /^(\d+):([^:]+)$/.exec(input.cursor);
        if (match === null)
          return yield* failed("getComments", "The comment cursor is not ClickUp's.");
        const comments = yield* listComments("getComments", id, {
          start: match[1]!,
          startId: match[2]!,
        });
        return { comments: toComments(comments), nextCursor: commentsCursor(comments) };
      }),

      create: Effect.fn("ClickUpIssueTracker.create")(function* (input) {
        const listId = yield* requireListId("create", input.scope);
        const list = yield* getList("create", listId);
        const [tags, assignees] = yield* Effect.all(
          [
            tagNames("create", list.space.id, input.labels),
            memberIds("create", listId, input.assignees),
          ],
          { concurrency: 2 },
        );
        const created = yield* clickup.request({
          operation: "create",
          method: "POST",
          path: `/list/${encodeURIComponent(listId)}/task`,
          body: {
            name: input.title,
            ...(input.body === "" ? {} : { markdown_content: input.body }),
            tags,
            assignees,
          },
          decode: Responses.task,
        });
        return { key: created.id, displayKey: displayKeyOf(created), url: created.url };
      }),

      comment: Effect.fn("ClickUpIssueTracker.comment")(function* (input) {
        const id = yield* requireTaskId("comment", input.key);
        yield* clickup.request({
          operation: "comment",
          method: "POST",
          path: `/task/${encodeURIComponent(id)}/comment`,
          body: { comment_text: input.body, notify_all: false },
          decode: Responses.ignored,
        });
      }),

      update: Effect.fn("ClickUpIssueTracker.update")(function* (input) {
        const id = yield* requireTaskId("update", input.key);
        const task =
          input.labels !== undefined || input.assignees !== undefined
            ? yield* getTask("update", id)
            : null;
        const assignees =
          task === null || input.assignees === undefined
            ? undefined
            : yield* memberIds("update", task.list.id, input.assignees);
        const fields = {
          ...(input.title === undefined ? {} : { name: input.title }),
          // ClickUp ignores an empty description; a single space is how it clears one.
          ...(input.body === undefined
            ? {}
            : input.body === ""
              ? { description: " " }
              : { markdown_content: input.body }),
          ...(task === null || assignees === undefined
            ? {}
            : {
                assignees: {
                  add: assignees.filter(
                    (wanted) => !task.assignees.some((user) => user.id === wanted),
                  ),
                  rem: task.assignees
                    .map((user) => user.id)
                    .filter((current) => !assignees.includes(current)),
                },
              }),
        };
        if (Object.keys(fields).length > 0) {
          yield* clickup.request({
            operation: "update",
            method: "PUT",
            path: `/task/${encodeURIComponent(id)}`,
            body: fields,
            decode: Responses.ignored,
          });
        }
        if (task === null || input.labels === undefined) return;
        // ClickUp's update has no tags field; each tag is added or removed on its own.
        const list = yield* getList("update", task.list.id);
        const wanted = yield* tagNames("update", list.space.id, input.labels);
        const has = (name: string, among: ReadonlyArray<string>) =>
          among.some((other) => other.toLowerCase() === name.toLowerCase());
        const current = task.tags.map((tag) => tag.name);
        const writes = [
          ...wanted.filter((name) => !has(name, current)).map((name) => ["POST", name] as const),
          ...current.filter((name) => !has(name, wanted)).map((name) => ["DELETE", name] as const),
        ];
        yield* Effect.forEach(
          writes,
          ([method, name]) =>
            clickup.request({
              operation: "update",
              method,
              path: `/task/${encodeURIComponent(id)}/tag/${encodeURIComponent(name)}`,
              decode: Responses.ignored,
            }),
          { concurrency: SCOPE_CONCURRENCY, discard: true },
        );
      }),

      setState: Effect.fn("ClickUpIssueTracker.setState")(function* (input) {
        const id = yield* requireTaskId("setState", input.key);
        const task = yield* getTask("setState", id);
        const list = yield* getList("setState", task.list.id);
        const wanted = listStates(list, task.status).find(
          (status) => status.status.toLowerCase() === input.state.trim().toLowerCase(),
        );
        if (wanted === undefined)
          return yield* failed("setState", `This list's workflow has no "${input.state}" status.`);
        yield* clickup.request({
          operation: "setState",
          method: "PUT",
          path: `/task/${encodeURIComponent(id)}`,
          body: { status: wanted.status },
          decode: Responses.ignored,
        });
      }),

      listCandidates: Effect.fn("ClickUpIssueTracker.listCandidates")(function* (input) {
        const listId = yield* requireListId("listCandidates", input.scope);
        const list = yield* getList("listCandidates", listId);
        const [tags, members] = yield* Effect.all(
          [spaceTags("listCandidates", list.space.id), listMembers("listCandidates", listId)],
          { concurrency: 2 },
        );
        return {
          labels: tags.map((tag) => ({
            name: tag.name,
            color: tag.tag_bg ?? null,
            description: null,
          })),
          assignees: members.map((user) => ({ ...toActor(user), id: String(user.id) })),
          truncated: false,
        };
      }),
    };
    return api;
  });
