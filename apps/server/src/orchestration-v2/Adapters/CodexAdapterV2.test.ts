import {
  CheckpointId,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import {
  makeCodexAppServerProtocolLogger,
  makeCodexAppServerSpawnCommand,
  resolveCodexRollbackTurnCount,
} from "./CodexAdapterV2.ts";

describe("CodexAdapterV2 process spawning", () => {
  it.effect("resolves Windows command shims through the shared spawn policy", () =>
    Effect.gen(function* () {
      const command = yield* makeCodexAppServerSpawnCommand({
        command: "codex",
        args: ["app-server", "argument with spaces"],
        cwd: "C:\\workspace",
        env: { CUSTOM: "1" },
        extendEnv: true,
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, '^"C:\\npm\\codex.cmd^"');
      assert.deepEqual(command.args, ['^"app-server^"', '^"argument^ with^ spaces^"']);
      assert.equal(command.options.shell, true);
      assert.equal(command.options.cwd, "C:\\workspace");
      assert.deepEqual(command.options.env, { CUSTOM: "1" });
      assert.equal(command.options.extendEnv, true);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\Windows\\System32",
        HOST_ONLY: "1",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
        assert.equal(environment.HOST_ONLY, "1");
        assert.equal(environment.CUSTOM, "1");
        return "C:\\npm\\codex.cmd";
      }),
    ),
  );

  it.effect("uses direct execution for native executables", () =>
    Effect.gen(function* () {
      const command = yield* makeCodexAppServerSpawnCommand({
        command: "codex.exe",
        args: ["app-server"],
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, "C:\\bin\\codex.exe");
      assert.deepEqual(command.args, ["app-server"]);
      assert.equal(command.options.shell, false);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
    ),
  );
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("writes app-server protocol frames to the native provider log", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: { method: "thread/event", params: { id: "evt-1" } },
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: { method: "thread/event", params: { id: "evt-1" } },
        },
      });
    }),
  );

  it("does not install a protocol logger when native logging is unavailable", () => {
    const protocolLogger = makeCodexAppServerProtocolLogger({
      nativeEventLogger: undefined,
      threadId: ThreadId.make("thread-1"),
      providerSessionId: ProviderSessionId.make("provider-session-1"),
    });

    assert.equal(protocolLogger, undefined);
  });
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        provider: "codex",
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          provider: "codex",
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          provider: "codex",
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");

      const numTurns = yield* resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});
