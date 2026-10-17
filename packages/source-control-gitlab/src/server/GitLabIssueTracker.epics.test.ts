import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { IssueDetail, VcsProcessExitError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";

const target = { cwd: "/checkout", host: "gitlab.acme.test:8443", scope: "group:acme", key: "7" };
const decodeDetail = Schema.decodeEffect(IssueDetail);
const isProcessError = Schema.is(VcsProcessExitError);

function item(iid = "7", scope = "acme", group = true) {
  return {
    id: `gid://gitlab/WorkItem/${group ? (scope === "acme" ? "1" : "3") : "2"}${iid}`,
    iid,
    title: group ? "Native epic" : "Native issue",
    webUrl: `https://${target.host}/${group ? "groups/" : ""}${scope}/-/work_items/${iid}`,
    state: "OPEN",
    confidential: false,
    archived: false,
    namespace: { fullPath: scope },
    project: group ? null : { fullPath: scope },
    workItemType: { name: group ? "Epic" : "Issue" },
    userPermissions: { adminParentLink: true },
  };
}

function detail() {
  const actor = { id: "gid://gitlab/User/1", username: "theo", name: "Theo", avatarUrl: null };
  return {
    ...item(),
    description: "Native epic body",
    author: actor,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    closedAt: null,
    widgets: [
      {
        __typename: "WorkItemWidgetNotes",
        discussions: {
          nodes: [
            { id: "gid://gitlab/LabelNote/label-sha", body: "added ~101 label" },
            { id: "gid://gitlab/StateNote/state-sha", body: "closed" },
            {
              id: "gid://gitlab/MilestoneNote/milestone-sha",
              body: "changed milestone to %release",
            },
          ].map((note) => ({
            notes: {
              nodes: [
                {
                  ...note,
                  author: actor,
                  system: true,
                  createdAt: "2026-10-02T01:00:00Z",
                  lastEditedAt: null,
                  url: null,
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          })),
          pageInfo: { hasNextPage: true, endCursor: "older-activity" as string | null },
        },
        notes: {
          nodes: [
            {
              id: "gid://gitlab/Note/11",
              body: "Native epic comment",
              createdAt: "2026-10-02T00:00:00Z",
              lastEditedAt: "2026-10-02T00:30:00Z",
              author: actor,
              system: false,
              url: `https://${target.host}/groups/acme/-/epics/7#note_11`,
            },
            {
              id: "gid://gitlab/Note/12",
              body: "changed title",
              createdAt: "2026-10-02T01:00:00Z",
              lastEditedAt: null,
              author: actor,
              system: true,
              url: null,
            },
          ],
          pageInfo: { hasPreviousPage: true, startCursor: "older-notes" as string | null },
        },
      },
      { __typename: "WorkItemWidgetAssignees", assignees: { nodes: [actor] } },
      {
        __typename: "WorkItemWidgetLabels",
        labels: {
          nodes: [{ title: "roadmap", color: "#abcdef" }],
          pageInfo: { hasNextPage: false },
        },
      },
    ],
  };
}

function tracker(answer: (body: Record<string, unknown>) => unknown) {
  return GitLabIssueTracker.make.pipe(
    Effect.provide(
      GitLabCli.layer.pipe(
        Layer.provide(
          TestSourceControlHost.layer({
            process: {
              run: (request) => {
                expect(request.cwd).toBe(target.cwd);
                expect(request.args[1]).toBe("graphql");
                expect(request.args[request.args.indexOf("--hostname") + 1]).toBe(target.host);
                const reply = answer(JSON.parse(request.stdin!));
                return isProcessError(reply)
                  ? Effect.fail(reply)
                  : Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(reply)));
              },
            },
          }),
        ),
      ),
    ),
  );
}

it.effect("reads a group epic and real notes without a project REST fallback", () =>
  Effect.gen(function* () {
    const requests: Record<string, unknown>[] = [];
    const api = yield* tracker((body) => {
      requests.push(body);
      expect(body.variables).toEqual({
        fullPath: "acme",
        iid: "7",
        before: null,
        includeHistory: true,
        first: 100,
        after: null,
      });
      expect(body.query).toContain("notes(last: 100, before: $before)");
      expect(body.query).toContain("filter: ONLY_ACTIVITY, sort: CREATED_DESC");
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: detail() } } };
    });
    const issue = yield* api.getIssue(target);
    yield* decodeDetail({
      ...issue,
      ...target,
      tracker: "gitlab",
      projectId: "project-1",
      projectTitle: "Web",
      writable: false,
      capabilities: issue.capabilities ?? api.capabilities,
    });
    expect(issue).toMatchObject({
      key: "7",
      displayKey: "&7",
      itemType: "Epic",
      title: "Native epic",
      body: "Native epic body",
      author: { login: "theo" },
      assignees: [{ login: "theo" }],
      labels: [{ name: "roadmap", color: "#abcdef" }],
      comments: [{ body: "Native epic comment", canEdit: false, editedAt: "2026-10-02T00:30:00Z" }],
      commentsCursor: expect.any(String),
      events: [
        { id: "gid://gitlab/LabelNote/label-sha", kind: "labeled", detail: "added ~101 label" },
        { id: "gid://gitlab/StateNote/state-sha", kind: "closed" },
        { id: "gid://gitlab/MilestoneNote/milestone-sha", detail: "changed milestone to %release" },
      ],
      historyTruncated: true,
      capabilities: {
        create: false,
        edit: false,
        comment: false,
        subIssues: true,
        updateParent: false,
      },
      viewerPermissions: { edit: false, comment: false, setState: false, updateParent: false },
    });
    expect(requests).toHaveLength(1);
    expect(yield* api.getViewerPermissions(target)).toMatchObject({
      edit: false,
      updateParent: false,
    });
    expect(requests).toHaveLength(1);
  }),
);

