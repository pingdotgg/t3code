import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
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

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { orchestrationHttpApiLayer } from "./http.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
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
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
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
  })),
);

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.makeLayer([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(Layer.provide(runtime)),
        OrchestrationEventStoreLive,
        ProjectStore.layer,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
        ...items.map((item) => ({
          id: EventId.make(`create-${item.id}`),
          type: "turn-item.updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: item,
        })),
      ],
    });
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
      Layer.provide(Layer.succeedContext(services)),
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

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const largeOutput = "界".repeat(100_000);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`enlarge-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: { ...item, output: largeOutput },
      })),
    });
    const oversized = yield* read(thread.id);
    expect(oversized.status).toBe(400);
    expect(yield* Effect.promise(() => oversized.json())).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "thread_transcript_too_large",
    });

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);
