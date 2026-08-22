// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  KimiSettings,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { kimiPromptSettlementBelongsToContext, makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const isWin = process.platform === "win32";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKimiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const jsPath = NodePath.join(dir, "kimi.mjs");
  const envJson = JSON.stringify(extraEnv ?? {});
  await NodeFSP.writeFile(
    jsPath,
    [
      "import { spawnSync } from 'node:child_process';",
      `const env = ${envJson};`,
      "const args = process.argv.slice(2);",
      'if (args[0] !== "acp") {',
      "  process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "  process.exit(11);",
      "}",
      `const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(mockAgentPath)}], {`,
      "  stdio: 'inherit',",
      "  env: { ...process.env, ...env },",
      "});",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    "utf8",
  );

  if (isWin) {
    const cmdPath = NodePath.join(dir, "kimi.cmd");
    await NodeFSP.writeFile(
      cmdPath,
      ["@echo off", `node "${jsPath.replaceAll("/", "\\")}" %*`, ""].join("\r\n"),
      "utf8",
    );
    return cmdPath;
  }

  const shPath = NodePath.join(dir, "fake-kimi.sh");
  await NodeFSP.writeFile(
    shPath,
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsPath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await NodeFSP.chmod(shPath, 0o755);
  return shPath;
}

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKimiAdapter>[1]) =>
  makeKimiAdapter(decodeKimiSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Kimi turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    kimiPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    kimiPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockKimiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, ProviderDriverKind.make("kimi"));
      assert.equal(session.status, "ready");
      assert.isTrue(yield* adapter.hasSession(threadId));

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello from kimi adapter test",
      });
      assert.equal(turn.threadId, threadId);

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const eventTypes = runtimeEvents.map((event) => event.type);
      assert.includeMembers(eventTypes, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.completed",
      ]);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("rejects startSession without a cwd", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockKimiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("kimi-no-cwd"),
          provider: ProviderDriverKind.make("kimi"),
          cwd: "   ",
          runtimeMode: "full-access",
        }),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );
});
