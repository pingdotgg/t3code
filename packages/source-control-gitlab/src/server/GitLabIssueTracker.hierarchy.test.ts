import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { IssueHierarchyPage, VcsProcessExitError } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";
import { decodeIssueListJson } from "./gitLabIssueJson.ts";

const target = { cwd: "/checkout", host: "gitlab.acme.test:8443", scope: "acme/web", key: "42" };
const decodeHierarchy = Schema.decodeEffect(IssueHierarchyPage);

it.effect.each([
  {
    name: "unsupported schema",
    reply: { errors: [{ message: "Field 'workItem' doesn't exist on type 'Namespace'" }] },
  },
  { name: "missing namespace", reply: { data: { namespace: null } } },
  { name: "missing work item", reply: { data: { namespace: { workItem: null } } } },
  { name: "unreadable work item", reply: { data: { namespace: { workItem: { iid: "42" } } } } },
  {
    name: "missing hierarchy widget",
    reply: { data: { namespace: { workItem: { ...item("42", "Task"), widgets: [] } } } },
  },
])("does not grant native Task parent permission with $name", ({ reply }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((_args, body) => {
      calls++;
      return String(body.query).includes("updateIssue")
        ? {
            data: {
              project: {
                archived: false,
                mergeRequest: {
                  type: "TASK",
                  state: "opened",
                  userPermissions: {
                    updateIssue: true,
                    reopenIssue: true,
                    createNote: true,
                    adminIssue: true,
                  },
                },
              },
            },
          }
        : reply;
    });
    expect(yield* api.getViewerPermissions(target)).toMatchObject({
      edit: true,
      comment: true,
      updateParent: false,
    });
    expect(calls).toBe(2);
  }),
);

function item(iid: string, type = "Issue") {
  return {
    id: `gid://gitlab/WorkItem/${Number(iid) + 1000}`,
    iid,
    title: `${type} ${iid}`,
    webUrl: `https://gitlab.acme.test:8443/acme/web/-/work_items/${iid}`,
    state: "OPEN",
    confidential: false,
    archived: false,
    namespace: { fullPath: "acme/web" },
    project: { fullPath: "acme/web" },
    workItemType: { name: type },
    userPermissions: { adminParentLink: true },
  };
}

function hierarchy(parent: unknown, children = [item("43", "Task")]) {
  return [
    {
      __typename: "WorkItemWidgetHierarchy",
      parent,
      children: {
        nodes: children,
        pageInfo: { hasNextPage: false, endCursor: null as string | null },
      },
    },
  ];
}

function tracker(answer: (args: ReadonlyArray<string>, body: Record<string, unknown>) => unknown) {
  return GitLabIssueTracker.make.pipe(
    Effect.provide(
      GitLabCli.layer.pipe(
        Layer.provide(
          TestSourceControlHost.layer({
            process: {
              run: (request) => {
                expect(request.cwd).toBe("/checkout");
                expect(request.args[request.args.indexOf("--hostname") + 1]).toBe(target.host);
                const body = request.stdin === undefined ? {} : JSON.parse(request.stdin);
                const response = JSON.stringify(answer(request.args, body));
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    request.args.includes("--include")
                      ? `HTTP/2.0 200 OK\r\nX-Next-Page: \r\nX-Total-Pages: 1\r\n\r\n${response}`
                      : response,
                  ),
                );
              },
            },
          }),
        ),
      ),
    ),
  );
}

it.effect("reads one native task page and preserves a group epic as an internal parent", () =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((args, body) => {
      calls++;
      expect(args[1]).toBe("graphql");
      expect(body.variables).toEqual({
        fullPath: "acme/web",
        iid: "42",
        first: 100,
        after: "page-1",
      });
      expect(body.query).toContain("children(first: $first, after: $after)");
      const epic = {
        ...item("7", "Epic"),
        project: null,
        namespace: { fullPath: "acme" },
        webUrl: "https://gitlab.acme.test:8443/groups/acme/-/epics/7",
      };
      const widgets = hierarchy(epic);
      widgets[0]!.children.pageInfo = { hasNextPage: true, endCursor: "page-2" };
      return { data: { namespace: { workItem: { ...item("42"), widgets } } } };
    });
    expect(api.capabilities.subIssues).toBe(true);
    const page = yield* decodeHierarchy(
      yield* api.getHierarchy!({ ...target, cursor: "page-1", limit: 200 }),
    );
    expect(calls).toBe(1);
    expect(page.parent).toMatchObject({
      scope: "group:acme",
      key: "7",
      itemType: "Epic",
    });
    expect(page.parent?.externalOnly).not.toBe(true);
    expect(page.children.items).toMatchObject([{ scope: "acme/web", key: "43", itemType: "Task" }]);
    expect(page.children.nextCursor).toBe("page-2");
  }),
);