it.effect("pages real group epic comments and system history with one native request each", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((body) => {
      calls++;
      expect(body.variables).toEqual(
        String(body.query).includes("notes(last:")
          ? {
              fullPath: "acme",
              iid: "7",
              before: calls === 1 ? null : "older-notes",
              includeHistory: false,
              first: 100,
              after: null,
            }
          : { fullPath: "acme", iid: "7", first: 3, after: calls === 3 ? null : "older-activity" },
      );
      const epic = detail();
      if (calls === 2) {
        epic.widgets[0]!.notes!.nodes[0]!.id = "gid://gitlab/Note/10";
        epic.widgets[0]!.notes!.nodes[1]!.id = "gid://gitlab/Note/9";
        epic.widgets[0]!.notes!.pageInfo = { hasPreviousPage: false, startCursor: "first-note" };
      }
      if (calls === 3)
        for (const discussion of epic.widgets[0]!.discussions!.nodes)
          discussion.notes.nodes[0]!.id += "-first";
      if (calls === 4)
        epic.widgets[0]!.discussions!.pageInfo = { hasNextPage: false, endCursor: null };
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: epic } } };
    });
    const firstComments = yield* api.getComments(target);
    expect(calls).toBe(1);
    const comments = yield* api.getComments({ ...target, cursor: firstComments.nextCursor! });
    expect(comments.comments).toMatchObject([{ body: "Native epic comment" }]);
    expect(comments.nextCursor).toBeNull();
    const firstHistory = yield* api.getHistory!({ ...target, limit: 3 });
    expect(calls).toBe(3);
    const history = yield* api.getHistory!({
      ...target,
      cursor: firstHistory.nextCursor!,
      limit: 3,
    });
    expect(history.items).toMatchObject([
      { id: "gid://gitlab/LabelNote/label-sha", kind: "labeled" },
      { id: "gid://gitlab/StateNote/state-sha", kind: "closed" },
      { id: "gid://gitlab/MilestoneNote/milestone-sha", kind: "updated" },
    ]);
    expect(history.nextCursor).toBeNull();
    expect(calls).toBe(4);
  }),
);

