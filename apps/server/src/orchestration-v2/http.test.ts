import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadTranscript,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { orchestrationHttpApiLayer } from "./http.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const output = "Full tool output. ".repeat(4_000);
const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
  thread: {
    id: "source-thread",
    projectId: "source-project",
    title: "Source conversation",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  updatedAt: now,
  visibleTurnItems: Array.from({ length: 200 }, (_, position) => ({
    position,
    visibility: "inherited",
    sourceThreadId: "parent-thread",
    sourceItemId: `item-${position}`,
    item: {
      id: `item-${position}`,
      threadId: "parent-thread",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      type: "command_execution",
      status: "completed",
      title: "Read notes",
      input: "cat notes.md",
      output: position === 0 ? output : "Done",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  })),
});

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    let snapshotProjection = projection;
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed ? ["orchestration:read"] : []),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(
        Layer.mock(ThreadManagementService)({
          getThreadSnapshot: (threadId) =>
            threadId === projection.thread.id
              ? Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 1,
                  projection: snapshotProjection,
                })
              : Effect.fail(
                  new OrchestratorProjectionError({
                    threadId,
                    cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                  }),
                ),
        }),
      ),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(Layer.mock(OrchestrationEventStore)({})),
      Layer.provide(Layer.mock(ProjectStoreV2)({})),
      Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const response = yield* read(projection.thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("inherited");
    expect(transcript.items[199]?.position).toBe(199);

    const largeOutput = "界".repeat(100_000);
    snapshotProjection = {
      ...projection,
      visibleTurnItems: projection.visibleTurnItems.map((row) => ({
        ...row,
        item: { ...row.item, output: largeOutput },
      })),
    };
    const oversized = yield* read(projection.thread.id);
    expect(oversized.status).toBe(400);
    expect(yield* Effect.promise(() => oversized.json())).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "thread_transcript_too_large",
    });

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(projection.thread.id)).status).toBe(403);
  }),
);
