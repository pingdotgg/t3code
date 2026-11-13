import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import {
  DEFAULT_CODEX_SETTINGS,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  codexReplayPreamble,
  makeCodexReplayTranscript,
  withReplayRequestId,
  openReplaySession,
  replayPreamble,
  nativeThreadId,
  request,
  nativeTurnId,
  prompt,
} from "./CodexAdapterV2-fixtures.testkit.ts";

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    compatibility?: CodexAdapterV2.CodexAdapterV2Options["compatibility"],
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript,
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        ...(compatibility === undefined ? {} : { compatibility }),
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(transcript.scenario).pipe(
          Effect.orDie,
        ),
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make(`thread-${transcript.scenario}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      return {
        ensureThread: (threadId: string) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        initializeRequests: () => initializeRequests,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect("sends one initialize when two threads start on a fresh session at once", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      // Codex rejects a second initialize; the replay permits one handshake.
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "concurrent-initialize",
          entries: [
            ...replayPreamble("concurrent-first").slice(0, 5),
            ...replayPreamble("concurrent-second")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const first = yield* session
        .ensureThread("thread-concurrent-first")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      const second = yield* session
        .ensureThread("thread-concurrent-second")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThreads = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.equal(session.initializeRequests(), 1);
      assert.sameMembers(
        providerThreads.map((providerThread) => providerThread.nativeThreadRef?.nativeId),
        ["concurrent-first", "concurrent-second"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  // regression: #16260 one-shot initializers raced; a failed handshake must be retried
  it.effect("retries initialize after a failed handshake", () =>
    Effect.gen(function* () {
      const preamble = replayPreamble("initialize-retry");
      const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
        ...preamble.slice(0, 1),
        {
          type: "emit_inbound",
          label: "initialize",
          frame: { id: 1, error: { code: -32603, message: "Codex is not ready." } },
        },
        ...preamble.slice(0, 2).map((entry) => withReplayRequestId(entry, 2)),
        ...preamble.slice(2, 3),
        ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
      ];
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({ scenario: "initialize-retry", entries }),
      );

      const failure = yield* session.ensureThread("thread-initialize-retry").pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterEnsureThreadError");
      const providerThread = yield* session.ensureThread("thread-initialize-retry");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-retry");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("refuses to open a session on a Codex version marked broken", () =>
    Effect.gen(function* () {
      const [initialize] = replayPreamble("broken-version");
      const failure = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "broken-version",
          entries: [
            initialize!,
            {
              type: "emit_inbound",
              label: "initialize",
              frame: {
                id: 1,
                result: {
                  userAgent: "T3 Code/0.144.3 (Mac OS 15.5.0; x86_64) unknown (T3 Code; 0.1.5)",
                  codexHome: "/tmp/codex-home",
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              },
            },
          ],
        }),
        undefined,
        (version) =>
          Effect.succeed(
            resolveProviderCompatibility(
              ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
              CodexAdapterV2.CODEX_DRIVER_KIND,
              version,
            ),
          ),
      ).pipe(Effect.flip);

      assert.instanceOf(failure, ProviderAdapter.ProviderAdapterOpenSessionError);
      assert.instanceOf(failure.cause, ProviderSetupError);
      assert.equal(
        failure.cause.message,
        "Codex 0.144.3 does not work with this T3 Code release. Update Codex to >=0.159.0, then retry.",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("completes the handshake after a caller is interrupted mid-initialize", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      const preamble = replayPreamble("initialize-interrupted");
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "initialize-interrupted",
          entries: [
            ...preamble.slice(0, 2),
            ...preamble.slice(0, 1).map((entry) => withReplayRequestId(entry, 2)),
            {
              type: "emit_inbound",
              label: "initialize-rejected",
              frame: { id: 2, error: { code: -32600, message: "Already initialized" } },
            },
            ...preamble.slice(2, 3),
            ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const interrupted = yield* session
        .ensureThread("thread-initialize-interrupted")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThread = yield* session.ensureThread("thread-initialize-interrupted");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-interrupted");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});
