/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

/** Append-only sidecars the mock peer writes so tests can assert what the
 * runtime actually put on the wire. */
const SIDECARS = ["starts", "steers", "interrupts"] as const;

function readSidecar(path: string): ReadonlyArray<unknown> {
  if (!NodeFS.existsSync(path)) {
    return [];
  }
  const raw = NodeFS.readFileSync(path, "utf8").trim();
  return raw.length === 0 ? [] : raw.split("\n").map((line) => JSON.parse(line) as unknown);
}

/** Writes the script, clears stale sidecars, and registers cleanup. */
const useScript = Effect.fnUntraced(function* (script: unknown) {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
  const paths = Object.fromEntries(
    SIDECARS.map((name) => [name, `${scriptPath}.${name}`]),
  ) as Record<(typeof SIDECARS)[number], string>;
  for (const path of Object.values(paths)) {
    NodeFS.rmSync(path, { force: true });
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      NodeFS.rmSync(scriptPath, { force: true });
      for (const path of Object.values(paths)) {
        NodeFS.rmSync(path, { force: true });
      }
    }),
  );
  return paths;
});

describe("CodexSessionRuntime collab integration", () => {
  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [turnStartedA, registrationA, registrationB, turnStartedB],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("folds a mid-turn send into the running turn and keeps Stop pointed at it", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        // A single scripted turn id: a second turn/start would answer with the
        // fixture's own id, so the assertions below catch a regression to
        // queueing a follow-up turn.
        turnIds: [activeTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      const steersPath = `${scriptPath}.steers`;
      NodeFS.rmSync(interruptsPath, { force: true });
      NodeFS.rmSync(steersPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
          NodeFS.rmSync(steersPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      const started = yield* runtime.sendTurn({ input: "keep working" });
      const steered = yield* runtime.sendTurn({ input: "follow-up while running" });
      yield* runtime.interruptTurn();

      assert.equal(started.turnId, activeTurnId);
      // The follow-up steers the turn that is already running rather than
      // queueing a second one, so it reports the same turn id back.
      assert.equal(steered.turnId, activeTurnId);
      const steers = NodeFS.readFileSync(steersPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      assert.deepEqual(steers, [
        {
          threadId: ROOT,
          expectedTurnId: activeTurnId,
          input: [{ type: "text", text: "follow-up while running" }],
        },
      ]);

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a message typed after Stop until terminal lifecycle arrives", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [activeTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-stop-then-type"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.interruptTurn();
      const afterStop = yield* runtime
        .sendTurn({ input: "actually, do this instead" })
        .pipe(Effect.flip);

      assert.equal(afterStop._tag, "CodexSessionRuntimeTurnSteerRejectedError");
      if (afterStop._tag !== "CodexSessionRuntimeTurnSteerRejectedError") {
        return;
      }
      assert.equal(afterStop.reason, "turn-interrupting");
      assert.equal(afterStop.retryable, true);
      assert.deepEqual(readSidecar(paths.steers), []);
      assert.deepEqual(
        readSidecar(paths.starts).map((entry) => (entry as { input?: unknown }).input),
        [[{ type: "text", text: "keep working" }]],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rolls back interrupting when the parent interrupt RPC fails", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [activeTurnId],
        failInterruptFor: ROOT,
        notifications: [],
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-interrupt-rollback"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.interruptTurn().pipe(Effect.flip);
      const afterFailure = yield* runtime.sendTurn({ input: "still add this" });

      assert.equal(afterFailure.steered, true);
      assert.equal(afterFailure.turnId, activeTurnId);
      assert.deepEqual(
        readSidecar(paths.starts).map((entry) => (entry as { turnId?: string }).turnId),
        [activeTurnId],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not start a phantom turn when a no-active refusal outruns lifecycle", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const nextTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [activeTurnId, nextTurnId],
        notifications: [],
        // The turn ended just before the steer landed. Quoted verbatim from
        // a captured transcript (codex-cli 0.147.0): a bare `-32600` with no
        // `data` and no structured error info to key on.
        steerRejection: {
          code: -32600,
          message: "no active turn to steer",
        },
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-steer-race"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      const raced = yield* runtime.sendTurn({ input: "one more thing" }).pipe(Effect.flip);

      assert.equal(raced._tag, "CodexSessionRuntimeTurnSteerRejectedError");
      assert.equal(readSidecar(paths.steers).length, 1);
      assert.deepEqual(
        readSidecar(paths.starts).map((entry) => (entry as { input?: unknown }).input),
        [[{ type: "text", text: "keep working" }]],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serializes concurrent sends so an end-of-turn race starts exactly one fallback", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const fallbackTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [activeTurnId, fallbackTurnId],
        endTurnBeforeFirstSteer: true,
        deferStaleSteerResponses: true,
        notifications: [],
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-concurrent-steer-race"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      const results = yield* Effect.all(
        [
          runtime.sendTurn({ input: "first follow-up" }),
          runtime.sendTurn({ input: "second follow-up" }),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(
        readSidecar(paths.starts).map((entry) => (entry as { turnId?: string }).turnId),
        [activeTurnId, fallbackTurnId],
      );
      assert.equal(
        results.filter((result) => result.steered === false).length,
        1,
        "only one concurrent send may own the stale-steer fallback",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reconciles rather than starting when a steer reports another active turn", () =>
    Effect.gen(function* () {
      const responseTurnId = "019fe4ff-f18b-76f2-b132-c93f3a6c5bfb";
      const notifiedTurnId = "019fe4ff-f223-7401-8ef3-930a168477a8";
      const nextTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [responseTurnId, nextTurnId],
        turnStartedBeforeResponse: true,
        startedTurnIdOverride: notifiedTurnId,
        notifications: [],
        // Captured `/review` behaviour: the notification publishes one id
        // while the server accepts only the response id. This refusal proves
        // the found id is still active, so the runtime must reconcile it and
        // must not fall back to a mid-turn turn/start. Verbatim from
        // review-steer.attempt-2.jsonl.
        steerRejection: {
          code: -32600,
          message: `expected active turn id \`${notifiedTurnId}\` but found \`${responseTurnId}\``,
        },
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-review-split"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      const rejected = yield* runtime.sendTurn({ input: "and also this" }).pipe(Effect.flip);

      assert.equal(rejected._tag, "CodexSessionRuntimeTurnSteerRejectedError");
      assert.equal(readSidecar(paths.steers).length, 1);
      assert.deepEqual(
        readSidecar(paths.starts).map((entry) => (entry as { input?: unknown }).input),
        [[{ type: "text", text: "keep working" }]],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("tracks the start response's turn id when turn/started names another", () =>
    Effect.gen(function* () {
      const responseTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const notifiedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        turnIds: [responseTurnId],
        // `turn/started` wins the race and publishes a different id. A
        // captured `/review` shows exactly this split, with the server
        // accepting only the id it returned in the response.
        turnStartedBeforeResponse: true,
        startedTurnIdOverride: notifiedTurnId,
        expectedActiveTurnId: responseTurnId,
        notifications: [],
      };
      const paths = yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-started-race"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      const started = yield* runtime.sendTurn({ input: "keep working" });
      const steered = yield* runtime.sendTurn({ input: "and also this" });
      yield* runtime.interruptTurn();

      assert.equal(started.turnId, responseTurnId);
      // Both the follow-up steer and Stop address the id the server accepts.
      assert.equal(steered.steered, true);
      assert.deepEqual(
        readSidecar(paths.steers).map(
          (entry) => (entry as { expectedTurnId?: string }).expectedTurnId,
        ),
        [responseTurnId],
      );
      assert.deepEqual(readSidecar(paths.interrupts).at(-1), {
        threadId: ROOT,
        turnId: responseTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("projects one authoritative lifecycle when turn/started names a split review id", () =>
    Effect.gen(function* () {
      const responseTurnId = "019fe4ff-f18b-76f2-b132-c93f3a6c5bfb";
      const notifiedTurnId = "019fe4ff-f223-7401-8ef3-930a168477a8";
      const script = {
        rootThreadId: ROOT,
        turnIds: [responseTurnId],
        turnStartedBeforeResponse: true,
        startedTurnIdOverride: notifiedTurnId,
        notifications: [],
      };
      yield* useScript(script);

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-review-projection"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "review this" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "turn/started");
      const completed = events.find((event) => event.method === "turn/completed");

      assert.equal(started?.turnId, responseTurnId);
      assert.equal(
        (started?.payload as { turn?: { id?: string } } | undefined)?.turn?.id,
        responseTurnId,
      );
      assert.equal(completed?.turnId, responseTurnId);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