it.effect("keeps group and project children with the same IID separate", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((body) => {
      calls++;
      expect(body.variables).toEqual({ fullPath: "acme", iid: "7", first: 2 });
      return {
        data: {
          namespace: {
            workItem: {
              ...item(),
              widgets: [
                {
                  __typename: "WorkItemWidgetHierarchy",
                  parent: item("8"),
                  children: {
                    nodes: [item("7", "acme/web", false), item("7", "acme/sub")],
                    pageInfo: { hasNextPage: true, endCursor: "more-children" },
                  },
                },
              ],
            },
          },
        },
      };
    });
    const page = yield* api.getHierarchy!({ ...target, limit: 2 });
    expect(page.parent).toMatchObject({ scope: "group:acme", key: "8", itemType: "Epic" });
    expect(page.children.items).toMatchObject([
      { scope: "acme/web", key: "7", itemType: "Issue" },
      { scope: "group:acme/sub", key: "7", itemType: "Epic" },
    ]);
    expect(page.children.items.every((child) => child.externalOnly !== true)).toBe(true);
    expect(page.children.nextCursor).toBe("more-children");
    expect(calls).toBe(1);
  }),
);

it.effect("keeps native cross-group issue and epic children with matching IIDs", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker(() => {
      calls++;
      return {
        data: {
          namespace: {
            workItem: {
              ...item(),
              widgets: [
                {
                  __typename: "WorkItemWidgetHierarchy",
                  parent: item("8", "foreign"),
                  children: {
                    nodes: [item("7", "other/web", false), item("7", "other")],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
            },
          },
        },
      };
    });
    const page = yield* api.getHierarchy!(target);
    expect(page.parent).toMatchObject({ scope: "group:foreign", key: "8" });
    expect(page.children.items).toMatchObject([
      { scope: "other/web", key: "7" },
      { scope: "group:other", key: "7" },
    ]);
    expect(calls).toBe(1);
  }),
);

it.effect("reads a project issue with a native parent in an unrelated group", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker(() => {
      calls++;
      return {
        data: {
          namespace: {
            workItem: {
              ...item("7", "other/web", false),
              widgets: [
                {
                  __typename: "WorkItemWidgetHierarchy",
                  parent: item(),
                  children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              ],
            },
          },
        },
      };
    });
    const page = yield* api.getHierarchy!({ ...target, scope: "other/web" });
    expect(page.parent).toMatchObject({ scope: "group:acme", key: "7" });
    expect(calls).toBe(1);
  }),
);

it.effect.each(["authentication", "rate-limited", "command-failed"] as const)(
  "propagates native group %s without a retry or project fallback",
  (failureKind) =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* tracker(() => {
        calls++;
        return new VcsProcessExitError({
          operation: "execute",
          command: "glab",
          cwd: target.cwd,
          exitCode: 1,
          detail: "Native refusal",
          failureKind,
        });
      });
      const reason =
        failureKind === "authentication"
          ? "unauthenticated"
          : failureKind === "rate-limited"
            ? "rate-limited"
            : "failed";
      expect((yield* Effect.flip(api.getIssue(target))).reason).toBe(reason);
      expect((yield* Effect.flip(api.getHierarchy!(target))).reason).toBe(reason);
      expect((yield* Effect.flip(api.getComments(target))).reason).toBe(reason);
      expect((yield* Effect.flip(api.getHistory!(target))).reason).toBe(reason);
      expect(calls).toBe(4);
    }),
);

