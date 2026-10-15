import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsIssueTracker from "./AzureDevOpsIssueTracker.ts";
import { decodeWorkItemJson, decodeWorkItemsJson } from "./azureDevOpsIssueJson.ts";

const encode = (value: unknown) => JSON.stringify(value);

const WORK_ITEM = {
  id: 7,
  url: "https://dev.azure.com/acme/_apis/wit/workItems/7",
  fields: {
    "System.Title": "Composer loses focus",
    "System.State": "Resolved",
    "System.CreatedDate": "2026-07-01T00:00:00Z",
    "System.ChangedDate": "2026-07-03T00:00:00Z",
    "Microsoft.VSTS.Common.ClosedDate": "2026-07-03T00:00:00Z",
    "System.CreatedBy": { uniqueName: "octo@acme.test", displayName: "Octo Cat" },
    "System.AssignedTo": "Theo <theo@acme.test>",
    "System.Tags": "bug; ui; bug",
    "System.TeamProject": "Web App",
    "System.CommentCount": 2,
    "System.Description": "<p>Typing drops focus.</p>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F50" },
    { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/acme/_apis/wit/workItems/8" },
  ],
};

const WORK_ITEM_TYPES = {
  value: [
    {
      name: "Bug",
      states: [
        { name: "Review", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
        { name: "Resolved", category: "Resolved" },
      ],
    },
    {
      name: "Task",
      states: [
        { name: "Review", category: "Completed" },
        { name: "Working", category: "InProgress" },
      ],
    },
    { name: "Retired", isDisabled: true },
  ],
};

/** Every `az` command the detail read runs, told apart by its first few arguments. */
function answer(args: ReadonlyArray<string>): string {
  const resource = args[args.indexOf("--resource") + 1];
  if (args[0] === "boards") return encode(WORK_ITEM);
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
      comments: [
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
          revisedDate: "9999-01-01T00:00:00Z",
          revisedBy: { uniqueName: "theo@acme.test" },
          fields: {
            "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
            "System.State": { oldValue: "Active", newValue: "Resolved" },
            "System.Tags": { oldValue: "ui", newValue: "bug; ui" },
          },
        },
      ],
    });
  }
  throw new Error(`unexpected az invocation ${args.join(" ")}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>) => string) {
  return AzureDevOpsIssueTracker.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          execute: ({ args }) =>
            Effect.succeed(TestSourceControlHost.processOutput(onExecute(args))),
        }),
      ),
    ),
  );
}

describe("AzureDevOpsIssueTracker", () => {
  it.effect.each([
    {
      type: "Issue",
      current: "Doing",
      states: [
        { name: "To Do", category: "Proposed" },
        { name: "Doing", category: "InProgress" },
        { name: "Done", category: "Completed" },
      ],
      expected: [
        { name: "To Do", category: "open" },
        { name: "Doing", category: "open" },
        { name: "Done", category: "closed" },
      ],
    },
    {
      type: "Bug",
      current: "Shipped",
      states: [
        { name: "Review", category: "InProgress" },
        { name: "Shipped", category: "Completed" },
      ],
      expected: [
        { name: "Review", category: "open" },
        { name: "Shipped", category: "closed" },
      ],
    },
  ])(
    "reads only the native $type workflow in one detail lookup",
    ({ type, current, states, expected }) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args) => {
          const resource = args[args.indexOf("--resource") + 1];
          paths.push(args[0] === "boards" ? "show" : resource!);
          if (args[0] === "boards")
            return encode({
              ...WORK_ITEM,
              relations: [],
              fields: { ...WORK_ITEM.fields, "System.WorkItemType": type, "System.State": current },
            });
          if (resource === "workitemtypestates") {
            expect(args).toEqual(
              expect.arrayContaining([
                `type=${type}`,
                "project=Web App",
                "7.1-preview",
                "api-version=7.1-preview.1",
              ]),
            );
            return encode({ value: states });
          }
          return answer(args);
        });
        const detail = yield* api.getIssue({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
        });
        expect(detail.states).toEqual(expected);
        expect(detail.state).toEqual(expected.find((state) => state.name === current));
        expect(paths).toHaveLength(4);
        expect(paths.filter((path) => path === "workitemtypestates")).toHaveLength(1);
        expect(detail.viewer).toBeNull();
      }),
  );

  it.effect("keeps legacy capabilities without a workflow lookup when the item has no type", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[0] === "boards" ? "show" : args[args.indexOf("--resource") + 1]!);
        return args[0] === "boards" ? encode({ ...WORK_ITEM, relations: [] }) : answer(args);
      });
      const detail = yield* api.getIssue({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
      });
      expect(detail.states).toEqual(api.capabilities.states);
      expect(paths).toHaveLength(3);
      expect(paths).not.toContain("workitemtypestates");
    }),
  );

  it.effect.each([
    { states: [{ name: "Shipped", category: "Completed" }] },
    { states: [{ name: "Review", category: "Unknown" }] },
  ])(
    "refuses an incomplete native workflow without falling back to stock states: $states",
    ({ states }) =>
      Effect.gen(function* () {
        const api = yield* tracker((args) => {
          if (args[0] === "boards")
            return encode({
              ...WORK_ITEM,
              relations: [],
              fields: {
                ...WORK_ITEM.fields,
                "System.WorkItemType": "Bug",
                "System.State": "Review",
              },
            });
          if (args.includes("workitemtypestates")) return encode({ value: states });
          return answer(args);
        });
        const error = yield* Effect.flip(
          api.getIssue({ cwd: "/w", host: "dev.azure.com", scope: "acme/Web App", key: "7" }),
        );
        expect(error).toMatchObject({ operation: "getStates", reason: "failed" });
      }),
  );

  it.effect("writes a custom state with the existing item preflight and no workflow reread", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return encode({
          ...WORK_ITEM,
          fields: { ...WORK_ITEM.fields, "System.WorkItemType": "Bug", "System.State": "Review" },
        });
      });
      yield* api.setState!({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        key: "7",
        state: "Shipped",
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
      expect(seen[1]).toEqual(expect.arrayContaining(["update", "--state", "Shipped"]));
    }),
  );

  it.effect.each([
    {
      input: { body: "**bold**\n\n- one\n- two" },
      fields: [
        { op: "add", path: "/fields/System.Description", value: "**bold**\n\n- one\n- two" },
      ],
    },
    {
      input: {
        title: "Changed title",
        body: "**bold**",
        labels: ["bug", "updated"],
        assignees: ["theo@acme.test"],
      },
      fields: [
        { op: "add", path: "/fields/System.Title", value: "Changed title" },
        { op: "add", path: "/fields/System.Description", value: "**bold**" },
        { op: "add", path: "/fields/System.Tags", value: "bug; updated" },
        { op: "add", path: "/fields/System.AssignedTo", value: "theo@acme.test" },
      ],
    },
    {
      input: { body: "", labels: [], assignees: [] },
      fields: [
        { op: "add", path: "/fields/System.Description", value: "" },
        { op: "add", path: "/fields/System.Tags", value: "" },
        { op: "add", path: "/fields/System.AssignedTo", value: "" },
      ],
    },
    {
      input: {
        body: '<p>Fix <strong>typo</strong></p><ul><li>Keep this list</li></ul><p><a href="https://example.test/help">Help</a></p>',
      },
      fields: [
        {
          op: "add",
          path: "/fields/System.Description",
          value:
            '<p>Fix <strong>typo</strong></p><ul><li>Keep this list</li></ul><p><a href="https://example.test/help">Help</a></p>',
        },
      ],
    },
  ] as const)(
    "writes the description and its native Markdown format in one patch: $input",
    ({ input, fields }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const seen: ReadonlyArray<string>[] = [];
        const patches: unknown[] = [];
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.gen(function* () {
                    seen.push(args);
                    if (args.includes("--in-file")) {
                      expect(args).toEqual(
                        expect.arrayContaining([
                          "--organization",
                          "https://dev.azure.com/acme",
                          "workitems",
                          "project=Web App",
                          "id=7",
                          "PATCH",
                          "application/json-patch+json",
                        ]),
                      );
                      patches.push(
                        JSON.parse(
                          yield* fs
                            .readFileString(args[args.indexOf("--in-file") + 1]!)
                            .pipe(Effect.orDie),
                        ),
                      );
                    }
                    return TestSourceControlHost.processOutput(
                      encode({
                        ...WORK_ITEM,
                        multilineFieldsFormat: { "System.Description": "HTML" },
                      }),
                    );
                  }),
              }),
            ),
          ),
        );
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          ...input,
        });
        expect(patches).toEqual([
          [
            ...fields,
            { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
          ],
        ]);
        expect(seen).toHaveLength(2);
        expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("preserves native rate-limit errors from description patches", () =>
    Effect.gen(function* () {
      let calls = 0;
      const native = new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
        operation: "execute",
        command: "az",
        cwd: "/w",
        argumentCount: 10,
        cause: new Error("rate limited"),
      });
      const api = yield* AzureDevOpsIssueTracker.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeFileSystem.layer,
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              execute: () =>
                Effect.suspend(() =>
                  ++calls === 1
                    ? Effect.succeed(TestSourceControlHost.processOutput(encode(WORK_ITEM)))
                    : Effect.fail(native),
                ),
            }),
          ),
        ),
      );
      const error = yield* Effect.flip(
        api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          body: "**bold**",
        }),
      );
      expect(error).toMatchObject({ reason: "rate-limited", cause: native });
      expect(calls).toBe(2);
    }),
  );

  it.each([
    [
      "https://dev.azure.com/acme/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://dev.azure.com/acme/Web%20App/_apis/wit/workItems/7",
      "https://dev.azure.com/acme/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    [
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_apis/wit/workItems/7",
      "https://acme.visualstudio.com/DefaultCollection/Web%20App/_workitems/edit/7",
    ],
    ["not a URL", null],
    ["https://[acme/_apis/wit/workItems/7", null],
  ])("decodes native work-item URLs for detail, create and lists: %s", (url, expected) => {
    const item = { ...WORK_ITEM, url };
    const detail = Result.getOrThrow(decodeWorkItemJson(encode(item)));
    const list = Result.getOrThrow(decodeWorkItemsJson(encode({ value: [item] })));
    expect(detail?.url ?? null).toBe(expected);
    expect(list.map((row) => row.url)).toEqual(expected === null ? [] : [expected]);
  });

  it.effect("declares only native comment reactions", () =>
    Effect.gen(function* () {
      const api = yield* tracker(() => {
        throw new Error("Capabilities must not call Azure");
      });
      expect(api.capabilities).toMatchObject({
        reactions: false,
        commentReactions: true,
        reactionContents: ["thumbs-up", "thumbs-down", "heart", "hooray", "laugh", "confused"],
      });
    }),
  );

  it.effect.each([
    { content: "thumbs-up", native: "like" },
    { content: "thumbs-down", native: "dislike" },
    { content: "heart", native: "heart" },
    { content: "hooray", native: "hooray" },
    { content: "laugh", native: "smile" },
    { content: "confused", native: "confused" },
  ] as const)("adds and removes native comment reaction $native", ({ content, native }) =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        return args[0] === "boards" ? encode(WORK_ITEM) : "{}";
      });
      for (const reacted of [true, false]) {
        yield* api.setReaction!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          key: "7",
          subjectId: "12",
          content,
          reacted,
        });
      }
      expect(seen).toHaveLength(4);
      for (const [index, method] of [
        [1, "PUT"],
        [3, "DELETE"],
      ] as const) {
        expect(seen[index]).toEqual(
          expect.arrayContaining([
            "commentsReactions",
            "workItemId=7",
            "commentId=12",
            `reactionType=${native}`,
            method,
            "api-version=7.1-preview.1",
          ]),
        );
      }
    }),
  );

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
        state: { category: "closed", name: "Resolved" },
        author: { login: "octo@acme.test", name: "Octo Cat" },
        assignees: [{ login: "Theo <theo@acme.test>" }],
        labels: [
          { name: "bug", color: null },
          { name: "ui", color: null },
        ],
        commentCount: 2,
        body: "<p>Typing drops focus.</p>",
        commentsCursor: "next-token",
        historyTruncated: false,
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
      });
      expect(issue.comments).toEqual([
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
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Resolved"],
        ["labeled", "bug"],
      ]);
      expect(issue.events.map((event) => event.createdAt)).toEqual([
        "2026-07-03T00:00:00Z",
        "2026-07-03T00:00:00Z",
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

  it.effect(
    "marks a full native update page as partial even when most updates have no events",
    () =>
      Effect.gen(function* () {
        for (const total of [101, 100, 99]) {
          const seen: ReadonlyArray<string>[] = [];
          const updates = Array.from({ length: total }, (_, index) => ({
            id: index + 1,
            rev: 2,
            revisedDate: "9999-01-01T00:00:00Z",
            revisedBy: { uniqueName: "theo@acme.test" },
            fields: {
              "System.ChangedDate": { newValue: "2026-07-03T00:00:00Z" },
              ...(index === total - 1
                ? { "System.State": { oldValue: "Active", newValue: "Resolved" } }
                : index === 1
                  ? {
                      "System.Title": { oldValue: "Old title", newValue: "New title" },
                      "System.Tags": { oldValue: "", newValue: "bug" },
                    }
                  : {}),
            },
          }));
          const api = yield* tracker((args) => {
            seen.push(args);
            const resource = args[args.indexOf("--resource") + 1];
            if (resource === "updates") {
              const top = Number(args.find((arg) => arg.startsWith("$top="))?.slice(5));
              return encode({ count: Math.min(top, total), value: updates.slice(0, top) });
            }
            return answer(args);
          });
          const issue = yield* api.getIssue({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            key: "7",
          });
          expect(issue.historyTruncated).toBe(total >= 100);
          expect(issue.state).toEqual({ category: "closed", name: "Resolved" });
          expect(issue.events.map((event) => event.kind)).toEqual(
            total <= 100 ? ["renamed", "labeled", "closed"] : ["renamed", "labeled"],
          );
          expect(issue.events[0]).toMatchObject({
            id: "update-2-0",
            actor: { login: "theo@acme.test" },
            createdAt: "2026-07-03T00:00:00Z",
            detail: "New title",
          });
          expect(seen).toHaveLength(4);
          expect(seen.filter((args) => args.includes("updates"))).toHaveLength(1);
          expect(seen.find((args) => args.includes("updates"))).toContain("$top=100");
        }
      }),
  );

  it.effect.each([
    {
      state: "closed",
      ids: [9, 7],
      expected: [
        { name: "Review", category: "closed" },
        { name: "Shipped", category: "closed" },
      ],
      clauses: [
        "([System.WorkItemType] = 'Bug' AND [System.State] IN ('Shipped'))",
        "([System.WorkItemType] = 'Task' AND [System.State] IN ('Review'))",
      ],
    },
    {
      state: "open",
      ids: [10, 8],
      expected: [
        { name: "Review", category: "open" },
        { name: "Resolved", category: "open" },
      ],
      clauses: [
        "([System.WorkItemType] = 'Bug' AND [System.State] IN ('Review','Resolved'))",
        "([System.WorkItemType] = 'Task' AND [System.State] IN ('Working'))",
      ],
    },
    {
      state: "all",
      ids: [10, 9, 8, 7],
      expected: [
        { name: "Review", category: "open" },
        { name: "Review", category: "closed" },
        { name: "Resolved", category: "open" },
        { name: "Shipped", category: "closed" },
      ],
      clauses: [],
    },
  ] as const)(
    "uses native type-scoped states for $state lists in three requests",
    ({ state, ids, expected, clauses }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths: string[] = [];
        let query = "";
        const rows = [
          { id: 7, type: "Bug", state: "Shipped" },
          { id: 8, type: "Bug", state: "Resolved" },
          { id: 9, type: "Task", state: "Review" },
          { id: 10, type: "Bug", state: "Review" },
        ].map(({ id, type, state }) => ({
          ...WORK_ITEM,
          id,
          fields: { ...WORK_ITEM.fields, "System.WorkItemType": type, "System.State": state },
        }));
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
              execute: ({ args }) =>
                Effect.gen(function* () {
                  const resource = args[args.indexOf("--resource") + 1]!;
                  paths.push(resource);
                  if (resource === "workitemtypes")
                    return TestSourceControlHost.processOutput(encode(WORK_ITEM_TYPES));
                  if (resource === "wiql") {
                    query = JSON.parse(
                      yield* fs
                        .readFileString(args[args.indexOf("--in-file") + 1]!)
                        .pipe(Effect.orDie),
                    ).query;
                    expect(args).toContain("$top=5");
                    return TestSourceControlHost.processOutput(
                      encode({ workItems: ids.map((id) => ({ id })) }),
                    );
                  }
                  if (resource === "workitems") {
                    expect(
                      args.some(
                        (arg) => arg.startsWith("fields=") && arg.includes("System.WorkItemType"),
                      ),
                    ).toBe(true);
                    return TestSourceControlHost.processOutput(
                      encode({ value: rows.filter((row) => ids.some((id) => id === row.id)) }),
                    );
                  }
                  throw new Error(`Unexpected resource ${resource}`);
                }),
            }),
          ),
        );
        const page = yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state,
          involvement: "assigned",
          viewer: "julius@acme.test",
          query: "O'Hare",
          limit: 4,
        });
        expect(page.items.map((row) => row.state)).toEqual(expected);
        expect(page.items.map((row) => Number(row.key))).toEqual(ids);
        expect(page.nextCursor).toBeNull();
        for (const clause of clauses) expect(query).toContain(clause);
        expect(query).not.toContain("Retired");
        expect(query).toContain("[System.TeamProject] = 'Web App'");
        expect(query).toContain("[System.AssignedTo] = @Me");
        expect(query).toContain("[System.Title] CONTAINS 'O''Hare'");
        expect(query).toContain("ORDER BY [System.ChangedDate] DESC, [System.Id] DESC");
        expect(paths).toHaveLength(3);
        expect(paths.filter((path) => path === "workitemtypes")).toHaveLength(1);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each(["all", "open"] as const)(
    "reads one inline workflow catalog for 100 types in %s lists",
    (state) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args) => {
          const resource = args[args.indexOf("--resource") + 1]!;
          paths.push(resource);
          if (resource === "wiql")
            return encode({ workItems: Array.from({ length: 101 }, (_, i) => ({ id: i + 7 })) });
          if (resource === "workitems")
            return encode({
              value: Array.from({ length: 100 }, (_, i) => ({
                ...WORK_ITEM,
                id: i + 7,
                fields: {
                  ...WORK_ITEM.fields,
                  "System.WorkItemType": `Type ${i}`,
                  "System.State": "Review",
                },
              })),
            });
          if (resource === "workitemtypes")
            return encode({
              value: Array.from({ length: 100 }, (_, i) => ({
                name: `Type ${i}`,
                states: [{ name: "Review", category: "InProgress" }],
              })),
            });
          throw new Error(`Unexpected resource ${resource}`);
        });
        const page = yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state,
          involvement: "all",
          viewer: "julius@acme.test",
          limit: 100,
        });
        expect(page.items).toHaveLength(100);
        expect(page.items.every((item) => item.state.category === "open")).toBe(true);
        expect(page.nextCursor).toBe("2026-07-03T00:00:00Z|106");
        expect(paths).toHaveLength(3);
        expect(paths.filter((path) => path === "workitemtypes")).toHaveLength(1);
      }),
  );

  it.effect.each([
    { state: "all", catalog: WORK_ITEM_TYPES, paths: ["wiql"] },
    {
      state: "open",
      catalog: { value: [{ name: "Bug", states: [{ name: "Shipped", category: "Completed" }] }] },
      paths: ["workitemtypes"],
    },
    { state: "closed", catalog: WORK_ITEM_TYPES, paths: ["workitemtypes", "wiql"] },
  ] as const)(
    "bounds empty $state list requests to $paths",
    ({ state, catalog, paths: expected }) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args) => {
          const resource = args[args.indexOf("--resource") + 1]!;
          paths.push(resource);
          if (resource === "workitemtypes") return encode(catalog);
          if (resource === "wiql") return encode({ workItems: [] });
          throw new Error(`Unexpected resource ${resource}`);
        });
        const page = yield* api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state,
          involvement: "all",
          viewer: "julius@acme.test",
          limit: 10,
        });
        expect(page).toEqual({ items: [], nextCursor: null });
        expect(paths).toEqual(expected);
      }),
  );

  it.effect.each([
    { state: "open", catalog: { value: [{ name: "Bug" }] }, calls: 1 },
    { state: "open", catalog: { value: [{ name: "Bug", states: null }] }, calls: 1 },
    {
      state: "open",
      catalog: { value: [{ name: "Bug", states: [{ name: "Shipped", category: "Unknown" }] }] },
      calls: 1,
    },
    {
      state: "all",
      catalog: { value: [{ name: "Bug", states: [{ name: "Review", category: "InProgress" }] }] },
      calls: 3,
    },
    {
      state: "all",
      catalog: { value: [{ name: "Task", states: [{ name: "Shipped", category: "Completed" }] }] },
      calls: 3,
    },
  ] as const)(
    "rejects an incomplete $state list workflow catalog: $catalog",
    ({ state, catalog, calls: expected }) =>
      Effect.gen(function* () {
        let calls = 0;
        const api = yield* tracker((args) => {
          calls++;
          const resource = args[args.indexOf("--resource") + 1];
          if (resource === "workitemtypes") return encode(catalog);
          if (resource === "wiql") return encode({ workItems: [{ id: 7 }] });
          if (resource === "workitems")
            return encode({
              value: [
                {
                  ...WORK_ITEM,
                  fields: {
                    ...WORK_ITEM.fields,
                    "System.WorkItemType": "Bug",
                    "System.State": "Shipped",
                  },
                },
              ],
            });
          throw new Error(`Unexpected resource ${resource}`);
        });
        const error = yield* Effect.flip(
          api.listIssues({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            state,
            involvement: "all",
            viewer: "julius@acme.test",
            limit: 10,
          }),
        );
        expect(error).toMatchObject({ reason: "failed", operation: "getStates" });
        expect(calls).toBe(expected);
      }),
  );

  it.effect.each(["open", "all"] as const)(
    "preserves native catalog rate limits on %s lists",
    (state) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const native = new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
          operation: "execute",
          command: "az",
          cwd: "/w",
          argumentCount: 10,
          cause: new Error("rate limited"),
        });
        const api = yield* AzureDevOpsIssueTracker.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeFileSystem.layer,
              Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
                execute: ({ args }) =>
                  Effect.suspend(() => {
                    const resource = args[args.indexOf("--resource") + 1]!;
                    paths.push(resource);
                    if (resource === "workitemtypes") return Effect.fail(native);
                    if (resource === "wiql")
                      return Effect.succeed(
                        TestSourceControlHost.processOutput(encode({ workItems: [{ id: 7 }] })),
                      );
                    if (resource === "workitems")
                      return Effect.succeed(
                        TestSourceControlHost.processOutput(
                          encode({
                            value: [
                              {
                                ...WORK_ITEM,
                                fields: { ...WORK_ITEM.fields, "System.WorkItemType": "Bug" },
                              },
                            ],
                          }),
                        ),
                      );
                    return Effect.die(`Unexpected resource ${resource}`);
                  }),
              }),
            ),
          ),
        );
        const error = yield* Effect.flip(
          api.listIssues({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            state,
            involvement: "all",
            viewer: "julius@acme.test",
            limit: 10,
          }),
        );
        expect(error).toMatchObject({ reason: "rate-limited", cause: native });
        expect(paths).toEqual(
          state === "open" ? ["workitemtypes"] : ["wiql", "workitems", "workitemtypes"],
        );
      }),
  );

  it.effect.each(["all", "open", "closed"] as const)(
    "rejects a malformed %s list cursor before catalog or provider calls",
    (state) =>
      Effect.gen(function* () {
        const api = yield* tracker(() => {
          throw new Error("Invalid cursors must not call Azure");
        });
        const error = yield* Effect.flip(
          api.listIssues({
            cwd: "/w",
            host: "dev.azure.com",
            scope: "acme/Web App",
            state,
            involvement: "all",
            viewer: "julius@acme.test",
            cursor: "invalid",
            limit: 10,
          }),
        );
        expect(error).toMatchObject({ reason: "failed", operation: "listIssues" });
      }),
  );

  it.effect("lists the native bulk work-item wrapper in one bounded page", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "wiql") return encode({ workItems: [{ id: 7 }, { id: 8 }] });
        if (resource === "workitems") return encode({ count: 1, value: [WORK_ITEM] });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all",
        involvement: "all",
        viewer: "julius@acme.test",
        limit: 1,
      });
      expect(page.items.map((item) => item.key)).toEqual(["7"]);
      expect(page.nextCursor).toBe("2026-07-03T00:00:00Z|7");
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("ids=7");
    }),
  );

  it.effect("keeps WIQL ordering and its cursor when native bulk rows arrive by ID", () =>
    Effect.gen(function* () {
      const seen: ReadonlyArray<string>[] = [];
      const rows = [1, 2, 3].map((id) => ({
        ...WORK_ITEM,
        id,
        fields: {
          ...WORK_ITEM.fields,
          "System.ChangedDate": `2026-07-0${id}T00:00:00Z`,
          "System.WorkItemType": "Bug",
        },
      }));
      let queries = 0;
      const api = yield* tracker((args) => {
        seen.push(args);
        const resource = args[args.indexOf("--resource") + 1];
        if (resource === "workitemtypes") return encode(WORK_ITEM_TYPES);
        if (resource === "wiql")
          return encode({
            workItems: (++queries === 1 ? [3, 2, 1] : [1]).map((id) => ({ id })),
          });
        if (resource === "workitems")
          return encode({
            count: queries === 1 ? 2 : 1,
            value: queries === 1 ? [rows[1], rows[2]] : [rows[0]],
          });
        throw new Error(`Unexpected resource ${resource}`);
      });
      const target = {
        cwd: "/w",
        host: "dev.azure.com",
        scope: "acme/Web App",
        state: "all" as const,
        involvement: "all" as const,
        viewer: "julius@acme.test",
        limit: 2,
      };
      const first = yield* api.listIssues(target);
      expect(first.items.map((item) => item.key)).toEqual(["3", "2"]);
      expect(first.nextCursor).toBe("2026-07-02T00:00:00Z|2");
      const second = yield* api.listIssues({ ...target, cursor: first.nextCursor! });
      expect(second.items.map((item) => item.key)).toEqual(["1"]);
      expect(second.nextCursor).toBeNull();
      expect(seen).toHaveLength(6);
      expect(seen.filter((args) => args.includes("workitemtypes"))).toHaveLength(2);
    }),
  );

  it.effect("refuses the unsupported mentioned filter before any Azure request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return encode({ workItems: [] });
      });
      const error = yield* Effect.flip(
        api.listIssues({
          cwd: "/w",
          host: "dev.azure.com",
          scope: "acme/Web App",
          state: "all",
          involvement: "mentioned",
          viewer: "julius@acme.test",
          limit: 10,
        }),
      );
      expect(error.detail).toContain("mentioned");
      expect(requests).toBe(0);
      expect(api.capabilities.maxAssignees).toBe(1);
      expect(api.capabilities.involvements).toEqual(["all", "assigned", "authored"]);
    }),
  );

  it.effect.each(["update", "setState", "getIssue", "getComments"] as const)(
    "rejects a foreign native project before %s",
    (operation) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          return answer(args);
        });
        const target = { cwd: "/w", host: "dev.azure.com", scope: "acme/Other", key: "7" };
        const task =
          operation === "update"
            ? api.update!({ ...target, title: "Changed title" })
            : operation === "setState"
              ? api.setState!({ ...target, state: "New" })
              : operation === "getComments"
                ? api.getComments({ ...target, cursor: "next-token" })
                : api.getIssue(target);
        const error = yield* Effect.flip(task);
        expect(error.reason).toBe("not-found");
        expect(seen).toHaveLength(1);
        expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
      }),
  );

  it.effect.each(["web app", "a0000000-0000-0000-0000-000000000001"])(
    "accepts the native project identity for configured scope %s before writing",
    (project) =>
      Effect.gen(function* () {
        const seen: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          seen.push(args);
          if (args.slice(0, 3).join(" ") === "devops project show")
            return encode({ id: "a0000000-0000-0000-0000-000000000001", name: "Web App" });
          return answer(args);
        });
        yield* api.update!({
          cwd: "/w",
          host: "dev.azure.com",
          scope: `acme/${project}`,
          key: "7",
          title: "Changed title",
        });
        expect(seen[0]?.slice(0, 3)).toEqual(["boards", "work-item", "show"]);
        expect(seen.at(-1)?.slice(0, 3)).toEqual(["boards", "work-item", "update"]);
        expect(seen).toHaveLength(project === "web app" ? 2 : 3);
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
});
