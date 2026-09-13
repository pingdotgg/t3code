import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as LinearApi from "./LinearApi.ts";
import { linearIssueState, linearReactions, make } from "./LinearIssueProvider.ts";

const PROJECT: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "web",
  workspaceRoot: "/work/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

it("maps Linear workflow states onto the neutral open/closed states", () => {
  assert.strictEqual(linearIssueState("started"), "open");
  assert.strictEqual(linearIssueState("completed"), "closed");
  assert.strictEqual(linearIssueState("canceled"), "closed");
  assert.strictEqual(linearIssueState("duplicate"), "closed");
});

it("groups supported Linear emoji reactions and marks the viewer", () => {
  assert.deepStrictEqual(
    linearReactions(
      [
        { id: "r1", emoji: "👍", user: { id: "u1", name: "Ada" } },
        { id: "r2", emoji: "👍", user: { id: "u2", name: "Grace" } },
        { id: "r3", emoji: "🎉", user: { id: "u2", name: "Grace" } },
        { id: "r4", emoji: "🧵", user: { id: "u3", name: "Ignored" } },
      ],
      "u1",
    ),
    [
      { content: "thumbs-up", count: 2, actors: ["u1", "u2"], viewerHasReacted: true },
      { content: "hooray", count: 1, actors: ["u2"], viewerHasReacted: false },
    ],
  );
});

it.effect("uses Linear user ids for viewer-comparable issue actors", () => {
  const api = {
    listIssues: () =>
      Effect.succeed({
        issues: [
          {
            id: "issue-1",
            identifier: "ENG-7",
            number: 7,
            title: "Keep viewer identity stable",
            url: "https://linear.app/acme/issue/ENG-7",
            description: "",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            state: { name: "Open", type: "started" },
            creator: { id: "user-1", name: "Ada", email: "ada@example.com" },
            assignee: { id: "user-2", name: "Grace", email: "grace@example.com" },
            labels: { nodes: [] },
          },
        ],
        truncated: false,
      }),
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const page = yield* adapter.listIssues({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      state: "open",
      involvement: "all",
      viewer: "user-1",
      limit: 99,
    });

    assert.strictEqual(page.items[0]?.author?.login, "user-1");
    assert.strictEqual(page.items[0]?.assignees[0]?.login, "user-2");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({ issueTracking: { linear: {} } } as never),
      ),
    ),
  );
});

it.effect("maps Linear comment reaction arrays into issue activity", () => {
  const api = {
    getActivity: () =>
      Effect.succeed({
        viewerId: "user-1",
        comments: [
          {
            id: "comment-1",
            body: "Looks good",
            createdAt: "2026-08-17T00:00:00.000Z",
            reactions: [{ id: "reaction-1", emoji: "👍", user: { id: "user-1" } }],
          },
        ],
        reactions: [
          { id: "reaction-2", emoji: "🎉", user: { id: "user-2" } },
          { id: "reaction-3", emoji: "🎉", user: null },
        ],
        commentsTruncated: false,
      }),
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const activity = yield* adapter.getIssueActivity({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      repository: "ENG",
      number: 7,
    });
    assert.deepStrictEqual(activity, {
      comments: [
        {
          id: "comment-1",
          author: null,
          body: "Looks good",
          createdAt: "2026-08-17T00:00:00.000Z",
          url: null,
          reactions: [
            { content: "thumbs-up", count: 1, actors: ["user-1"], viewerHasReacted: true },
          ],
        },
      ],
      commentCount: 1,
      commentsTruncated: false,
      events: [],
      reactions: [{ content: "hooray", count: 2, actors: ["user-2"], viewerHasReacted: false }],
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({ issueTracking: { linear: {} } } as never),
      ),
    ),
  );
});

it.effect("uses the project binding credential for Linear requests", () => {
  const asked: Array<string | undefined> = [];
  const api = {
    getViewer: (input: { readonly credentialId?: string }) => {
      asked.push(input.credentialId);
      return Effect.succeed({ id: "user-1" });
    },
  } as unknown as LinearApi.LinearApi["Service"];

  return Effect.gen(function* () {
    const adapter = yield* make;
    const source = yield* adapter.resolveSource!(PROJECT);
    assert.deepStrictEqual(source, {
      host: "linear.app",
      repository: "ENG",
      credentialId: "user-1",
    });

    yield* (
      adapter.getViewer as (input: {
        readonly cwd: string;
        readonly host: string;
        readonly credentialId: string;
      }) => Effect.Effect<string>
    )({
      cwd: PROJECT.workspaceRoot,
      host: "linear.app",
      credentialId: "user-1",
    });
    assert.deepStrictEqual(asked, ["user-1"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, api),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: {
                "project-1": { credentialId: "user-1", teamKey: "ENG" },
              },
            },
          },
        } as never),
      ),
    ),
  );
});

it.effect("keeps reading legacy project team settings", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    assert.deepStrictEqual(yield* adapter.resolveSource!(PROJECT), {
      host: "linear.app",
      repository: "LEGACY",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, {} as LinearApi.LinearApi["Service"]),
        ServerSettings.layerTest({
          issueTracking: { linear: { projectTeams: { [PROJECT.id]: "LEGACY" } } },
        }),
      ),
    ),
  ),
);

it.effect("does not fall back to a legacy team after a binding was cleared", () =>
  Effect.gen(function* () {
    const adapter = yield* make;
    assert.isNull(yield* adapter.resolveSource!(PROJECT));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LinearApi.LinearApi, {} as LinearApi.LinearApi["Service"]),
        ServerSettings.layerTest({
          issueTracking: {
            linear: {
              projectBindings: { [PROJECT.id]: null },
              projectTeams: { [PROJECT.id]: "LEGACY" },
            },
          },
        }),
      ),
    ),
  ),
);
