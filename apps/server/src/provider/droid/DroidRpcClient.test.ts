// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { DroidRpcError, DroidRpcSpawnError, makeDroidRpcClient } from "./DroidRpcClient.ts";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/droid-mock-agent.ts",
);
const within = <A>(effect: Effect.Effect<A>, message: string) =>
  effect.pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(message)),
        onSome: Effect.succeed,
      }),
    ),
  );
function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

describe("DroidRpcClient", () => {
  it.effect("runs the canonical executable peer over stdio", () =>
    Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: mockAgentPath,
        args: [],
        env: { ...process.env, T3_DROID_MOCK_SCENARIO: "rpc-roundtrip" },
      });
      const notifications: string[] = [];
      const completed = yield* Deferred.make<void>();
      const notificationFiber = yield* Stream.runForEach(client.notifications, (event) =>
        Effect.sync(() => notifications.push(event.notification.type)).pipe(
          Effect.andThen(
            event.notification.type === "agent_turn_completed"
              ? Deferred.succeed(completed, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      const initialized = (yield* client.request("droid.initialize_session", {
        machineId: "t3-test",
        cwd: process.cwd(),
      })) as { readonly sessionId?: unknown };
      assert.equal(initialized.sessionId, "mock-session-1");
      yield* client.request("droid.add_user_message", {
        messageId: "turn-1",
        text: "ordinary user content",
      });

      const permission = yield* within(
        Stream.runHead(client.serverRequests),
        "permission request did not arrive",
      );
      assert.isTrue(Option.isSome(permission));
      if (Option.isNone(permission)) return;
      assert.equal(permission.value.id, "server-1");
      yield* permission.value.respond({ selectedOption: "proceed_once" });

      const ask = yield* within(
        Stream.runHead(client.serverRequests),
        "ask-user request did not arrive",
      );
      assert.isTrue(Option.isSome(ask));
      if (Option.isNone(ask)) return;
      assert.equal(ask.value.id, "server-2");
      yield* ask.value.respond({
        answers: [{ index: 1, question: "Which scope?", answer: "workspace" }],
      });

      yield* within(Deferred.await(completed), "turn did not complete");
      assert.includeMembers(notifications, [
        "thinking_text_delta",
        "tool_call",
        "tool_result",
        "assistant_text_delta",
        "agent_turn_completed",
      ]);
      assert.notInclude(notifications, "future_mock_notification");
      yield* within(client.shutdown, "client shutdown did not complete");
      assert.equal((yield* within(client.exits, "process exit was not detected")).code, 0);
      yield* Fiber.interrupt(notificationFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("reports spawn failures", () =>
    Effect.gen(function* () {
      const error = new DroidRpcSpawnError({ command: "droid", cause: new Error("ENOENT") });
      assert.equal(error.message, "Failed to spawn Droid process for command: droid");
      const result = yield* Effect.result(
        makeDroidRpcClient({
          command: NodePath.join(NodeOS.tmpdir(), "missing-droid-executable"),
          args: [],
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.instanceOf(result.failure, DroidRpcSpawnError);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects process exit and ends public streams", () =>
    Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
      });
      assert.equal((yield* within(client.exits, "process exit was not detected")).code, 7);
      const request = yield* Effect.result(
        client.request("droid.list_models", {}, { timeoutMs: undefined }),
      );
      assert.equal(request._tag, "Failure");
      if (request._tag === "Failure") {
        assert.equal(request.failure.kind, "process-exit");
        assert.instanceOf(request.failure, DroidRpcError);
      }
      const [notifications, serverRequests] = yield* within(
        Effect.all([
          Stream.runCollect(client.notifications),
          Stream.runCollect(client.serverRequests),
        ]),
        "public streams did not end",
      );
      assert.isEmpty(notifications);
      assert.isEmpty(serverRequests);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("drains a final stdout response before publishing process exit", () =>
    Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: [
          "-e",
          [
            'let buffer = "";',
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (chunk) => {',
            "  buffer += chunk;",
            '  const newline = buffer.indexOf("\\n");',
            "  if (newline < 0) return;",
            "  const request = JSON.parse(buffer.slice(0, newline));",
            "  const response = `${JSON.stringify({",
            "    jsonrpc: request.jsonrpc,",
            "    factoryApiVersion: request.factoryApiVersion,",
            "    factoryProtocolVersion: request.factoryProtocolVersion,",
            '    type: "response",',
            "    id: request.id,",
            '    result: { text: "after-exit" },',
            "  })}\\n`;",
            "  require('node:child_process').spawn(",
            "    process.execPath,",
            "    ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 20)', response],",
            "    { stdio: ['ignore', 'inherit', 'inherit'] },",
            "  );",
            "  process.exit(0);",
            "});",
          ].join("\n"),
        ],
      });

      const result = (yield* client.request(
        "droid.final_response",
        {},
        { timeoutMs: undefined },
      )) as { readonly text: string };
      assert.equal(result.text, "after-exit");
      assert.equal((yield* within(client.exits, "process exit was not detected")).code, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("settles pending requests before interrupting inherited process pipes", () => {
    const markerDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "droid-rpc-pipes-"));
    const pidPath = NodePath.join(markerDir, "descendant-pid");
    return Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            'process.stdin.once("data", () => {',
            '  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
            '    { stdio: ["ignore", "inherit", "inherit"] });',
            "  fs.writeFileSync(process.argv[1], String(descendant.pid));",
            "  process.exit(9);",
            "});",
          ].join("\n"),
          pidPath,
        ],
      });
      const request = yield* client
        .request("droid.pending_at_exit", {}, { timeoutMs: undefined })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const result = yield* within(
        Effect.result(Fiber.join(request)),
        "pending request was blocked by inherited process pipes",
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.kind, "process-exit");
      assert.equal((yield* within(client.exits, "process exit was not detected")).code, 9);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (NodeFS.existsSync(pidPath)) {
            const processId = Number(NodeFS.readFileSync(pidPath, "utf8"));
            if (isProcessAlive(processId)) process.kill(processId, "SIGKILL");
          }
          NodeFS.rmSync(markerDir, { recursive: true, force: true });
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    );
  });

  it.effect("kills a process whose stdout closes before exit", () =>
    Effect.gen(function* () {
      const markerDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "droid-rpc-exit-"));
      const pidPath = NodePath.join(markerDir, "pid");
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.stdout.end(); setInterval(() => {}, 1_000)',
          pidPath,
        ],
      });
      const exit = yield* within(client.exits, "stdout closure did not terminate transport");
      assert.equal(exit.code, null);
      assert.equal(exit.description, "Droid stdout stream closed before the process exited");
      assert.isFalse(isProcessAlive(Number(NodeFS.readFileSync(pidPath, "utf8"))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("times out requests blocked by OS stdin backpressure", () =>
    Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
      });
      const results = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.result(
            client.request(
              "droid.blocked_write",
              { text: "x".repeat(1024 * 1024) },
              { timeoutMs: 20 },
            ),
          ),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.timeoutOption("1 second"));
      assert.isTrue(Option.isSome(results));
      if (Option.isSome(results)) {
        assert.isTrue(
          results.value.every(
            (result) => result._tag === "Failure" && result.failure.kind === "timeout",
          ),
        );
      }
      yield* within(client.shutdown, "client shutdown did not complete");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("finishes process teardown when shutdown is interrupted", () => {
    let processId: number | undefined;
    return Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: [
          "-e",
          [
            'let buffer = "";',
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (chunk) => {',
            "  buffer += chunk;",
            '  const newline = buffer.indexOf("\\n");',
            "  if (newline < 0) return;",
            "  const request = JSON.parse(buffer.slice(0, newline));",
            "  process.stdout.write(`${JSON.stringify({",
            "    jsonrpc: request.jsonrpc,",
            "    factoryApiVersion: request.factoryApiVersion,",
            "    factoryProtocolVersion: request.factoryProtocolVersion,",
            '    type: "response",',
            "    id: request.id,",
            "    result: { pid: process.pid },",
            "  })}\\n`);",
            "});",
            "setInterval(() => {}, 1_000);",
          ].join("\n"),
        ],
      });
      const ready = (yield* client.request("droid.ready", {})) as { readonly pid: number };
      processId = ready.pid;
      const shutdownFiber = yield* client.shutdown.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* within(Fiber.interrupt(shutdownFiber), "interrupted shutdown did not finish teardown");
      yield* within(client.exits, "interrupted shutdown did not publish process exit");
      assert.isFalse(isProcessAlive(processId));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (processId !== undefined && isProcessAlive(processId)) {
            process.kill(processId, "SIGKILL");
          }
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    );
  });

  it.effect("logs stderr byte counts without payload text", () => {
    const logs: Array<{ readonly message: string; readonly details: object }> = [];
    const logger = Logger.make(({ message }) => {
      const parts = Array.isArray(message) ? message : [message];
      logs.push({
        message: String(parts[0]),
        details: typeof parts[1] === "object" && parts[1] !== null ? parts[1] : {},
      });
    });
    return Effect.gen(function* () {
      const client = yield* makeDroidRpcClient({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("y".repeat(2500)); process.exit(0)'],
      });
      yield* within(client.exits, "process exit was not detected");
      const diagnostic = logs.find((entry) => entry.message === "Droid stderr received");
      assert.deepEqual(diagnostic?.details, { stderrBytes: 2500 });
      assert.notInclude(
        Object.values(diagnostic?.details ?? {})
          .filter((value): value is string => typeof value === "string")
          .join(" "),
        "yyyy",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
      TestClock.withLive,
    );
  });
});
