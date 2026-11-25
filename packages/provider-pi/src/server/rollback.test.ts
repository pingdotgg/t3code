import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePiAdapterV2, PI_PROVIDER } from "./adapter.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const time = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  seconds: number,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: DateTime.formatIso(time(seconds)),
  message: { role, content: [] },
});
const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: PI_PROVIDER,
  nativeId,
  strength,
});
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      entryId: Schema.optional(Schema.String),
      sessionPath: Schema.optional(Schema.String),
    }),
  ),
);

it.effect.each([
  "earlier checkpoint",
  "last checkpoint",
  "uncaptured handoff",
  "command-only handoff",
  "legacy turns",
  "checkpoint inherited by a prior fork",
  "repeated rollback after a handoff",
  "handoff prompt left in the source",
  "switch timed out after attaching",
] as const)("restores exactly the retained Pi history for %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldFile = `${dir}/old.jsonl`;
    const currentFile = `${dir}/current.jsonl`;
    const previousForkFile = `${dir}/previous-fork.jsonl`;
    const forkedFile = `${dir}/forked.jsonl`;
    const oldEntries = [
      entry("u1", null, "user", 10),
      entry("a1", "u1", "assistant", 15),
      entry("u2", "a1", "user", 30),
      entry("steer", "u2", "user", 33),
      entry("a2", "steer", "assistant", 35),
    ];
    const inherited = scenario === "checkpoint inherited by a prior fork";
    const handoffEntry = entry("u3", inherited ? "a2" : null, "user", 50);
    const newEntries =
      scenario === "command-only handoff"
        ? []
        : inherited
          ? [...oldEntries, handoffEntry]
          : [handoffEntry];
    const repeated = scenario === "repeated rollback after a handoff";
    const oldSuffix = repeated || scenario === "handoff prompt left in the source";
    const sessions = new Map([
      [oldFile, oldSuffix ? [...oldEntries, entry("discarded", "a2", "user", 45)] : oldEntries],
      [currentFile, newEntries],
    ]);
    if (repeated) sessions.set(previousForkFile, [...oldEntries, entry("u3", "a2", "user", 50)]);
    for (const [file, entries] of sessions) {
      yield* fs.writeFileString(
        file,
        [{ type: "session", version: 3, cwd: process.cwd() }, ...entries]
          .map((item) => JSON.stringify(item))
          .join("\n") + "\n",
      );
    }

    const output = yield* Queue.unbounded<Uint8Array>();
    const switchApplied = yield* Deferred.make<void>();
    const sessionRequests: { readonly type: string; readonly file: string }[] = [];
    let liveFile = currentFile;
    let pending = "";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const request = decodeRequest(line);
          const entries = sessions.get(liveFile) ?? [];
          let data: unknown = {};
          let error: string | undefined;
          if (request.type === "get_state") data = { sessionFile: liveFile };
          if (request.type === "get_entries")
            data = { entries, leafId: entries.at(-1)?.id ?? null };
          if (request.type === "switch_session") {
            if (request.sessionPath !== undefined && sessions.has(request.sessionPath)) {
              liveFile = request.sessionPath;
              sessionRequests.push({ type: "switch_session", file: liveFile });
              if (scenario === "switch timed out after attaching") {
                yield* Deferred.succeed(switchApplied, undefined);
                continue;
              }
              data = { cancelled: false };
            } else error = "Session not found";
          }
          if (request.type === "fork") {
            const index = entries.findIndex(({ id }) => id === request.entryId);
            if (index === -1) error = "Invalid entry ID for forking";
            else {
              sessionRequests.push({ type: "fork", file: liveFile });
              sessions.set(forkedFile, entries.slice(0, index));
              liveFile = forkedFile;
              data = { cancelled: false };
            }
          }
          yield* Queue.offer(
            output,
            encoder.encode(
              JSON.stringify({
                type: "response",
                id: request.id,
                command: request.type,
                success: error === undefined,
                data,
                error,
              }) + "\n",
            ),
          );
        }
      }),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin,
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const instanceId = ProviderInstanceId.make("pi");
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      environment: {},
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const threadId = ThreadId.make("pi-rollback");
    const modelSelection = { instanceId, model: "default" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("pi-rollback"),
      modelSelection,
      runtimePolicy,
    });
    const events = yield* runtime.events.pipe(Stream.runDrain, Effect.result, Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const turns = (repeated ? [1, 2, 3, 4] : [1, 2, 3]).map(
      (ordinal): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef:
          ordinal === 3 && scenario === "command-only handoff"
            ? null
            : ordinal === 3 && scenario === "uncaptured handoff"
              ? ref("uncaptured", "weak")
              : ref(`u${ordinal}`),
        ...(scenario === "legacy turns"
          ? {}
          : {
              nativeThreadRef: ref(
                ordinal < 3 ? oldFile : ordinal === 3 && repeated ? previousForkFile : currentFile,
              ),
            }),
        ordinal,
        status: "completed",
        startedAt: time(ordinal * 20 - 10),
        completedAt: time(ordinal * 20),
      }),
    );
    const shouldFork = scenario === "earlier checkpoint" || scenario === "legacy turns";
    const target = turns[shouldFork ? 0 : 1]!;
    const rollback = runtime.rollbackThread({
      providerThread,
      target: {
        type: "provider_turn",
        checkpointId: CheckpointId.make("checkpoint"),
        appRunOrdinal: target.ordinal,
        providerTurn: target,
      },
      providerThreadTurns: turns,
    });
    if (scenario === "switch timed out after attaching") {
      const attempt = yield* rollback.pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(switchApplied);
      assert.equal(liveFile, oldFile);
      yield* TestClock.adjust("61 seconds");
      assert.equal((yield* Fiber.join(attempt))._tag, "Failure");
      yield* Fiber.join(events);
      assert.include(["error", "stopped"], runtime.providerSession.status);
      assert.deepEqual(sessionRequests, [{ type: "switch_session", file: oldFile }]);
      return;
    }
    const restored = yield* rollback;
    assert.equal(
      restored.providerThread.nativeThreadRef?.nativeId,
      shouldFork || inherited || oldSuffix ? forkedFile : oldFile,
    );
    assert.equal(
      restored.providerThread.nativeConversationHeadRef?.nativeId,
      shouldFork ? "a1" : "a2",
    );
    assert.deepEqual(
      sessions.get(liveFile)?.map(({ id }) => id),
      shouldFork ? ["u1", "a1"] : ["u1", "a1", "u2", "steer", "a2"],
    );
    assert.deepEqual(
      sessionRequests,
      inherited
        ? [{ type: "fork", file: currentFile }]
        : [
            { type: "switch_session", file: repeated ? previousForkFile : oldFile },
            ...(shouldFork || oldSuffix
              ? [{ type: "fork", file: repeated ? previousForkFile : oldFile }]
              : []),
          ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