it.effect.each([{ parentKey: "8" }, { parentKey: null }])(
  "reparents or unlinks a native task without a preliminary unlink: $parentKey",
  ({ parentKey }) =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = [];
      const child = { ...item("42", "Task"), widgets: hierarchy(item("9"), []) };
      const api = yield* tracker((args, body) => {
        expect(args[1]).toBe("graphql");
        requests.push(body);
        const variables = body.variables as {
          iid?: string;
          input?: { id: string; hierarchyWidget: { parentId: string | null } };
        };
        if (variables.input !== undefined) {
          expect(variables.input).toEqual({
            id: "gid://gitlab/WorkItem/1042",
            hierarchyWidget: { parentId: parentKey === null ? null : "gid://gitlab/WorkItem/1008" },
          });
          return {
            data: {
              workItemUpdate: {
                errors: [],
                workItem: {
                  ...child,
                  widgets: hierarchy(parentKey === null ? null : item("8"), []),
                },
              },
            },
          };
        }
        return {
          data: {
            namespace: {
              workItem:
                variables.iid === "42" ? child : { ...item("8"), widgets: hierarchy(null, []) },
            },
          },
        };
      });
      yield* api.setParent!({ ...target, parentKey });
      expect(requests).toHaveLength(parentKey === null ? 2 : 3);
      expect(requests.filter((body) => String(body.query).startsWith("mutation"))).toHaveLength(1);
    }),
);

it.effect.each([false, true])(
  "creates one confidential native Task with saved metadata and reports link failure: %s",
  (linkFails) =>
    Effect.gen(function* () {
      let creates = 0;
      const requests: string[] = [];
      const parent = { ...item("42"), confidential: true, widgets: hierarchy(null, []) };
      const child = { ...item("43", "Task"), confidential: true, widgets: hierarchy(null, []) };
      const api = yield* tracker((args, body) => {
        requests.push(args[1]!);
        if (args[1] !== "graphql") {
          creates++;
          expect(args[1]).toBe("projects/acme%2Fweb/issues");
          expect(body).toEqual({
            title: "Task",
            description: "Body",
            labels: "bug",
            assignee_ids: [2],
            issue_type: "task",
            confidential: true,
          });
          return {
            iid: 43,
            title: "Task",
            web_url: child.webUrl,
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
            issue_type: "task",
            labels: ["bug"],
            assignees: [{ id: 2, username: "theo" }],
          };
        }
        const variables = body.variables as { iid?: string; input?: unknown };
        if (variables.input !== undefined) {
          return {
            data: {
              workItemUpdate: {
                errors: linkFails ? ["Parent access was removed"] : [],
                workItem: linkFails ? null : { ...child, widgets: hierarchy(parent, []) },
              },
            },
          };
        }
        return { data: { namespace: { workItem: variables.iid === "42" ? parent : child } } };
      });
      const created = yield* api.create!({
        ...target,
        parentKey: "42",
        title: "Task",
        body: "Body",
        labels: ["bug"],
        assignees: ["2"],
      });
      expect(creates).toBe(1);
      expect(requests).toHaveLength(4);
      expect(created).toMatchObject({ key: "43", url: child.webUrl, parentLinked: !linkFails });
      expect(created.warnings).toHaveLength(linkFails ? 1 : 0);
      if (linkFails) expect(created.warnings?.[0]).toContain("Parent access was removed");
    }),
);

it.effect("checks native Task parent permission separately from edit permission", () =>
  Effect.gen(function* () {
    const queries: string[] = [];
    const api = yield* tracker((_args, body) => {
      const query = String(body.query);
      queries.push(query);
      if (query.includes("updateIssue"))
        return {
          data: {
            project: {
              archived: false,
              mergeRequest: {
                type: "TASK",
                state: "opened",
                userPermissions: {
                  updateIssue: false,
                  reopenIssue: false,
                  createNote: true,
                  adminIssue: false,
                },
              },
            },
          },
        };
      return {
        data: {
          namespace: { workItem: { ...item("42", "Task"), widgets: hierarchy(item("9"), []) } },
        },
      };
    });
    const permissions = yield* api.getViewerPermissions(target);
    expect(permissions.edit).toBe(false);
    expect(permissions).toMatchObject({ updateParent: true });
    expect(queries).toHaveLength(2);
  }),
);

