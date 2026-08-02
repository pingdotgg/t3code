import type { V2Event } from "@opencode-ai/sdk-next/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OpenCode2Settings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import * as OpenCode2Runtime from "../../provider/opencode2Runtime.ts";
import * as SpawnedProcessReaper from "../../provider/SpawnedProcessReaper.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  makeOpenCode2AdapterV2,
  OpenCode2ProviderCapabilitiesV2,
  unwrapOpenCode2Data,
} from "./OpenCode2AdapterV2.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode2-pending-work-",
}).pipe(Layer.provide(NodeServices.layer));
const decodeOpenCode2Settings = Schema.decodeUnknownEffect(OpenCode2Settings);
const layer = Layer.mergeAll(
  OpenCode2Runtime.layer.pipe(
    Layer.provide(SpawnedProcessReaper.layer),
    Layer.provide(NodeServices.layer),
  ),
  idAllocatorLayer,
  serverConfigLayer,
);

type OpenCode2CompactionEvent = Extract<
  V2Event,
  {
    type:
      | "session.compaction.admitted"
      | "session.compaction.started"
      | "session.compaction.delta"
      | "session.compaction.ended"
      | "session.compaction.failed";
  }
>;

function isOpenCode2CompactionEvent(event: V2Event): event is OpenCode2CompactionEvent {
  return (
    event.type === "session.compaction.admitted" ||
    event.type === "session.compaction.started" ||
    event.type === "session.compaction.delta" ||
    event.type === "session.compaction.ended" ||
    event.type === "session.compaction.failed"
  );
}