it.effect.each([
  "missing continuation",
  "repeated continuation",
  "too many discussions",
  "nested continuation",
  "too many nested notes",
  "empty notes",
  "comment in activity",
  "duplicate activity",
])("rejects an activity page with %s in one request", (failure) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((body) => {
      calls++;
      expect(body.variables).toEqual({
        fullPath: "acme",
        iid: "7",
        first: 3,
        after: calls === 1 ? null : "older-activity",
      });
      expect(body.query).not.toContain("notes(last:");
      expect(body.query).toContain("notes(first: 1)");
      const selected = detail();
      const activity = selected.widgets[0]!.discussions!;
      if (calls === 1) {
        for (const discussion of activity.nodes) discussion.notes.nodes[0]!.id += "-initial";
        return { data: { namespace: { workItem: selected } } };
      }
      activity.pageInfo.endCursor = "next-older-activity";
      if (failure === "missing continuation") activity.pageInfo.endCursor = null;
      if (failure === "repeated continuation") activity.pageInfo.endCursor = "older-activity";
      if (failure === "too many discussions") activity.nodes.push(activity.nodes[0]!);
      if (failure === "nested continuation") activity.nodes[0]!.notes.pageInfo.hasNextPage = true;
      if (failure === "too many nested notes")
        activity.nodes[0]!.notes.nodes.push(activity.nodes[0]!.notes.nodes[0]!);
      if (failure === "empty notes") activity.nodes[0]!.notes.nodes = [];
      if (failure === "comment in activity") activity.nodes[0]!.notes.nodes[0]!.system = false;
      if (failure === "duplicate activity") activity.nodes[1] = activity.nodes[0]!;
      return { data: { namespace: { workItem: selected } } };
    });
    const initial = yield* api.getHistory!({ ...target, limit: 3 });
    expect(
      (yield* Effect.flip(api.getHistory!({ ...target, cursor: initial.nextCursor!, limit: 3 })))
        .reason,
    ).toBe("failed");
    expect(calls).toBe(2);
  }),
);

it.effect.each([false, true])(
  "keeps comment and history continuation independent: %s",
  (moreHistory) =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* tracker(() => {
        calls++;
        const selected = detail();
        selected.widgets[0]!.notes!.pageInfo.hasPreviousPage = !moreHistory;
        selected.widgets[0]!.discussions!.pageInfo.hasNextPage = moreHistory;
        return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
      });
      const issue = yield* api.getIssue(target);
      expect(issue.commentsCursor).toEqual(moreHistory ? null : expect.any(String));
      expect(issue.historyTruncated).toBe(moreHistory);
      const history = yield* api.getHistory!(target);
      expect(history.nextCursor).toEqual(moreHistory ? expect.any(String) : null);
      expect(calls).toBe(2);
    }),
);

it.effect("keeps comment rows beyond a 200-reply discussion limit", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((body) => {
      expect(body.query).toContain("notes(last: 100, before: $before)");
      expect(body.variables).toMatchObject({
        includeHistory: false,
        before: calls === 0 ? null : `page-${calls + 1}`,
      });
      const selected = detail();
      const page = selected.widgets[0]!.notes!;
      page.nodes = Array.from({ length: calls < 2 ? 100 : 1 }, (_, index) => ({
        ...page.nodes[0]!,
        id: `gid://gitlab/Note/${calls * 100 + index + 1}`,
      }));
      page.pageInfo = { hasPreviousPage: calls < 2, startCursor: `page-${calls + 2}` };
      calls++;
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
      const page = yield* api.getComments({
        ...target,
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.comments.map((comment) => comment.id));
      expect(page.nextCursor).toEqual(pageNumber < 3 ? expect.any(String) : null);
      cursor = page.nextCursor ?? undefined;
    }
    expect(new Set(ids).size).toBe(201);
    expect(calls).toBe(3);
  }),
);

it.effect(
  "refuses mixed comment/history cursors and invalid history limits without a request",
  () =>
    Effect.gen(function* () {
      const api = yield* tracker(() => {
        throw new Error("No request allowed");
      });
      yield* Effect.flip(api.getHistory!({ ...target, cursor: "older-notes" }));
      yield* Effect.flip(api.getHistory!({ ...target, cursor: "activity:" }));
      yield* Effect.flip(api.getHistory!({ ...target, limit: 0 }));
      yield* Effect.flip(api.getComments({ ...target, cursor: "activity:older-activity" }));
    }),
);