it.effect.each([
  {
    name: "Issue as a child",
    child: { ...item("42"), widgets: hierarchy(null, []) },
    parent: item("8"),
    parentKey: "8",
  },
  {
    name: "denied child permission",
    child: {
      ...item("42", "Task"),
      userPermissions: { adminParentLink: false },
      widgets: hierarchy(null, []),
    },
    parent: item("8"),
    parentKey: "8",
  },
  {
    name: "archived child",
    child: { ...item("42", "Task"), archived: true, widgets: hierarchy(null, []) },
    parent: item("8"),
    parentKey: "8",
  },
  {
    name: "Task as a parent",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: item("8", "Task"),
    parentKey: "8",
  },
  {
    name: "denied parent permission",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: { ...item("8"), userPermissions: { adminParentLink: false } },
    parentKey: "8",
  },
  {
    name: "archived parent",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: { ...item("8"), archived: true },
    parentKey: "8",
  },
  {
    name: "parent from another project",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: { ...item("8"), project: { fullPath: "acme/other" } },
    parentKey: "8",
  },
  {
    name: "non-confidential Task under confidential parent",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: { ...item("8"), confidential: true },
    parentKey: "8",
  },
  {
    name: "unlink denied by old parent",
    child: {
      ...item("42", "Task"),
      widgets: hierarchy({ ...item("9"), userPermissions: { adminParentLink: false } }, []),
    },
    parent: item("8"),
    parentKey: null,
  },
  {
    name: "group Epic parent",
    child: { ...item("42", "Task"), widgets: hierarchy(null, []) },
    parent: { ...item("8", "Epic"), project: null, namespace: { fullPath: "acme" } },
    parentKey: "8",
  },
])("refuses $name before any native mutation", ({ child, parent, parentKey }) =>
  Effect.gen(function* () {
    let mutations = 0;
    const api = yield* tracker((_args, body) => {
      const variables = body.variables as { iid: string; input?: unknown };
      if (variables.input !== undefined) mutations++;
      return {
        data: {
          namespace: {
            workItem: {
              ...(variables.iid === "42" ? child : parent),
              widgets: variables.iid === "42" ? child.widgets : hierarchy(null, []),
            },
          },
        },
      };
    });
    const error = yield* Effect.flip(api.setParent!({ ...target, parentKey }));
    expect(error.reason).toBe("failed");
    expect(mutations).toBe(0);
  }),
);

it.effect.each(["authentication", "rate-limited"] as const)(
  "keeps native %s failures on hierarchy reads without a retry",
  (failureKind) =>
    Effect.gen(function* () {
      let calls = 0;
      const host = TestSourceControlHost.layer({
        process: {
          run: () => {
            calls++;
            return Effect.fail(
              new VcsProcessExitError({
                operation: "execute",
                command: "glab",
                cwd: target.cwd,
                exitCode: 1,
                detail: "Native refusal",
                failureKind,
              }),
            );
          },
        },
      });
      const api = yield* GitLabIssueTracker.make.pipe(
        Effect.provide(GitLabCli.layer.pipe(Layer.provide(host))),
      );
      const error = yield* Effect.flip(api.getHierarchy!(target));
      expect(error.reason).toBe(
        failureKind === "authentication" ? "unauthenticated" : "rate-limited",
      );
      expect(calls).toBe(1);
    }),
);