describe.runIf(process.env.T3_OPENCODE2_LIVE === "1")(
  "OpenCode 2 adapter pending work (live)",
  () => {
    it.effect(
      "pins only its running shells and emits a wake when the shell exits",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const serverConfig = yield* ServerConfig;
            const idAllocator = yield* IdAllocatorV2;
            const runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
            const server = yield* runtime.startOpenCode2ServerProcess({
              binaryPath: "opencode2",
            });
            const client = runtime.createOpenCode2SdkClient({
              baseUrl: server.url,
              directory: process.cwd(),
              serverPassword: server.password,
            });
            const instanceId = ProviderInstanceId.make("opencode2-live-test");
            const modelSelection = {
              instanceId,
              model: "opencode/glm-5.2",
              options: [],
            };
            const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            });
            const adapter = makeOpenCode2AdapterV2({
              instanceId,
              settings: yield* decodeOpenCode2Settings({
                binaryPath: "opencode2",
                serverUrl: server.url,
                serverPassword: server.password,
              }),
              environment: process.env,
              runtime,
              idAllocator,
              serverConfig,
            });
            const session = yield* adapter.openSession({
              threadId: ThreadId.make("thread-opencode2-live-test"),
              providerSessionId: ProviderSessionId.make("provider-session-opencode2-live-test"),
              modelSelection,
              runtimePolicy,
            });
            const providerThread = yield* session.ensureThread({
              threadId: ThreadId.make("thread-opencode2-live-test"),
              modelSelection,
              runtimePolicy,
            });
            const sessionID = providerThread.nativeThreadRef?.nativeId;
            assert.isString(sessionID);
            assert.isDefined(session.hasPendingBackgroundWork);
            assert.isDefined(session.hasPendingBackgroundWorkForThread);

            const created = yield* OpenCode2Runtime.runOpenCode2Sdk("shell.create", () =>
              client.v2.shell.create({
                location: { directory: process.cwd() },
                command: "sleep 20",
                timeout: 30_000,
                metadata: { sessionID },
              }),
            );
            const shell = yield* unwrapOpenCode2Data<{ readonly id: string }>(
              "shell.create",
              created,
            );

            assert.isTrue(yield* session.hasPendingBackgroundWork!);
            assert.isTrue(yield* session.hasPendingBackgroundWorkForThread!(providerThread));
            const createdWake = yield* session.events.pipe(
              Stream.filter((event) => event.type === "provider_thread.updated"),
              Stream.runHead,
              Effect.timeoutOption("5 seconds"),
            );
            assert.isTrue(Option.isSome(createdWake));

            yield* OpenCode2Runtime.runOpenCode2Sdk("shell.remove", () =>
              client.v2.shell.remove({
                id: shell.id,
                location: { directory: process.cwd() },
              }),
            );
            const exitedWake = yield* session.events.pipe(
              Stream.filter((event) => event.type === "provider_thread.updated"),
              Stream.runHead,
              Effect.timeoutOption("5 seconds"),
            );
            assert.isTrue(Option.isSome(exitedWake));
            assert.isFalse(yield* session.hasPendingBackgroundWork!);
            assert.isFalse(yield* session.hasPendingBackgroundWorkForThread!(providerThread));
          }),
        ).pipe(Effect.provide(layer)),
      { timeout: 60_000 },
    );

    it.live(
      "observes the native compaction lifecycle used by the adapter projection",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
            const server = yield* runtime.startOpenCode2ServerProcess({
              binaryPath: "opencode2",
            });
            const client = runtime.createOpenCode2SdkClient({
              baseUrl: server.url,
              directory: process.cwd(),
              serverPassword: server.password,
            });
            const abortController = new AbortController();
            yield* Effect.addFinalizer(() => Effect.sync(() => abortController.abort()));
            const subscription = yield* OpenCode2Runtime.runOpenCode2Sdk("event.subscribe", () =>
              client.v2.event.subscribe({ signal: abortController.signal }),
            );
            const created = yield* OpenCode2Runtime.runOpenCode2Sdk("session.create", () =>
              client.v2.session.create({
                location: { directory: process.cwd() },
                model: { providerID: "opencode", id: "glm-5.2" },
              }),
            );
            const session = yield* unwrapOpenCode2Data<{ readonly id: string }>(
              "session.create",
              created,
            );
            yield* Effect.addFinalizer(() =>
              OpenCode2Runtime.runOpenCode2Sdk("session.remove", () =>
                client.v2.session.remove({ sessionID: session.id }),
              ).pipe(Effect.ignore),
            );
            const eventFiber = yield* Stream.fromAsyncIterable(
              subscription.stream,
              (cause) =>
                new OpenCode2Runtime.OpenCode2RuntimeError({
                  operation: "event.subscribe",
                  category: "event-subscription-failed",
                  cause,
                }),
            ).pipe(
              Stream.filter(
                (event): event is OpenCode2CompactionEvent =>
                  isOpenCode2CompactionEvent(event) && event.data.sessionID === session.id,
              ),
              Stream.takeUntil(
                (event) =>
                  event.type === "session.compaction.ended" ||
                  event.type === "session.compaction.failed",
              ),
              Stream.runCollect,
              Effect.forkScoped,
            );

            yield* OpenCode2Runtime.runOpenCode2Sdk("session.prompt", () =>
              client.v2.session.prompt({
                sessionID: session.id,
                text: "Remember this sentence: native compaction fixture context.",
              }),
            );
            yield* OpenCode2Runtime.runOpenCode2Sdk("session.wait", () =>
              client.v2.session.wait({ sessionID: session.id }),
            );
            const compactionId = `msg_t3_live_compaction_${yield* Clock.currentTimeMillis}`;
            yield* OpenCode2Runtime.runOpenCode2Sdk("session.compact", () =>
              client.v2.session.compact({
                sessionID: session.id,
                id: compactionId,
              }),
            );
            yield* OpenCode2Runtime.runOpenCode2Sdk("session.wait", () =>
              client.v2.session.wait({ sessionID: session.id }),
            );

            const events = Array.from(
              yield* Fiber.join(eventFiber).pipe(Effect.timeout("60 seconds")),
            );
            assert.deepEqual(
              events
                .filter((event) => event.type !== "session.compaction.delta")
                .map((event) => event.type),
              [
                "session.compaction.admitted",
                "session.compaction.started",
                "session.compaction.ended",
              ],
            );
            const ended = events.find((event) => event.type === "session.compaction.ended");
            assert.isDefined(ended);
            assert.isAbove(ended.data.text.length, 0);
          }),
        ).pipe(Effect.provide(layer)),
      { timeout: 120_000 },
    );

    it.live(
      "deletes a detached native session idempotently",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const serverConfig = yield* ServerConfig;
            const idAllocator = yield* IdAllocatorV2;
            const runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
            const server = yield* runtime.startOpenCode2ServerProcess({
              binaryPath: "opencode2",
            });
            const client = runtime.createOpenCode2SdkClient({
              baseUrl: server.url,
              directory: process.cwd(),
              serverPassword: server.password,
            });
            const instanceId = ProviderInstanceId.make("opencode2-live-delete-test");
            const providerSessionId = ProviderSessionId.make(
              "provider-session-opencode2-live-delete-test",
            );
            const adapter = makeOpenCode2AdapterV2({
              instanceId,
              settings: yield* decodeOpenCode2Settings({
                binaryPath: "opencode2",
                serverUrl: server.url,
                serverPassword: server.password,
              }),
              environment: process.env,
              runtime,
              idAllocator,
              serverConfig,
            });
            const deleteDetachedThread = adapter.deleteDetachedThread;
            assert.isDefined(deleteDetachedThread);

            const created = yield* OpenCode2Runtime.runOpenCode2Sdk("session.create", () =>
              client.v2.session.create({
                location: { directory: process.cwd() },
                model: { providerID: "opencode", id: "glm-5.2" },
              }),
            );
            const nativeSession = yield* unwrapOpenCode2Data<{ readonly id: string }>(
              "session.create",
              created,
            );
            const now = yield* DateTime.now;
            const providerSession = {
              id: providerSessionId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              status: "stopped" as const,
              cwd: process.cwd(),
              model: "opencode/glm-5.2",
              capabilities: OpenCode2ProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            };
            const providerThread = {
              id: idAllocator.derive.providerThread({
                driver: adapter.driver,
                nativeThreadId: nativeSession.id,
              }),
              driver: adapter.driver,
              providerInstanceId: instanceId,
              providerSessionId,
              appThreadId: ThreadId.make("thread-opencode2-live-delete-test"),
              ownerNodeId: null,
              nativeThreadRef: {
                driver: adapter.driver,
                nativeId: nativeSession.id,
                strength: "strong" as const,
              },
              nativeConversationHeadRef: null,
              status: "idle" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: now,
              updatedAt: now,
            };

            yield* deleteDetachedThread({ providerSession, providerThread });
            yield* deleteDetachedThread({ providerSession, providerThread });

            const missing = yield* OpenCode2Runtime.runOpenCode2Sdk("session.get", () =>
              client.v2.session.get({ sessionID: nativeSession.id }, { throwOnError: false }),
            );
            assert.equal(missing.response.status, 404);
          }),
        ).pipe(Effect.provide(layer)),
      { timeout: 60_000 },
    );
  },
);
