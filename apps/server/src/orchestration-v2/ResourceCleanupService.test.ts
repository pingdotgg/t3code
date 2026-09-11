import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { worktreeResourceThreadId } from "@t3tools/shared/worktreeResource";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ProjectionStoreV2, layerMemory } from "./ProjectionStore.ts";
import { ResourceCleanupService, live } from "./ResourceCleanupService.ts";

const projectId = ProjectId.make("project:cleanup");
const now = DateTime.makeUnsafe("2026-09-17T12:00:00Z");
const createThread = (id: string, worktreePath: string | null, project = projectId) =>
  Effect.gen(function* () {
    const projection = yield* ProjectionStoreV2;
    const threadId = ThreadId.make(id);
    const payload = {
      id: threadId,
      projectId: project,
      title: id,
      createdBy: "user" as const,
      creationSource: "web" as const,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* projection.apply({
      id: EventId.make(`create:${id}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload,
    });
    return payload;
  });

for (const worktreePath of [null, "/work/feature"]) {
  it.effect(
    `keeps sibling terminals and closes only the final checkout owner (${worktreePath ?? "local"})`,
    () => {
      const closed: string[] = [];
      const testLayer = live.pipe(
        Layer.provideMerge(layerMemory),
        Layer.provide(
          Layer.mock(TerminalManager)({
            close: ({ threadId }) =>
              Effect.sync(() => {
                closed.push(threadId);
              }),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "resource-cleanup-" })),
        Layer.provide(NodeServices.layer),
      );
      return Effect.gen(function* () {
        const projection = yield* ProjectionStoreV2;
        const cleanup = yield* ResourceCleanupService;
        const first = yield* createThread("first", worktreePath);
        const sibling = yield* createThread("sibling", worktreePath);
        // Neither another checkout nor an equal path under another project keeps this owner alive.
        yield* createThread("other-checkout", "/work/other");
        yield* createThread("other-project", worktreePath, ProjectId.make("other-project"));
        yield* projection.apply({
          id: EventId.make("archive:first"),
          type: "thread.archived",
          threadId: first.id,
          occurredAt: now,
          payload: { ...first, archivedAt: now },
        });
        yield* cleanup.cleanupTerminals(first.id);
        assert.deepEqual(closed, [first.id]);
        yield* projection.apply({
          id: EventId.make("delete:sibling"),
          type: "thread.deleted",
          threadId: sibling.id,
          occurredAt: now,
          payload: { ...sibling, deletedAt: now },
        });
        yield* cleanup.cleanupTerminals(sibling.id);
        assert.deepEqual(closed, [
          first.id,
          sibling.id,
          worktreeResourceThreadId(projectId, worktreePath),
        ]);
      }).pipe(Effect.provide(testLayer));
    },
  );
}