it.effect.each(["authentication", "rate-limited"] as const)(
  "keeps native %s errors from Task permissions and the optional parent lookup",
  (failureKind) =>
    Effect.gen(function* () {
      for (const optional of [false, true]) {
        const calls: string[] = [];
        const api = yield* GitLabIssueTracker.make.pipe(
          Effect.provide(
            GitLabCli.layer.pipe(
              Layer.provide(
                TestSourceControlHost.layer({
                  process: {
                    run: (request) => {
                      calls.push(request.args[1]!);
                      const body = request.stdin === undefined ? {} : JSON.parse(request.stdin);
                      if (
                        request.args[1] === "graphql" &&
                        String(body.query).includes("namespace(fullPath:") === optional
                      )
                        return Effect.fail(
                          new VcsProcessExitError({
                            operation: "execute",
                            command: "glab",
                            cwd: target.cwd,
                            exitCode: 1,
                            detail: "Native refusal",
                            failureKind,
                          }),
                        );
                      const reply =
                        request.args[1] === "projects/acme%2Fweb/issues/42"
                          ? {
                              iid: 42,
                              title: "Task 42",
                              web_url: item("42", "Task").webUrl,
                              issue_type: "task",
                              created_at: "2026-07-01T00:00:00Z",
                              updated_at: "2026-07-01T00:00:00Z",
                            }
                          : request.args[1] !== "graphql"
                            ? []
                            : {
                                data: {
                                  currentUser: { username: "guest" },
                                  project: {
                                    archived: false,
                                    mergeRequest: {
                                      type: "TASK",
                                      state: "opened",
                                      userPermissions: {
                                        updateIssue: true,
                                        reopenIssue: true,
                                        createNote: true,
                                        adminIssue: true,
                                      },
                                      notes: {
                                        pageInfo: { hasPreviousPage: false, startCursor: null },
                                        nodes: [],
                                      },
                                    },
                                  },
                                },
                              };
                      return Effect.succeed(
                        TestSourceControlHost.processOutput(JSON.stringify(reply)),
                      );
                    },
                  },
                }),
              ),
            ),
          ),
        );
        const detailError = yield* Effect.flip(api.getIssue(target));
        expect(detailError.reason).toBe(
          failureKind === "authentication" ? "unauthenticated" : "rate-limited",
        );
        expect(calls.length).toBeLessThanOrEqual(optional ? 9 : 8);
        expect(calls.filter((path) => path === "graphql")).toHaveLength(optional ? 2 : 1);
        calls.length = 0;
        const permissionsError = yield* Effect.flip(api.getViewerPermissions(target));
        expect(permissionsError.reason).toBe(detailError.reason);
        expect(calls).toHaveLength(optional ? 2 : 1);
      }
    }),
);

it.effect.each([
  "missing data",
  "wrong parent",
  "wrong item",
  "payload errors",
  "top-level errors",
])("does not acknowledge a parent mutation with %s", (failure) =>
  Effect.gen(function* () {
    let mutations = 0;
    const api = yield* tracker((_args, body) => {
      const variables = body.variables as { iid?: string; input?: unknown };
      if (variables.input !== undefined) {
        mutations++;
        if (failure === "missing data")
          return { data: { workItemUpdate: { errors: [], workItem: null } } };
        const workItem = {
          ...item(failure === "wrong item" ? "99" : "42", "Task"),
          widgets: hierarchy(item(failure === "wrong parent" ? "9" : "8"), []),
        };
        return {
          ...(failure === "top-level errors"
            ? { errors: [{ message: "Partial mutation failure" }] }
            : {}),
          data: {
            workItemUpdate: {
              errors: failure === "payload errors" ? ["Cannot set parent"] : [],
              workItem,
            },
          },
        };
      }
      return {
        data: {
          namespace: {
            workItem: {
              ...item(variables.iid!, variables.iid === "42" ? "Task" : "Issue"),
              widgets: hierarchy(null, []),
            },
          },
        },
      };
    });
    yield* Effect.flip(api.setParent!({ ...target, parentKey: "8" }));
    expect(mutations).toBe(1);
  }),
);

it.effect("reports a silently changed created type without linking or creating again", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const api = yield* tracker((args) => {
      paths.push(args[1]!);
      return args[1] === "graphql"
        ? { data: { namespace: { workItem: { ...item("42"), widgets: hierarchy(null, []) } } } }
        : {
            iid: 43,
            title: "Issue",
            web_url: item("43").webUrl,
            issue_type: "issue",
            created_at: "2026-07-01T00:00:00Z",
            updated_at: "2026-07-01T00:00:00Z",
          };
    });
    const created = yield* api.create!({
      ...target,
      parentKey: "42",
      title: "Task",
      body: "",
      labels: [],
      assignees: [],
    });
    expect(created.parentLinked).toBe(false);
    expect(created.warnings?.[0]).toContain("did not create a native Task");
    expect(created.warnings?.[0]).not.toContain("The Task was created");
    expect(paths).toEqual(["graphql", "projects/acme%2Fweb/issues"]);
  }),
);

