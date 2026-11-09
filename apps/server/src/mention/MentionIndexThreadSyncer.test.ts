import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { MentionIndex, make, mentionIndexScopeKey } from "./MentionIndex.ts";
import {
  MentionIndexThreadSyncer,
  layer as threadSyncerLayer,
} from "./MentionIndexThreadSyncer.ts";

const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("env-1");
const activeId = ThreadId.make("thread-active");
const archivedId = ThreadId.make("thread-archived");

const now = DateTime.makeUnsafe(1_700_000_000_000);

const indexLayer = Layer.effect(MentionIndex, make).pipe(Layer.provide(KeyValueStore.layerMemory));

const testLayer = threadSyncerLayer.pipe(
  Layer.provide(indexLayer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provide(
    Layer.succeed(ThreadManagementService.ThreadManagementService, {
      listProjectThreads: () =>
        Effect.succeed([
          {
            id: activeId,
            projectId,
            title: "Improve mention index",
            archivedAt: null,
            updatedAt: now,
          },
          {
            id: archivedId,
            projectId,
            title: "Archived",
            archivedAt: now,
            updatedAt: now,
          },
        ] as never),
    } as never),
  ),
  Layer.provideMerge(indexLayer),
);

it.effect("indexes active project threads and skips archived shells", () =>
  Effect.gen(function* () {
    const syncer = yield* MentionIndexThreadSyncer;
    const index = yield* MentionIndex;
    yield* syncer.syncProject(projectId);
    const result = yield* index.search({
      projectId,
      providers: ["thread"],
      query: "mention",
      limit: 10,
    });
    expect(result.status).toBe("ready");
    expect(result.hits.map((hit) => hit.itemKey)).toEqual([`${environmentId}:${activeId}`]);
    expect(result.hits[0]?.thread).toEqual({
      environmentId,
      threadId: activeId,
      title: "Improve mention index",
      projectId,
    });
    const scope = yield* index.scopeMeta(mentionIndexScopeKey("thread", projectId));
    expect(scope?.status).toBe("ready");
  }).pipe(Effect.provide(testLayer)),
);
