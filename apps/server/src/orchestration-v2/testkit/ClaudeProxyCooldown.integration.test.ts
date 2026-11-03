import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ClaudeAdapter from "../Adapters/ClaudeAdapterV2.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Settings from "../../serverSettings.ts";
import { makeCliproxyApi } from "../../usage/cliproxyApi.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as Recovery from "../UsageLimitRecoveryWorker.ts";
import { materializeFixtureInput, CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";

const claudeSettings = Schema.decodeSync(ClaudeSettings)({});

it.effect.each([false, true])(
  "persists a managed Claude cooldown (cancel pending: %s)",
  (cancelPending) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
      const original = yield* readProviderReplayTranscript(
        new URL("./fixtures/claude_result_is_error/claude_transcript.ndjson", import.meta.url),
      );
      const error =
        "API Error: Request rejected (429) · All credentials for model claude-sonnet-4-6 are cooling down";
      const transcript = {
        ...original,
        entries: original.entries
          .filter(
            (entry) => !("label" in entry && entry.label === "assistant:synthetic_auth_error"),
          )
          .map((entry) => {
            if (!("label" in entry) || !("frame" in entry)) return entry;
            if (entry.label === "result:1_is_error")
              return {
                ...entry,
                frame: { ...(entry.frame as object), api_error_status: 429, result: error },
              };
            if (entry.label === "prompt.offer:2")
              return {
                ...entry,
                frame: {
                  type: "prompt.offer",
                  message: {
                    type: "user",
                    message: { role: "user", content: "Continue where you left off." },
                    parent_tool_use_id: null,
                  },
                },
              };
            return entry;
          }),
      };
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname;
              const body = path.endsWith("/config")
                ? { "api-keys": ["global"] }
                : path.endsWith("/models")
                  ? { models: [{ id: CLAUDE_MODEL_SELECTION.model }] }
                  : {
                      files: [
                        {
                          id: "a",
                          provider: "claude",
                          disabled: false,
                          cooldowns: [
                            { scope: "credential", reason: "credential_quota", retry_at: resetAt },
                          ],
                        },
                      ],
                    };
              return HttpClientResponse.fromWeb(request, Response.json(body));
            }),
          ),
        ),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "claude_result_is_error",
        fixtureInput: {
          steps: [{ type: "message", text: "Say hello before the credentials expire." }],
        },
        driver: ClaudeOrchestratorReplayHarness.driver,
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer));
      const decodedTranscript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(transcript);
      const scenario = { name: "managed-cooldown", transcript: decodedTranscript, ...materialized };
      let offers = 0;
      const harness = {
        ...ClaudeOrchestratorReplayHarness,
        makeProviderAdapterRegistryLayer: () =>
          Layer.effect(
            Registry.ProviderAdapterRegistryV2,
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const messages = yield* Queue.unbounded<SDKMessage>();
              const frame = (label: string) => {
                const entry = transcript.entries.find(
                  (entry) => "label" in entry && entry.label === label,
                );
                if (!entry || !("frame" in entry)) throw new Error(`Missing frame ${label}`);
                return entry.frame as SDKMessage;
              };
              const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
                instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
                settings: claudeSettings,
                environment: {},
                attachmentsDir: yield* fs.makeTempDirectoryScoped({ prefix: "claude-cooldown-" }),
                fileSystem: fs,
                path: yield* Path.Path,
                crypto: yield* Crypto.Crypto,
                idAllocator: yield* IdAllocator.IdAllocatorV2,
                usageLimitResetFallback: (model) =>
                  api
                    .poolResetAt(
                      {
                        kind: "cliproxy",
                        url: "http://hub.test",
                        managementKey: "management",
                        enabled: true,
                      },
                      { model, apiKey: "global" },
                    )
                    .pipe(Effect.orElseSucceed(() => null)),
                queryRunner: {
                  allocateSessionId: Effect.succeed("aa401aa4-e597-4e40-8e40-1e401e401e40"),
                  open: () =>
                    Effect.succeed({
                      messages: Stream.fromQueue(messages),
                      offer: () =>
                        Effect.suspend(() => {
                          offers += 1;
                          return Queue.offerAll(
                            messages,
                            offers === 1
                              ? [frame("system:init:1"), frame("result:1_is_error")]
                              : [frame("assistant:recovered"), frame("result:2_success")],
                          ).pipe(Effect.asVoid);
                        }),
                      setModel: () => Effect.void,
                      applyFlagSettings: () => Effect.void,
                      setPermissionMode: () => Effect.void,
                      backgroundTasks: () => Effect.succeed(false),
                      stopTask: () => Effect.void,
                      interrupt: Effect.void,
                      close: Queue.shutdown(messages),
                    }),
                  forkSession: () => Effect.die("unused fork"),
                  subagentLaunchToolUseId: () => Effect.succeed(null),
                  assertComplete: Effect.void,
                },
              });
              return {
                get: () => Effect.succeed(adapter),
                list: () => Effect.succeed([adapter.instanceId]),
              };
            }),
          ).pipe(Layer.provide(NodeServices.layer), Layer.provide(IdAllocator.layer), Layer.orDie),
      };
      const database = Sqlite.layerMemory;
      const runtime = layerProviderReplay(scenario, harness, { databaseLayer: database });
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        const threadId = materialized.projectionThreadIds[0]!;
        const shell = result.shellSnapshot.threads.find((thread) => thread.id === threadId)!;
        assert.equal(shell.lastErrorClass, "usage_limit");
        assert.equal(shell.usageLimitResetAt, resetAt);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(
          Recovery.limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now))!,
        );
        const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const resume = Recovery.limitRecoveryCommand(armed, true, Date.parse(resetAt))!;
        let deliveries = 0;
        const dependencies = Layer.mergeAll(
          Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
          Layer.succeed(
            ProjectionStore.ProjectionStoreV2,
            yield* ProjectionStore.ProjectionStoreV2,
          ),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Effect.sync(() => {
                deliveries += 1;
              }).pipe(Effect.andThen(orchestrator.dispatch(command))),
          }),
          Settings.layerTest(),
        );
        yield* Effect.gen(function* () {
          if (cancelPending) {
            assert.isNotNull(armed.limitRecovery);
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("cancel-pending-managed-recovery"),
              threadId,
              limitRecovery: null,
            });
            yield* TestClock.adjust("65 seconds");
            yield* orchestrator.dispatch(resume);
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
            assert.equal(deliveries, 0);
            assert.equal(offers, 1);
            return;
          }
          yield* TestClock.adjust("60 seconds");
          const after = yield* runOrchestratorV2Scenario({
            name: "await-managed-continuation",
            commands: [],
            steps: [{ type: "await_thread_idle", threadId }],
            projectionThreadIds: [threadId],
          });
          assert.deepEqual(
            after.projections.get(threadId)!.runs.map((run) => run.status),
            ["failed", "completed"],
          );
          assert.equal(deliveries, 1);
          yield* orchestrator.dispatch(resume);
          yield* TestClock.adjust("5 seconds");
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
          assert.equal(deliveries, 1);
          assert.equal(offers, 2);
        }).pipe(
          Effect.provide(
            Recovery.layer.pipe(Layer.provide(dependencies), Layer.provide(Scheduler.layer)),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(runtime, ProjectionStore.layer.pipe(Layer.provide(database))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
