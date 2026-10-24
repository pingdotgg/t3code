import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import wire from "../../provider/testFixtures/codexMultiAgentWire.json" with { type: "json" };

const settings = Schema.decodeSync(CodexSettings)({});

it.effect("starts the next Codex turn on a fresh app-server after SIGKILL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-recovery-" });
    const scriptPath = `${cwd}/script.json`;
    yield* fs.writeFileString(
      scriptPath,
      JSON.stringify({ rootThreadId: wire.rootThreadId, notifications: [], holdTurnOpen: true }),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
    const testSpawner = ChildProcessSpawner.make(() =>
      spawner
        .spawn(
          ChildProcess.make(
            process.execPath,
            [`${import.meta.dirname}/../../provider/testFixtures/codexCollabMockPeer.mjs`],
            { cwd, env: { T3_CODEX_COLLAB_SCRIPT: scriptPath }, extendEnv: true },
          ),
        )
        .pipe(Effect.tap((handle) => Effect.sync(() => handles.push(handle)))),
    );
    const modelSelection = {
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      model: "gpt-5.4",
    };
    const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        return [
          yield* CodexAdapterV2.makeCodexAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
            crypto: yield* Crypto.Crypto,
            fileSystem: fs,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            serverConfig: yield* ServerConfig.ServerConfig,
          }),
        ];
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          ServerConfig.layerTest(cwd, cwd),
          CodexAdapterV2.layerAppServerClientFactory.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, testSpawner)),
            Layer.provide(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
          ),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("thread:codex-recovery");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:codex-recovery"),
        threadId,
        projectId: ProjectId.make("project:codex-recovery"),
        title: "Codex recovery",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const send = (text: string) =>
        orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${text}`),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.andThen(worker.drain()));
      yield* send("first");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(before.runs.at(-1)?.status, "running");
      assert.equal(handles.length, 1);
      const sessionId = before.providerSessions.at(-1)!.id;
      const afterSequence = yield* eventSink.latestSequence();
      yield* handles[0]!.kill({ killSignal: "SIGKILL" });

      yield* eventSink
        .stream({ threadId, afterSequence, eventType: "provider-session.updated" })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "provider-session.updated" && event.payload.status === "error",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* eventSink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
        Stream.filter(
          ({ event }) => event.type === "run.updated" && event.payload.status === "failed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      assert.isTrue(Option.isNone(yield* manager.get(sessionId)));
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
        "failed",
      );

      yield* send("retry");
      assert.equal(handles.length, 2);
      assert.notEqual(handles[0]!.pid, handles[1]!.pid);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
        "running",
      );
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "codex-session-recovery", runtimePolicyOverride: { cwd } },
          layerRegistry,
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
