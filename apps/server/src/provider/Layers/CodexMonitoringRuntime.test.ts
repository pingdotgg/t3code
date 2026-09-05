import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import * as MonitorSession from "../../mcp/MonitorSession.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const decodeInspection = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      wakes: Schema.Array(Schema.Struct({ name: Schema.String, output: Schema.String })),
      cleanCount: Schema.Number,
      interrupted: Schema.Number,
    }),
  ),
);

const setup = Effect.fn("setup")(function* (version = "0.153.2", mcp = false) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-monitor-runtime-test-" });
  // The runtime invokes <binary> app-server; Node executes this local fixture.
  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(new URL("../testFixtures/codexMonitorAppServer.cjs", import.meta.url)),
    path.join(cwd, "app-server"),
  );
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("monitor-test"),
    binaryPath: process.execPath,
    mcpProviderSessionId: cwd,
    ...(mcp ? { appServerArgs: ["-c", "mcp_servers.t3-code.url=http://localhost/mcp"] } : {}),
    cwd,
    runtimeMode: "full-access",
    environment: { ...process.env, T3_MONITOR_TEST_VERSION: version },
  });
  const events = yield* Queue.unbounded<ProviderEvent>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkChild,
  );
  yield* runtime.start();
  const until = Effect.fn("until")(function* (method: string) {
    for (;;) {
      const event = yield* Queue.take(events);
      if (event.method === method) return event;
    }
  });
  const inspect = runtime.readThread.pipe(
    Effect.map((snapshot) => {
      const item = snapshot.turns[0]?.items[0];
      assert.isDefined(item);
      assert.equal(item.type, "agentMessage");
      if (item.type !== "agentMessage") throw new Error("Expected inspection message");
      return decodeInspection(item.text);
    }),
  );
  const subscribe = (yield* MonitorSession.MonitorSessions).invoke(cwd, "subscribe", "42");
  return { runtime, until, inspect, subscribe };
});