it.effect.each([
  {
    name: "project Issue",
    selected: { ...detail(), project: { fullPath: "acme" }, workItemType: { name: "Issue" } },
  },
  { name: "wrong namespace", selected: { ...detail(), namespace: { fullPath: "other" } } },
  { name: "wrong IID", selected: { ...detail(), iid: "8" } },
  {
    name: "foreign host",
    selected: { ...detail(), webUrl: "https://other.test/groups/acme/-/epics/7" },
  },
  {
    name: "project URL",
    selected: { ...detail(), webUrl: `https://${target.host}/acme/-/issues/7` },
  },
  { name: "not found", selected: null },
])("rejects a group epic response with $name", ({ selected }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker(() => {
      calls++;
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
    });
    yield* Effect.flip(api.getIssue(target));
    expect(calls).toBe(1);
  }),
);

it.effect.each(["group:acme", "GROUP:acme"])("refuses every %s write before any request", (scope) =>
  Effect.gen(function* () {
    const group = { ...target, scope };
    const api = yield* tracker(() => {
      throw new Error("No native request allowed");
    });
    yield* Effect.flip(
      api.create!({ ...group, title: "Epic", body: "", labels: [], assignees: [] }),
    );
    yield* Effect.flip(api.setParent!({ ...group, parentKey: null }));
    yield* Effect.flip(api.comment!({ ...group, body: "Comment" }));
    yield* Effect.flip(api.editComment!({ ...group, commentId: "11", body: "Edit" }));
    yield* Effect.flip(api.update!({ ...group, title: "Edit" }));
    yield* Effect.flip(api.setState!({ ...group, state: "closed" }));
    yield* Effect.flip(api.setReaction!({ ...group, content: "thumbs-up", reacted: true }));
  }),
);

it.effect.each([
  "group:",
  "GROUP:acme",
  "group:acme/../web",
  "group:acme//web",
  "group:acme%2fweb",
])("rejects malformed group scope %s before native or project requests", (scope) =>
  Effect.gen(function* () {
    const api = yield* tracker(() => {
      throw new Error("No request allowed");
    });
    yield* Effect.flip(api.getIssue({ ...target, scope }));
    yield* Effect.flip(api.getHierarchy!({ ...target, scope }));
    yield* Effect.flip(
      api.create!({ ...target, scope, title: "Epic", body: "", labels: [], assignees: [] }),
    );
  }),
);

it.effect.each([
  "missing continuation",
  "repeated continuation",
  "too many notes",
  "missing notes widget",
])("rejects %s without hiding an incomplete epic conversation", (failure) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker(() => {
      calls++;
      const selected = detail();
      const page = selected.widgets[0]!.notes!;
      if (calls === 1)
        return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
      page.pageInfo.startCursor = "next-older-notes";
      if (failure === "missing continuation") page.pageInfo.startCursor = null;
      if (failure === "repeated continuation") page.pageInfo.startCursor = "older-notes";
      if (failure === "too many notes")
        page.nodes = Array.from({ length: 101 }, () => page.nodes[0]!);
      if (failure === "missing notes widget") selected.widgets = [];
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
    });
    const initial = yield* api.getComments(target);
    yield* Effect.flip(api.getComments({ ...target, cursor: initial.nextCursor! }));
    expect(calls).toBe(2);
  }),
);

