// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro-cli.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const attempt = (remaining: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remaining <= 0) return yield* Effect.die(`Timed out waiting for ${filePath}`);
      const content = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (content.trim()) return content;
      yield* Effect.sleep("25 millis");
      return yield* attempt(remaining - 1);
    });
  return attempt(attempts);
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("KiroAdapter", (it) => {
  it.effect("starts a session, sends a message, and streams the response", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-message");
      const binaryPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello kiro", attachments: [] });

      assert.equal(session.provider, "kiro");
      assert.include(
        events.map((event) => event.type),
        "content.delta",
      );
      assert.include(
        events.map((event) => event.type),
        "turn.completed",
      );
      assert.equal(
        events.find((event) => event.type === "content.delta")?.payload.delta,
        "hello from mock",
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops an in-flight message and accepts a follow-up", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-interrupt");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const firstApproval = yield* Deferred.make<ApprovalRequestId>();
      const secondApproval = yield* Deferred.make<ApprovalRequestId>();
      let approvalCount = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type !== "request.opened") return;
          approvalCount += 1;
          const deferred = approvalCount === 1 ? firstApproval : secondApproval;
          yield* Deferred.succeed(deferred, ApprovalRequestId.make(String(event.requestId))).pipe(
            Effect.ignore,
          );
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "stop this", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstApproval);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurn);
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "continue", attachments: [] })
        .pipe(Effect.forkChild);
      yield* adapter.respondToRequest(threadId, yield* Deferred.await(secondApproval), "accept");
      yield* Fiber.join(followUp);

      const completed = events.filter((event) => event.type === "turn.completed");
      assert.deepEqual(
        completed.map((event) => event.payload.state),
        ["cancelled", "completed"],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("closes the Kiro ACP child when the session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-stop-session");
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-exit-")),
      );
      const exitLogPath = NodePath.join(dir, "exit.log");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      assert.include(yield* waitForFileContent(exitLogPath), "SIGTERM");
    }),
  );
});