it.effect.each([
  { type: "task", allowed: true, name: "allowed", reply: undefined },
  { type: "task", allowed: false, name: "denied", reply: undefined },
  { type: "issue", allowed: true, name: "Issue", reply: undefined },
  { type: "incident", allowed: true, name: "incident", reply: undefined },
  ...[
    {
      name: "unsupported schema",
      reply: { errors: [{ message: "Field 'workItem' doesn't exist on type 'Namespace'" }] },
    },
    { name: "missing namespace", reply: { data: { namespace: null } } },
    { name: "missing work item", reply: { data: { namespace: { workItem: null } } } },
    { name: "unreadable work item", reply: { data: { namespace: { workItem: { iid: "42" } } } } },
    {
      name: "missing hierarchy widget",
      reply: { data: { namespace: { workItem: { ...item("42", "Task"), widgets: [] } } } },
    },
  ].map((failure) => ({ type: "task", allowed: false, ...failure })),
])("keeps native $type detail actions with $name parent permission", ({ type, allowed, reply }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((args, body) => {
      calls++;
      if (args[1] === "projects/acme%2Fweb/issues/42")
        return {
          iid: 42,
          title: "Task 42",
          web_url: item("42", "Task").webUrl,
          issue_type: type,
          state: "opened",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
          description: "Native Task body",
        };
      if (args[1] !== "graphql") return [];
      if (String(body.query).includes("namespace(fullPath:"))
        return (
          reply ?? {
            data: {
              namespace: {
                workItem: {
                  ...item("42", "Task"),
                  userPermissions: { adminParentLink: allowed },
                  widgets: hierarchy(item("9"), []),
                },
              },
            },
          }
        );
      return {
        data: {
          currentUser: { username: "guest" },
          project: {
            archived: false,
            mergeRequest: {
              type: type.toUpperCase(),
              state: "opened",
              userPermissions: {
                updateIssue: false,
                reopenIssue: false,
                createNote: true,
                adminIssue: false,
              },
              notes: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
            },
          },
        },
      };
    });
    const detail = yield* api.getIssue(target);
    expect(detail).toMatchObject({
      itemType: type,
      body: "Native Task body",
      viewerPermissions: { edit: false, ...(type === "task" ? { updateParent: allowed } : {}) },
      capabilities: {
        createSubIssue: type === "issue",
        updateParent: type === "task",
        subIssueNoun: "Tasks",
      },
    });
    expect(calls).toBe(type === "task" ? 9 : 8);
    if (type === "task" && reply === undefined) {
      const page = yield* decodeHierarchy(yield* api.getHierarchy!(target));
      expect(page.parent).toMatchObject({ key: "9", itemType: "Issue" });
      expect(page.children).toEqual({ items: [], nextCursor: null });
      expect(calls).toBe(10);
    }
  }),
);

it.effect.each([
  { name: "Task parent", parent: item("42", "Task") },
  { name: "archived parent", parent: { ...item("42"), archived: true } },
  { name: "denied parent", parent: { ...item("42"), userPermissions: { adminParentLink: false } } },
  { name: "group Epic parent", parent: { ...item("42", "Epic"), project: null } },
  { name: "wrong project", parent: { ...item("42"), project: { fullPath: "acme/other" } } },
])("does not create a Task for $name", ({ parent }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((args) => {
      calls++;
      expect(args[1]).toBe("graphql");
      return { data: { namespace: { workItem: { ...parent, widgets: hierarchy(null, []) } } } };
    });
    yield* Effect.flip(
      api.create!({
        ...target,
        parentKey: "42",
        title: "Task",
        body: "Body",
        labels: [],
        assignees: [],
      }),
    );
    expect(calls).toBe(1);
  }),
);

