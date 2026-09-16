// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CommandCodeSettings, ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

const MOCK_AGENT_PATH = NodeURL.fileURLToPath(
  new URL("../testFixtures/commandCodeHeadless/commandcode-mock-agent.cjs", import.meta.url),
);

function prepareMockHarness(): {
  readonly binaryPath: string;
  readonly argvLogPath: string;
  readonly cwd: string;
  readonly cleanup: () => void;
} {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cc-adapter-"));
  const argvLogPath = NodePath.join(cwd, "argv.json");
  const isWindows = process.platform === "win32";
  const binaryPath = NodePath.join(cwd, isWindows ? "command-code.cmd" : "command-code");
  NodeFS.writeFileSync(
    binaryPath,
    isWindows
      ? `@echo off\r\nnode "${MOCK_AGENT_PATH}" %*\r\n`
      : `#!/usr/bin/env sh\nexec node '${MOCK_AGENT_PATH.replaceAll("'", "'\"'\"'")}' "$@"\n`,
  );
  if (!isWindows) {
    NodeFS.chmodSync(binaryPath, 0o755);
  }
  return {
    binaryPath,
    argvLogPath,
    cwd,
    cleanup: () => NodeFS.rmSync(cwd, { recursive: true, force: true }),
  };
}

const runScoped = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)) as unknown as Effect.Effect<
      A,
      E
    >,
  );

function readArgvLog(path: string): { argv: string[]; prompt: string } {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as { argv: string[]; prompt: string };
}

function makeConfig(binaryPath: string): CommandCodeSettings {
  return {
    enabled: true,
    binaryPath,
    permissionMode: "auto-accept",
    launchArgs: "",
    customModels: [],
  } as unknown as CommandCodeSettings;
}

/** Run a scenario to its terminal runtime event and return every event seen. */
function collectN(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>> {
  return Stream.runCollect(Stream.take(stream, count)).pipe(
    Effect.map((events) => Array.from(events)),
  );
}

describe("CommandCodeAdapter (mock CLI)", () => {
  it("runs a successful turn, streams events, and resumes with the session id", async () => {
    const harness = prepareMockHarness();
    try {
      await runScoped(
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("commandCodeTest");
          const threadId = ThreadId.make("thread-1");
          const adapter = yield* makeCommandCodeAdapter(makeConfig(harness.binaryPath), {
            driverKind: ProviderDriverKind.make("commandCode"),
            instanceId,
            environment: { ...process.env, T3_MOCK_ARGV_LOG: harness.argvLogPath },
          });
          yield* adapter.startSession({ threadId, cwd: harness.cwd, runtimeMode: "full-access" });

          const eventsFiber = yield* Effect.forkScoped(collectN(adapter.streamEvents, 6));
          // Let the collector subscribe to the pubsub before the turn emits.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          const first = yield* adapter.sendTurn({
            threadId,
            input: "hola",
            modelSelection: { instanceId, model: "deepseek/deepseek-v4-flash" },
          });
          const events = yield* Fiber.join(eventsFiber);

          expect(events[0]?.type).toBe("turn.started");
          expect(events.some((event) => event.type === "item.started")).toBe(true);
          expect(
            events.some(
              (event) => event.type === "content.delta" && event.payload.delta === "Hola",
            ),
          ).toBe(true);
          expect(events.at(-1)?.type).toBe("turn.completed");
          expect(first.resumeCursor).toEqual({ sessionId: "mock-session-1" });

          // First run carried --yolo and the requested model.
          const firstArgv = readArgvLog(harness.argvLogPath);
          expect(firstArgv.argv).toContain("--yolo");
          expect(firstArgv.argv).toContain("--model");
          expect(firstArgv.argv).toContain("deepseek/deepseek-v4-flash");

          // A second turn resumes the same Command Code session.
          const second = yield* adapter.sendTurn({
            threadId,
            input: "segundo",
            continuation: true,
          });
          expect(second.resumeCursor).toEqual({ sessionId: "mock-session-1" });
          const resumedArgv = readArgvLog(harness.argvLogPath);
          expect(resumedArgv.argv).toContain("--resume");
          expect(resumedArgv.argv).toContain("mock-session-1");
        }),
      );
    } finally {
      harness.cleanup();
    }
  }, 30_000);

  it("interrupts an in-flight turn and emits turn.aborted", async () => {
    const harness = prepareMockHarness();
    try {
      await runScoped(
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("commandCodeTest");
          const threadId = ThreadId.make("thread-interrupt");
          const adapter = yield* makeCommandCodeAdapter(makeConfig(harness.binaryPath), {
            driverKind: ProviderDriverKind.make("commandCode"),
            instanceId,
            environment: {
              ...process.env,
              T3_MOCK_ARGV_LOG: harness.argvLogPath,
              T3_MOCK_HANG: "1",
            },
          });
          yield* adapter.startSession({ threadId, cwd: harness.cwd, runtimeMode: "full-access" });

          const eventsFiber = yield* Effect.forkScoped(collectN(adapter.streamEvents, 4));
          const sendFiber = yield* Effect.forkScoped(
            adapter.sendTurn({ threadId, input: "tarea larga" }),
          );
          // Wait until the mock has emitted its first assistant chunk (the
          // child is running and holding), then interrupt it.
          yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) => event.type === "content.delta" && event.payload.delta === "Hola",
            ),
            Stream.runDrain,
          );
          yield* adapter.interruptTurn(threadId);

          yield* Fiber.join(sendFiber);
          const events = yield* Fiber.join(eventsFiber);
          expect(events.some((event) => event.type === "turn.started")).toBe(true);
          expect(events.at(-1)?.type).toBe("turn.aborted");
        }),
      );
    } finally {
      harness.cleanup();
    }
  }, 30_000);
});