it.effect("wakes an idle thread from tool output and stops without a shutdown wake", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "watch" });
    const task = yield* until("backgroundTask/changed");
    assert.deepStrictEqual(task.payload, {
      taskId: "watch-command",
      description: "watch-ci",
      status: "running",
    });
    yield* until("turn/completed");
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("turn/completed");
    assert.deepStrictEqual((yield* inspect).wakes, [
      {
        name: "background_monitor",
        output: '{"taskId":"watch-command","output":"CI passed"}',
      },
    ]);
    yield* runtime.interruptTurn();
    yield* until("item/completed");
    const final = yield* inspect;
    assert.equal(final.cleanCount, 1);
    assert.equal(final.wakes.length, 1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("delivers wakes when a user turn completes before its start response", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    const sending = yield* runtime.sendTurn({ input: "early-completion" }).pipe(Effect.forkChild);
    yield* until("turn/completed");
    yield* runtime.compactThread;
    yield* Fiber.join(sending);
    assert.equal((yield* runtime.getSession).activeTurnId, undefined);
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("turn/completed");
    assert.equal((yield* inspect).wakes.length, 1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("queues watcher events until the foreground turn completes", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "busy" });
    yield* until("item/started");
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("thread/name/updated");
    assert.equal((yield* inspect).wakes.length, 0);
    yield* runtime.compactThread;
    yield* until("turn/completed");
    yield* until("turn/completed");
    assert.equal((yield* inspect).wakes.length, 1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("Stop drops queued events and still interrupts if terminal cleanup fails", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "cleanup-failure" });
    yield* until("item/started");
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("thread/name/updated");
    const result = yield* runtime.interruptTurn().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    const stopped = yield* until("backgroundTask/changed");
    assert.deepStrictEqual(stopped.payload, {
      taskId: "watch-command",
      description: "watch-ci",
      status: "stopped",
    });
    yield* until("turn/completed");
    const final = yield* inspect;
    assert.equal(final.interrupted, 1);
    assert.equal(final.wakes.length, 0);
    yield* runtime.sendTurn({ input: "resume" });
    yield* until("turn/completed");
    assert.equal((yield* subscribe.pipe(Effect.result))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("flushes a final partial event when the process exits", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "exit" });
    yield* until("turn/completed");
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("turn/completed");
    assert.include((yield* inspect).wakes[0]!.output, "partial");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("does not register monitoring on unsupported Codex versions", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup("0.146.0");
    yield* runtime.sendTurn({ input: "watch" });
    yield* until("turn/completed");
    assert.equal((yield* subscribe.pipe(Effect.result))._tag, "Failure");
    yield* runtime.compactThread;
    yield* until("thread/name/updated");
    yield* runtime.interruptTurn();
    const final = yield* inspect;
    assert.equal(final.cleanCount, 0);
    assert.equal(final.wakes.length, 0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

it.effect("never delivers a child command's output to the parent monitor", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "child" });
    yield* until("turn/completed");
    yield* subscribe;
    yield* runtime.compactThread;
    yield* until("thread/name/updated");
    assert.equal((yield* inspect).wakes.length, 0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

for (const scenario of ["stall-turn", "stall-reload"]) {
  it.effect(`Stop reaches the provider when ${scenario} never responds`, () =>
    Effect.gen(function* () {
      const { runtime, until, inspect } = yield* setup("0.153.2", scenario === "stall-reload");
      yield* runtime.sendTurn({ input: scenario });
      yield* until("item/started");
      const sending = yield* runtime
        .sendTurn({ input: "follow up" })
        .pipe(Effect.result, Effect.forkChild);
      yield* until("thread/name/updated");
      const stopping = yield* runtime.interruptTurn().pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(sending))._tag, "Failure");
      yield* Fiber.join(stopping);
      const final = yield* inspect;
      assert.equal(final.cleanCount, 1);
      assert.equal(final.interrupted, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer)),
    ),
  );
}

it.effect("retains an explicitly rejected wake until a user turn resumes delivery", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "reject-wake" });
    yield* until("turn/completed");
    yield* subscribe;
    yield* runtime.compactThread;
    const failed = yield* until("backgroundMonitor/wakeFailed");
    assert.deepStrictEqual(failed.payload, {
      monitorEvent: '{"taskId":"watch-command","output":"CI passed"}',
    });
    assert.equal((yield* inspect).wakes.length, 0);
    yield* runtime.sendTurn({ input: "resume" });
    yield* until("turn/completed");
    yield* until("turn/completed");
    assert.deepStrictEqual((yield* inspect).wakes, [
      { name: "background_monitor", output: '{"taskId":"watch-command","output":"CI passed"}' },
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);

for (const scenario of ["reject-resume", "timeout-resume"]) {
  it.effect(`keeps wakes suppressed after ${scenario} until a successful user turn`, () =>
    Effect.gen(function* () {
      const { runtime, until, inspect, subscribe } = yield* setup();
      yield* runtime.sendTurn({ input: "reject-wake" });
      yield* until("turn/completed");
      yield* subscribe;
      yield* runtime.compactThread;
      yield* until("backgroundMonitor/wakeFailed");
      const sending = yield* runtime
        .sendTurn({ input: scenario })
        .pipe(Effect.result, Effect.forkChild);
      if (scenario === "timeout-resume") {
        yield* until("thread/name/updated");
        yield* TestClock.adjust("10 seconds");
      }
      assert.equal((yield* Fiber.join(sending))._tag, "Failure");
      assert.equal((yield* subscribe.pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* inspect).wakes.length, 0);
      yield* runtime.sendTurn({ input: "resume" });
      yield* until("turn/completed");
      yield* until("turn/completed");
      assert.deepStrictEqual((yield* inspect).wakes, [
        { name: "background_monitor", output: '{"taskId":"watch-command","output":"CI passed"}' },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer)),
    ),
  );
}

it.effect("preserves timed-out wake evidence without retrying an ambiguous delivery", () =>
  Effect.gen(function* () {
    const { runtime, until, inspect, subscribe } = yield* setup();
    yield* runtime.sendTurn({ input: "timeout-wake" });
    yield* until("turn/completed");
    yield* subscribe;
    yield* runtime.compactThread;
    // The fixture emits one barrier for compact and one for the stalled wake.
    yield* until("thread/name/updated");
    yield* until("thread/name/updated");
    yield* TestClock.adjust("10 seconds");
    const failed = yield* until("backgroundMonitor/wakeFailed");
    assert.deepStrictEqual(failed.payload, {
      monitorEvent: '{"taskId":"watch-command","output":"CI passed"}',
    });
    yield* runtime.sendTurn({ input: "resume" });
    yield* until("turn/completed");
    assert.equal((yield* inspect).wakes.length, 0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, MonitorSession.layer))),
);
