import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const modelSelection = { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
const settings = Schema.decodeSync(CodexSettings)({});

describe("Codex shared session recovery", () => {
  it.effect.each(["SIGKILL", "exit code"] as const)(
    "fails active turns and replaces the shared app-server after %s",
    (termination) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-session-recovery-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
        const testSpawner = ChildProcessSpawner.make(() =>
          spawner
            .spawn(
              ChildProcess.make(
                process.execPath,
                [
                  path.join(
                    import.meta.dirname,
                    "../../provider/testFixtures/codexSessionRecoveryMockPeer.mjs",
                  ),
                ],
                { cwd },
              ),
            )
            .pipe(Effect.tap((handle) => Effect.sync(() => handles.push(handle)))),
        );
        const layerFactory = CodexAdapterV2.layerAppServerClientFactory.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, testSpawner)),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );
        const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
          Effect.gen(function* () {
            const adapter = CodexAdapterV2.makeCodexAdapterV2({
              instanceId: modelSelection.instanceId,
              settings,
              environment: {},
              clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
              crypto: yield* Crypto.Crypto,
              fileSystem: yield* FileSystem.FileSystem,
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              serverConfig: yield* ServerConfig.ServerConfig,
            });
            return [adapter];
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              layerFactory,
              IdAllocator.layer,
              ServerConfig.layerTest(cwd, { prefix: "t3-codex-session-recovery-config-" }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const createAndStart = (threadId: ThreadId) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`create:${threadId}`),
                threadId,
                projectId: ProjectId.make("project:codex-session-recovery"),
                title: threadId,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "user",
                creationSource: "web",
              });
              yield* send(threadId, "start");
            });
          const send = (threadId: ThreadId, text: string) =>
            Effect.gen(function* () {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`send:${threadId}:${text}`),
                threadId,
                messageId: MessageId.make(`message:${threadId}:${text}`),
                text,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              assert.equal(
                (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                "running",
              );
            });
          const threadA = ThreadId.make("thread:codex-recovery-a");
          const threadB = ThreadId.make("thread:codex-recovery-b");
          yield* createAndStart(threadA);
          yield* createAndStart(threadB);
          assert.equal(handles.length, 1);
          const sessionA = (yield* orchestrator.getThreadProjection(threadA)).providerSessions.at(
            -1,
          )!;
          const sessionB = (yield* orchestrator.getThreadProjection(threadB)).providerSessions.at(
            -1,
          )!;
          assert.equal(sessionA.id, sessionB.id);
          const beforeTermination = yield* eventSink.latestSequence();
          const handle = handles[0]!;
          if (termination === "SIGKILL") {
            yield* handle.kill({ killSignal: "SIGKILL" });
          } else {
            const encoder = new TextEncoder();
            yield* Stream.make(encoder.encode('{"id":999,"method":"test/exit"}\n')).pipe(
              Stream.run(handle.stdin),
            );
          }
          const exit = yield* Effect.exit(handle.exitCode);
          assert.equal(Exit.isFailure(exit), termination === "SIGKILL");
          if (Exit.isSuccess(exit)) assert.equal(Number(exit.value), 7);

          // Await committed failures, rather than guessing when the event pump ran.
          yield* eventSink
            .stream({ afterSequence: beforeTermination, eventType: "provider-session.updated" })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "provider-session.updated" && event.payload.status === "error",
              ),
              Stream.take(2),
              Stream.runDrain,
            );
          yield* eventSink
            .stream({ afterSequence: beforeTermination, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                ({ event }) => event.type === "run.updated" && event.payload.status === "failed",
              ),
              Stream.take(2),
              Stream.runDrain,
            );
          yield* worker.drain();
          assert.isTrue(Option.isNone(yield* manager.get(sessionA.id)));
          for (const threadId of [threadA, threadB]) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(projection.runs.at(-1)?.status, "failed");
            assert.equal(projection.providerSessions.at(-1)?.status, "error");
          }

          yield* createAndStart(ThreadId.make("thread:codex-recovery-new"));
          assert.equal(handles.length, 2);
          assert.notEqual(handles[0]!.pid, handles[1]!.pid);
          yield* send(threadA, "retry");
          assert.equal(handles.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `codex-session-recovery-${termination}`, runtimePolicyOverride: { cwd } },
              layerRegistry,
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