it.effect.each([
  { stream: "comments", order: "asc" },
  { stream: "comments", order: "desc" },
  { stream: "history", order: "asc" },
  { stream: "history", order: "desc" },
] as const)("pages epic $stream globally in $order order", ({ stream, order }) =>
  Effect.gen(function* () {
    const input = { ...target, connectionId: "account-a", order };
    const count = stream === "comments" ? 205 : 83;
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `gid://gitlab/Note/${index + 1}`,
      body: stream === "comments" ? `Reply ${index + 1}` : "changed the description",
      system: stream === "history",
      createdAt: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe("2026-10-01T00:00:00Z"), { minutes: index }),
      ),
      lastEditedAt: null,
      url: `https://${target.host}/groups/acme/-/epics/7#note_${index + 1}`,
      author: null,
    }));
    let calls = 0;
    const api = yield* tracker((body) => {
      calls++;
      const variables = body.variables as {
        before?: string | null;
        after?: string | null;
        first: number;
      };
      const selected = detail();
      if (stream === "comments") {
        const backwards = String(body.query).includes("notes(last:");
        expect(backwards).toBe(order === "desc");
        const edge = variables.before == null ? (backwards ? count : 0) : Number(variables.before);
        const start = backwards ? Math.max(0, edge - 100) : edge;
        const end = backwards ? edge : Math.min(count, start + 100);
        Object.assign(selected.widgets[0]!.notes!, { nodes: rows.slice(start, end) });
        selected.widgets[0]!.notes!.pageInfo = {
          hasPreviousPage: backwards ? start > 0 : end < count,
          startCursor: String(backwards ? start : end),
        };
      } else {
        expect(body.query).toContain(order === "asc" ? "sort: CREATED_ASC" : "sort: CREATED_DESC");
        const start = variables.after == null ? 0 : Number(variables.after);
        const end = Math.min(count, start + variables.first);
        Object.assign(selected.widgets[0]!.discussions!, {
          nodes: (order === "asc" ? rows : rows.toReversed())
            .slice(start, end)
            .map((note) => ({ notes: { nodes: [note], pageInfo: { hasNextPage: false } } })),
        });
        selected.widgets[0]!.discussions!.pageInfo = {
          hasNextPage: end < count,
          endCursor: String(end),
        };
      }
      return { data: { currentUser: { username: "theo" }, namespace: { workItem: selected } } };
    });
    let cursor: string | undefined;
    const ids: string[] = [];
    for (let page = 0; page < 3; page++) {
      const result =
        stream === "comments"
          ? yield* api.getComments({ ...input, ...(cursor === undefined ? {} : { cursor }) })
          : yield* api.getHistory!({
              ...input,
              limit: 31,
              ...(cursor === undefined ? {} : { cursor }),
            });
      const items = "comments" in result ? result.comments : result.items;
      ids.push(...items.map(({ id }) => id));
      expect(
        items.every((item) =>
          item.url?.startsWith(`https://${target.host}/groups/acme/-/epics/7#note_`),
        ),
      ).toBe(true);
      if (page === 0) {
        if (stream === "comments")
          yield* Effect.flip(api.getHistory!({ ...input, cursor: result.nextCursor! }));
        else yield* Effect.flip(api.getComments({ ...input, cursor: result.nextCursor! }));
        for (const changed of [
          { connectionId: "other" },
          { cwd: "/other" },
          { host: "other.test" },
          { scope: "group:other" },
          { key: "8" },
          { order: order === "asc" ? ("desc" as const) : ("asc" as const) },
        ]) {
          if (stream === "comments")
            yield* Effect.flip(
              api.getComments({ ...input, ...changed, cursor: result.nextCursor! }),
            );
          else
            yield* Effect.flip(
              api.getHistory!({ ...input, ...changed, cursor: result.nextCursor! }),
            );
        }
        expect(calls).toBe(1);
      }
      expect(result.nextCursor).toEqual(page < 2 ? expect.any(String) : null);
      cursor = result.nextCursor ?? undefined;
    }
    const expected = rows.map(({ id }) => id);
    expect(ids).toEqual(order === "asc" ? expected : expected.toReversed());
    expect(new Set(ids).size).toBe(count);
    expect(calls).toBe(3);
  }),
);
