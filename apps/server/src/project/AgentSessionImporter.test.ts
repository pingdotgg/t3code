import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("retries failed writes and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  let failWrite = true;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.gen(function* () {
              if (failWrite) {
                failWrite = false;
                return yield* new EventSink.EventSinkWriteError({
                  eventCount: input.events.length,
                });
              }
              writes.push(input.events);
              imported = true;
              return input.events.map((event, index) => ({
                event,
                sequence: index + 1,
                commandId: null,
              }));
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(writes).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toEqual(
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    );
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each(
  (["codex", "claudeAgent"] as const).flatMap((provider) =>
    (["active", "deleted", "other-instance", "none"] as const).map((owner) => ({
      provider,
      owner,
    })),
  ),
)(
  "skips a $provider import when the native session has $owner ownership",
  ({ provider, owner }) => {
    const database = SqlitePersistence.layerMemory;
    const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(database),
    );
    const persistence = Layer.mergeAll(
      stores,
      EventSink.layer.pipe(Layer.provide(stores)),
      ProviderSessionRuntime.layer.pipe(Layer.provide(database)),
      IdAllocator.layer,
    );
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const instanceId = ProviderInstanceId.make(provider);
      const driver = ProviderDriverKind.make(provider);
      const sessionId = "020e7f00-dce6-406b-8ec6-ed90498945d6";
      const importId = ThreadId.make(`import:${instanceId}:${sessionId}`);
      const nativeId = ThreadId.make(`native:${provider}`);
      const nativeInstance = ProviderInstanceId.make(
        owner === "other-instance" ? `${provider}-other` : provider,
      );
      const now = DateTime.makeUnsafe("2026-09-01T10:00:00.000Z");
      const nativeThread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: nativeId,
        projectId,
        title: "Native thread",
        providerInstanceId: nativeInstance,
        modelSelection: { instanceId: nativeInstance, model: "native-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: nativeId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: owner === "deleted" ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
      };
      const nativeProviderThread: OrchestrationV2ProviderThread = {
        id: ids.derive.providerThread({
          driver,
          providerInstanceId: nativeInstance,
          nativeThreadId: sessionId,
        }),
        driver,
        providerInstanceId: nativeInstance,
        providerSessionId: null,
        appThreadId: nativeId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: sessionId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      };
      let publishedOwner = false;
      const importerLayer = AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(EventSink.EventSinkV2, sink),
            Layer.succeed(ProviderSessionRuntime.ProviderSessionRuntimeRepository, runtimes),
            Layer.succeed(IdAllocator.IdAllocatorV2, ids),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (id, fields) =>
                projections
                  .getThreadRecords(id, fields)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                    ),
                  ),
            }),
            Layer.mock(AgentSessionScanner.AgentSessionScanner)({
              recentThreads: () =>
                Stream.fromEffect(
                  Effect.gen(function* () {
                    // Ownership appears after the importer has read runtime bindings.
                    if (owner !== "none" && !publishedOwner) {
                      yield* sink
                        .write({
                          events: [
                            {
                              id: EventId.make(`native-created:${provider}`),
                              type: "thread.created",
                              threadId: nativeId,
                              occurredAt: now,
                              payload: nativeThread,
                            },
                            {
                              id: EventId.make(`native-provider:${provider}`),
                              type: "provider-thread.updated",
                              threadId: nativeId,
                              occurredAt: now,
                              payload: nativeProviderThread,
                            },
                          ],
                        })
                        .pipe(Effect.orDie);
                      publishedOwner = true;
                    }
                    return {
                      _tag: "Importable" as const,
                      source: {
                        provider,
                        providerInstanceId: instanceId,
                        providerSessionId: sessionId,
                        filePath: `/tmp/${provider}.jsonl`,
                        size: 100,
                        mtimeMs: 2,
                        device: 3,
                        inode: 4,
                        birthtimeMs: 1,
                      },
                      thread: {
                        source: provider,
                        providerInstanceId: instanceId,
                        providerSessionId: sessionId,
                        title: "Imported thread",
                        model: null,
                        createdAt: "2026-09-01T10:00:00.000Z",
                        updatedAt: "2026-09-01T10:01:00.000Z",
                        messages: [
                          {
                            role: "user" as const,
                            text: "External session",
                            createdAt: "2026-09-01T10:00:00.000Z",
                          },
                        ],
                      },
                    };
                  }),
                ),
            }),
          ),
        ),
      );
      const ownsSession = owner !== "none" && owner !== "other-instance";
      yield* Effect.gen(function* () {
        const importer = yield* AgentSessionImporter.AgentSessionImporter;
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
            importedCount: ownsSession ? 0 : 1,
            skippedCount: 0,
          });
          if (owner === "none" && attempt === 0) {
            // Recover an interrupted runtime write after history was committed.
            yield* runtimes.deleteByThreadId({ threadId: importId });
          }
        }
      }).pipe(Effect.provide(importerLayer));
      const imported = yield* Effect.option(projections.getThread(importId));
      expect(Option.isSome(imported)).toBe(!ownsSession);
      const importEvents = yield* eventStore.read({ threadId: importId }).pipe(Stream.runCollect);
      expect(importEvents).toHaveLength(ownsSession ? 0 : 4);
      if (owner !== "none") {
        const records = yield* projections.getThreadRecords(nativeId, ["providerThreads"]);
        expect(records.thread.title).toBe("Native thread");
        expect(records.thread.deletedAt).toEqual(nativeThread.deletedAt);
        expect(records.providerThreads).toHaveLength(1);
        expect(records.providerThreads[0]).toMatchObject(nativeProviderThread);
      }
      const runtime = yield* runtimes.getByThreadId({ threadId: importId });
      expect(Option.isSome(runtime)).toBe(!ownsSession);
    }).pipe(Effect.provide(persistence));
  },
);