it.effect.each([
  {
    name: "unsupported schema",
    reply: { errors: [{ message: "Field 'workItem' doesn't exist on type 'Namespace'" }] },
  },
  {
    name: "denied plan",
    reply: { errors: [{ message: "Work item type is not available for this namespace" }] },
  },
  { name: "missing namespace", reply: { data: { namespace: null } } },
  { name: "malformed item", reply: { data: { namespace: { workItem: { iid: "42" } } } } },
  {
    name: "missing hierarchy widget",
    reply: { data: { namespace: { workItem: { ...item("42"), widgets: [] } } } },
  },
])("keeps $name as a failure for hierarchy and writes", ({ reply }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((args) => {
      calls++;
      expect(args[1]).toBe("graphql");
      return reply;
    });
    yield* Effect.flip(api.getHierarchy!(target));
    yield* Effect.flip(api.setParent!({ ...target, parentKey: null }));
    yield* Effect.flip(
      api.create!({
        ...target,
        parentKey: "42",
        title: "Task",
        body: "",
        labels: [],
        assignees: [],
      }),
    );
    expect(calls).toBe(3);
  }),
);

it.effect.each([
  { name: "missing continuation", pageInfo: { hasNextPage: true, endCursor: null } },
  { name: "repeated continuation", pageInfo: { hasNextPage: true, endCursor: "same" } },
])("refuses $name instead of returning a complete hierarchy", ({ pageInfo }) =>
  Effect.gen(function* () {
    const api = yield* tracker(() => ({
      data: {
        namespace: {
          workItem: {
            ...item("42"),
            widgets: [
              {
                __typename: "WorkItemWidgetHierarchy",
                parent: null,
                children: { nodes: [], pageInfo },
              },
            ],
          },
        },
      },
    }));
    yield* Effect.flip(api.getHierarchy!({ ...target, cursor: "same" }));
  }),
);

it.effect("refuses invalid page inputs and self-parenting without a CLI call", () =>
  Effect.gen(function* () {
    const api = yield* tracker(() => {
      throw new Error("No call expected");
    });
    yield* Effect.flip(api.getHierarchy!({ ...target, limit: 0 }));
    yield* Effect.flip(api.getHierarchy!({ ...target, cursor: "" }));
    yield* Effect.flip(api.setParent!({ ...target, parentKey: "42" }));
  }),
);

it.effect("does not accept a wrong native type or host as a project hierarchy child", () =>
  Effect.gen(function* () {
    for (const child of [
      item("43"),
      { ...item("43", "Task"), webUrl: "https://other.test/acme/web/-/work_items/43" },
    ]) {
      const api = yield* tracker(() => ({
        data: { namespace: { workItem: { ...item("42"), widgets: hierarchy(null, [child]) } } },
      }));
      yield* Effect.flip(api.getHierarchy!(target));
    }
  }),
);

it("keeps native Task identity in issue listings", () => {
  const decoded = decodeIssueListJson(
    JSON.stringify([
      {
        iid: 43,
        title: "Task",
        web_url: item("43", "Task").webUrl,
        issue_type: "task",
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    ]),
  );
  expect(Result.isSuccess(decoded) ? decoded.success.items : []).toMatchObject([
    { key: "43", itemType: "task" },
  ]);
});

it.effect.each([
  {
    name: "another project's old parent",
    parent: {
      ...item("9"),
      project: { fullPath: "acme/other" },
      namespace: { fullPath: "acme/other" },
    },
  },
  { name: "a Task as the old parent", parent: item("9", "Task") },
])("does not unlink $name", ({ parent }) =>
  Effect.gen(function* () {
    let calls = 0;
    const api = yield* tracker((_args, body) => {
      calls++;
      expect(String(body.query).startsWith("mutation")).toBe(false);
      return {
        data: {
          namespace: { workItem: { ...item("42", "Task"), widgets: hierarchy(parent, []) } },
        },
      };
    });
    yield* Effect.flip(api.setParent!({ ...target, parentKey: null }));
    expect(calls).toBe(1);
  }),
);

it.effect.each([
  { name: "invalid parent pair", selected: { ...item("42"), widgets: hierarchy(item("9"), []) } },
  {
    name: "wrong child URL",
    selected: {
      ...item("42"),
      widgets: hierarchy(null, [
        {
          ...item("43", "Task"),
          webUrl: "https://gitlab.acme.test:8443/acme/other/-/work_items/43",
        },
      ]),
    },
  },
  {
    name: "duplicate children",
    selected: { ...item("42"), widgets: hierarchy(null, [item("43", "Task"), item("43", "Task")]) },
  },
])("rejects a hierarchy page with $name", ({ selected }) =>
  Effect.gen(function* () {
    const api = yield* tracker(() => ({ data: { namespace: { workItem: selected } } }));
    yield* Effect.flip(api.getHierarchy!(target));
  }),
);
