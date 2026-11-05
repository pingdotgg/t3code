import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const databaseLayer = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  databaseLayer,
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "pull-request-redirects" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer, runEffectWorker: false },
  ),
);

it.effect("persists permanent MR moves through every linking source", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("project:sewobe-pr");
    const oldUrl = "http://git.sewobe.local/jobagent/manager/-/merge_requests/11111";
    const canonicalUrl = "https://git.sewobe.de/jobagent/manager/-/merge_requests/11111";
    const target = { host: "git.sewobe.local", repository: "jobagent/manager", number: 11111 };

    for (const source of ["manual", "agent", "created", "stack", "metadata", "watch"] as const) {
      const threadId = ThreadId.make(`thread:sewobe-${source}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-sewobe-${source}`),
        threadId,
        projectId,
        title: "SEWOBE MR",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const base = { commandId: CommandId.make(`link-sewobe-${source}`), threadId };
      yield* orchestrator.dispatch(
        source === "metadata"
          ? {
              ...base,
              type: "thread.metadata.update",
              linkedPullRequest: { projectId, ...target, url: oldUrl },
            }
          : source === "watch"
            ? {
                ...base,
                type: "thread.pull-request.watch",
                ...target,
                watching: true,
                link: { url: oldUrl, source: "manual" },
              }
            : { ...base, type: "thread.pull-request.link", ...target, url: oldUrl, source },
      );
      const linked = yield* projections.getThreadShell(threadId);
      assert.ok(linked);
      assert.ok(linked.pullRequests);
      assert.equal(linked.pullRequests.length, 1);
      assert.equal(linked.pullRequests[0]?.host, "git.sewobe.local");
      assert.equal(linked.pullRequests[0]?.url, oldUrl);
      if (source === "metadata") assert.equal(linked.linkedPullRequest?.url, oldUrl);

      // A permanent move changes the stored identity and URL together.
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`relink-sewobe-${source}`),
        threadId,
        ...target,
        host: "git.sewobe.de",
        url: canonicalUrl,
        source: "manual",
        redirectFrom: { ...target, url: oldUrl },
      });
      const moved = yield* projections.getThreadShell(threadId);
      assert.equal(moved?.pullRequests?.length, 1);
      assert.equal(moved?.pullRequests?.[0]?.url, canonicalUrl);
      assert.equal(moved?.pullRequests?.[0]?.host, "git.sewobe.de");
      assert.equal(moved?.pullRequests?.[0]?.source, linked.pullRequests[0]?.source);
      assert.deepEqual(moved?.pullRequests?.[0]?.watch, linked.pullRequests[0]?.watch);
      assert.equal(moved?.pullRequests?.[0]?.linkedAt, linked.pullRequests[0]?.linkedAt);
      // A delayed redirect result cannot recreate a link at another destination.
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`stale-redirect-${source}`),
        threadId,
        ...target,
        host: "other.example",
        url: "https://other.example/jobagent/manager/-/merge_requests/11111",
        source: "manual",
        redirectFrom: { ...target, url: oldUrl },
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.pullRequests?.length, 1);
      if (source === "metadata") assert.equal(moved?.linkedPullRequest?.url, canonicalUrl);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make(`unlink-sewobe-${source}`),
        threadId,
        ...target,
        host: "git.sewobe.de",
      });
      const unlinked = yield* projections.getThreadShell(threadId);
      assert.ok(unlinked);
      assert.ok(unlinked.pullRequests);
      assert.isTrue(unlinked.pullRequests.every((link) => link.source === "stack-dismissed"));
    }
  }).pipe(Effect.provide(layerTest)),
);
