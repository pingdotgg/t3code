import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);

const WORK_ITEM = {
  id: 7,
  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
  fields: {
    "System.Title": "Composer loses focus",
    "System.State": "Shipped",
    "System.CreatedDate": "2026-07-01T00:00:00Z",
    "System.ChangedDate": "2026-07-03T00:00:00Z",
    "Microsoft.VSTS.Common.ClosedDate": "2026-07-03T00:00:00Z",
    "System.CreatedBy": { uniqueName: "octo@acme.test", displayName: "Octo Cat" },
    "System.AssignedTo": "Theo <theo@acme.test>",
    "System.Tags": "bug; ui; bug",
    "System.TeamProject": "Web App",
    "System.WorkItemType": "Bug",
    "System.CommentCount": 2,
    "System.Description": "<p>Typing drops focus.</p>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F50" },
    { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/acme/_apis/wit/workItems/8" },
  ],
};

/** A custom process: "Shipped" is finished only because its category says so. */
const WORK_ITEM_TYPES = {
  value: [
    // Another type's workflow, which a Bug cannot be moved through.
    { name: "Epic", states: [{ name: "Funded", category: "Proposed" }] },
    {
      name: "Bug",
      states: [
        { name: "Active", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
      ],
    },
  ],
};

/** Every `az` command the detail read runs, told apart by its first few arguments. */
function answer(args: ReadonlyArray<string>): string {
  const resource = args[args.indexOf("--resource") + 1];
  if (args[0] === "boards") return encode(WORK_ITEM);
  if (resource === "workitemtypes") return encode(WORK_ITEM_TYPES);
  if (args[0] === "repos") {
    return encode({
      pullRequestId: 50,
      title: "fix(web): keep composer focus",
      status: "completed",
      isDraft: false,
      sourceRefName: "refs/heads/fix",
      targetRefName: "refs/heads/main",
      creationDate: "2026-07-02T00:00:00Z",
      closedDate: "2026-07-03T00:00:00Z",
      mergeStatus: "succeeded",
      repository: {
        id: "r-guid",
        name: "web",
        webUrl: "https://dev.azure.com/acme/Web%20App/_git/web",
        project: { id: "p-guid", name: "Web App" },
      },
      createdBy: { uniqueName: "theo@acme.test", displayName: "Theo" },
      description: "",
      reviewers: [],
      _links: { web: { href: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50" } },
    });
  }
  if (resource === "comments") {
    return encode({
      continuationToken: "next-token",
      // Newest first, as `order=desc` answers.
      comments: [
        {
          id: 3,
          text: "Still happening.",
          createdDate: "2026-07-04T00:00:00Z",
          createdBy: { uniqueName: "octo@acme.test" },
        },
        {
          id: 1,
          text: "Repro attached.",
          createdDate: "2026-07-02T00:00:00Z",
          createdBy: { uniqueName: "julius@acme.test", displayName: "Julius" },
          reactions: [
            { type: "like", count: 2, isCurrentUserEngaged: true },
            { type: "dislike", count: 0 },
          ],
        },
        { id: 2, text: "gone", createdDate: "2026-07-02T00:00:00Z", isDeleted: true },
      ],
    });
  }
  if (resource === "updates") {
    return encode({
      value: [
        {
          id: 1,
          revisedDate: "2026-07-01T00:00:00Z",
          fields: { "System.Title": { newValue: "x" } },
        },
        {
          id: 2,
          // The newest revision has not been superseded, which Azure writes as year 9999.
          revisedDate: "9999-01-01T00:00:00Z",
          revisedBy: { uniqueName: "theo@acme.test" },
          fields: {
            "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
            "System.State": { oldValue: "Active", newValue: "Shipped" },
            "System.Tags": { oldValue: "ui", newValue: "bug; ui" },
          },
        },
      ],
    });
  }
  throw new Error(`unexpected az invocation ${args.join(" ")}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>, stdin: string | undefined) => string) {
  return AzureDevOpsIssueTracker.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          execute: ({ args, stdin }) =>
            Effect.succeed(TestSourceControlHost.processOutput(onExecute(args, stdin))),
        }),
      ),
    ),
  );
}

describe("AzureDevOpsIssueTracker", () => {
  it.effect("maps a work item, its conversation and revisions to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        return answer(args);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      });
      // Every command names the organization rather than detecting it from the checkout.
      for (const args of seen) {
        expect(args).toContain("https://dev.azure.com/acme");
      }
      expect(issue).toMatchObject({
        key: "7",
        displayKey: "#7",
        title: "Composer loses focus",
        url: "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
        // The project's own state name survives; the category is what the list filters by.
        state: { category: "closed", name: "Shipped" },
        // Its own type's workflow, in Azure's order, not the stock list or another type's.
        states: [
          { category: "open", name: "Active" },
          { category: "closed", name: "Shipped" },
        ],
        author: { login: "octo@acme.test", name: "Octo Cat" },
        assignees: [{ login: "Theo <theo@acme.test>" }],
        labels: [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
        commentCount: 2,
        body: "<p>Typing drops focus.</p>",
        commentsCursor: "next-token",
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      // The first page is the newest comments, handed over oldest first.
      expect(seen.find((args) => args.includes("comments"))).toContain("order=desc");
      expect(issue.comments.map((comment) => comment.id)).toEqual(["1", "3"]);
      expect(issue.comments.slice(0, 1)).toEqual([
        {
          id: "1",
          author: { login: "julius@acme.test", name: "Julius", avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: [], viewerHasReacted: true }],
        },
      ]);
      // The first revision is the creation; a state move across the category line is a close.
      expect(issue.events.map((event) => [event.kind, event.detail, event.createdAt])).toEqual([
        ["closed", "Shipped", "2026-07-03T00:00:00Z"],
        ["labeled", "bug", "2026-07-03T00:00:00Z"],
      ]);
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "Web App/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://dev.azure.com/acme/Web%20App/_git/web/pullrequest/50",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect("filters open work items by the project's own finished states", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bodies: string[] = [];
      const hydrated: string[] = [];
      let typeReads = 0;
      let finished = "Shipped";
      let itemState = "Shipped";
      let beforeWorkflowRead:
        | Effect.Effect<void, AzureDevOpsCli.AzureDevOpsCommandFailedError>
        | undefined;
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
            execute: ({ args }) => {
              const resource = args[args.indexOf("--resource") + 1];
              if (resource === "workitems") {
                // `az devops invoke` resolves `wit/workitems` to the create route
                // (`.../workitems/${type}`) and fails before sending anything.
                return Effect.fail(
                  new AzureDevOpsCli.AzureDevOpsCommandFailedError({
                    operation: "execute",
                    command: "az",
                    cwd: "/w",
                    argumentCount: args.length,
                    cause: "KeyError: 'type'",
                  }),
                );
              }
              if (resource === "workitemtypes") {
                typeReads += 1;
                if (beforeWorkflowRead !== undefined) {
                  return beforeWorkflowRead.pipe(
                    Effect.as(
                      TestSourceControlHost.processOutput(
                        encode({
                          value: [
                            { name: "Bug", states: [{ name: finished, category: "Completed" }] },
                          ],
                        }),
                      ),
                    ),
                  );
                }
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    encode({
                      value: [{ name: "Bug", states: [{ name: finished, category: "Completed" }] }],
                    }),
                  ),
                );
              }
              if (resource !== "wiql" && resource !== "workitemsbatch") {
                return Effect.succeed(TestSourceControlHost.processOutput(answer(args)));
              }
              return fs.readFileString(args[args.indexOf("--in-file") + 1]!).pipe(
                Effect.orDie,
                Effect.map((body) => {
                  if (resource === "wiql") {
                    bodies.push(body);
                    return TestSourceControlHost.processOutput(
                      encode({ workItems: [{ id: 9 }, { id: 7 }, { id: 3 }] }),
                    );
                  }
                  hydrated.push((JSON.parse(body) as { ids: number[] }).ids.join(","));
                  // The page as REST answers it: an envelope, in an order of its own.
                  const item = {
                    ...WORK_ITEM,
                    fields: { ...WORK_ITEM.fields, "System.State": itemState },
                  };
                  return TestSourceControlHost.processOutput(
                    encode({ count: 2, value: [item, { ...item, id: 9 }] }),
                  );
                }),
              );
            },
          }),
        ),
      );
      const list = api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "mentioned",
        viewer: "octo@acme.test",
        labels: ["o'hare"],
        assignee: "theo@acme.test",
        sort: "created",
        limit: 2,
        cursor: "2026-07-01T00:00:00Z|7",
      });
      const page = yield* list;
      yield* list;
      // The rows come back in WIQL's order, and the cursor is the last one of the page.
      expect(hydrated).toEqual(["9,7", "9,7"]);
      expect(page.items.map((item) => item.key)).toEqual(["9", "7"]);
      expect(page.nextCursor).toBe("2026-07-01T00:00:00Z|7");
      // Each `az` call costs seconds, so a second list reuses the project's states.
      expect(typeReads).toBe(1);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[0]).toContain("AND [System.State] NOT IN ('shipped')");
      // A first page is a fresh list, so it sees a finished state added since.
      finished = "Released";
      yield* api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "all",
        sort: "updated",
        limit: 2,
        refresh: true,
      });
      expect(typeReads).toBe(2);
      expect(bodies[2]).toContain("AND [System.State] NOT IN ('released')");
      const { query } = JSON.parse(bodies[0]!) as { query: string };
      // Mentions cannot be asked for over REST, so the filter sends no clause for them.
      expect(query).not.toContain("@RecentMentions");
      expect(query).toContain(
        " AND [System.Tags] CONTAINS 'o''hare' AND [System.AssignedTo] = 'theo@acme.test'" +
          " AND ([System.CreatedDate] < '2026-07-01T00:00:00Z' OR ([System.CreatedDate] = '2026-07-01T00:00:00Z' AND [System.Id] < 7))" +
          " ORDER BY [System.CreatedDate] DESC, [System.Id] DESC",
      );

      const firstPage = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "open",
        involvement: "all",
        sort: "updated",
        limit: 2,
      } as const;
      finished = itemState = "Done";
      yield* api.listIssues({ ...firstPage, query: "composer" });
      const all = { ...firstPage, state: "all" } as const;
      const cachedAll = yield* api.listIssues(all);
      expect(typeReads).toBe(2);
      expect(bodies[3]).toContain("AND [System.State] NOT IN ('released')");
      expect(cachedAll.items.map((item) => item.state.category)).toEqual(["open", "open"]);
      const refreshedAll = yield* api.listIssues({ ...all, refresh: true });
      expect(typeReads).toBe(3);
      expect(bodies[5]).not.toContain("[System.State]");
      expect(refreshedAll.items.map((item) => item.state.category)).toEqual(["closed", "closed"]);

      finished = "Delivered";
      beforeWorkflowRead = Effect.fail(
        new AzureDevOpsCli.AzureDevOpsCommandFailedError({
          operation: "execute",
          command: "az",
          cwd: "/w",
          argumentCount: 0,
          cause: "workflow metadata unavailable",
        }),
      );
      const refreshError = yield* Effect.flip(api.listIssues({ ...firstPage, refresh: true }));
      expect(refreshError).toMatchObject({ operation: "listIssues", reason: "failed" });
      expect(bodies).toHaveLength(6);
      yield* api.listIssues({ ...firstPage, refresh: false });
      expect(typeReads).toBe(4);
      expect(bodies[6]).toContain("NOT IN ('done')");

      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      beforeWorkflowRead = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const first = yield* Effect.forkChild(api.listIssues({ ...firstPage, refresh: true }), {
        startImmediately: true,
      });
      yield* Deferred.await(started);
      const second = yield* Effect.forkChild(api.listIssues({ ...firstPage, refresh: true }), {
        startImmediately: true,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      const refreshed = yield* Fiber.join(second);
      expect(refreshed.nextCursor).not.toBeNull();
      yield* api.listIssues({ ...firstPage, cursor: refreshed.nextCursor ?? undefined });
      expect(typeReads).toBe(5);
      expect(bodies.slice(7)).toHaveLength(3);
      expect(bodies.slice(7).every((body) => body.includes("NOT IN ('delivered')"))).toBe(true);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("names the viewer without a request that a sign-in could refuse", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => {
        throw new Error(`unexpected az invocation ${args.join(" ")}`);
      });
      expect(yield* api.getViewer({ cwd: "/w", host: "dev.azure.com" })).toBe("@Me");
    }),
  );

  it.effect("refuses a scope that is not organization/project without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "dev.azure.com", scope: "web", key: "7" }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
    }),
  );

  it.effect("reads a legacy organization's work item and every page of its updates", () =>
    Effect.gen(function* () {
      const seen: string[][] = [];
      const api = yield* tracker((args) => {
        seen.push([...args]);
        if (args[0] === "boards") {
          return encode({
            ...WORK_ITEM,
            url: "https://acme.visualstudio.com/p-guid/_apis/wit/workItems/7",
            relations: [],
          });
        }
        if (args[args.indexOf("--resource") + 1] !== "updates") return answer(args);
        const rename = (id: number) => ({
          id,
          revisedDate: "2026-07-02T00:00:00Z",
          fields: { "System.Title": { oldValue: "a", newValue: `title ${id}` } },
        });
        return encode({
          value: args.includes("$skip=100")
            ? [rename(102)]
            : Array.from({ length: 100 }, (_, index) => rename(index + 2)),
        });
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "acme.visualstudio.com",
        scope: "Web App",
        key: "7",
      });
      for (const args of seen) {
        expect(args).toContain("https://acme.visualstudio.com");
      }
      expect(issue.url).toBe("https://acme.visualstudio.com/Web%20App/_workitems/edit/7");
      expect(issue.events).toHaveLength(101);
      expect(issue.events.at(-1)?.detail).toBe("title 102");
    }),
  );

  it.effect("refuses a write Azure cannot carry out as asked, without writing", () =>
    Effect.gen(function* () {
      const writes: string[][] = [];
      const api = yield* tracker((args) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push([...args]);
        return answer(args);
      });
      const target = { cwd: "/w", host: "dev.azure.com", key: "7" };
      const own = { ...target, scope: "acme/Web App" };
      // Work item 7 is in "Web App"; an id alone would let another project's scope write to it.
      const elsewhere = { ...target, scope: "acme/Other" };
      const refusals = yield* Effect.all([
        Effect.flip(api.update!({ ...elsewhere, title: "x" })),
        Effect.flip(api.setState!({ ...elsewhere, state: "Active" })),
        Effect.flip(api.update!({ ...own, assignees: ["a@acme.test", "b@acme.test"] })),
        // `az` would send the contents of that file as the tag.
        Effect.flip(api.update!({ ...own, labels: ["@/etc/hostname"] })),
        Effect.flip(api.getIssue({ ...target, scope: "acme/@secrets" })),
        // A stock state and another type's state, neither in this Bug's custom workflow.
        Effect.flip(api.setState!({ ...own, state: "Closed" })),
        Effect.flip(api.setState!({ ...own, state: "Funded" })),
      ]);
      expect(refusals.map((error) => error.reason)).toEqual([
        "not-found",
        "not-found",
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      expect(writes).toEqual([]);
    }),
  );

  it.effect("moves a work item to a state of its own type, custom ones included", () =>
    Effect.gen(function* () {
      const writes: string[][] = [];
      const api = yield* tracker((args) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push([...args]);
        return answer(args);
      });
      const own = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" };
      yield* api.setState!({ ...own, state: "Shipped" });
      expect(writes.map((args) => args[args.indexOf("--state") + 1])).toEqual(["Shipped"]);
      // A type that reports no states falls back to the stock workflow, plus where the item is.
      const stock = yield* tracker((args) =>
        args[args.indexOf("--resource") + 1] === "workitemtypes"
          ? encode({ value: [{ name: "Bug" }] })
          : answer(args),
      );
      expect((yield* stock.getIssue(own)).states.map((state) => state.name)).toEqual([
        "New",
        "To Do",
        "Active",
        "Doing",
        "Resolved",
        "Done",
        "Closed",
        "Removed",
        "Shipped",
      ]);
    }),
  );

  it.effect("sends text that starts with @ on stdin, where az reads no file for it", () =>
    Effect.gen(function* () {
      const writes: Array<{ args: string[]; stdin: string | undefined }> = [];
      const api = yield* tracker((args, stdin) => {
        if (args[0] === "boards" && args[2] !== "show") writes.push({ args: [...args], stdin });
        return answer(args);
      });
      const scope = { cwd: "/w", host: "dev.azure.com", scope: "acme/Web App" };
      yield* api.update!({ ...scope, key: "7", title: "@/etc/hostname", body: "@notes" });
      yield* api.create!({
        ...scope,
        title: "@/etc/hostname",
        body: "@notes",
        labels: [],
        assignees: [],
      });
      for (const write of writes) {
        expect(write.args.filter((arg) => arg.startsWith("@") || arg.includes("=@/"))).toEqual([]);
      }
      expect(
        writes.map((write) => [
          write.args[2],
          write.args.find((arg) => arg.endsWith("=@-")),
          write.stdin,
        ]),
      ).toEqual([
        ["update", "--title=@-", "@/etc/hostname"],
        ["update", "--description=@-", "@notes"],
        ["create", "--title=@-", "@/etc/hostname"],
        ["update", "--description=@-", "@notes"],
      ]);
    }),
  );

  it.effect("keeps a failure's own text in the cause, out of the detail a caller reads", () =>
    Effect.gen(function* () {
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeTempFileScoped",
        pathOrDescriptor: "/private/tmp/secret-dir",
      });
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              FileSystem.FileSystem,
              FileSystem.makeNoop({ makeTempFileScoped: () => Effect.fail(denied) }),
            ),
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
          ),
        ),
      );
      const error = yield* Effect.flip(
        api.comment!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          body: "x",
        }),
      );
      expect(error.detail).toBe("Could not write the Azure DevOps request body.");
      expect(error.cause).toBe(denied);
    }),
  );
});
