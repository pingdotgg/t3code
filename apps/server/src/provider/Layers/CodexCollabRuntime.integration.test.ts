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
const CHILD_C = "019fcfd6-1806-7de1-8564-de69fd55bff3";
const CHILD_D = "019fcfd6-1806-7de1-8564-de69fd55bff4";

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

function buildDirectChildScript() {
  const rootTurnId = "019fcfd6-1806-7de1-8564-de69fd55bffb";
  const childTurnId = `${CHILD_A}-direct-turn`;
  const childItemId = `${CHILD_A}-direct-message`;
  return {
    rootThreadId: ROOT,
    notifications: [
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "collabAgentToolCall",
            id: "call_direct_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A],
            prompt: "Return one concise result.",
            agentsStates: {
              [CHILD_A]: { status: "pendingInit", message: null },
            },
          },
          completedAtMs: 1785898350000,
        },
      },
      {
        method: "item/started",
        params: {
          threadId: CHILD_A,
          turnId: childTurnId,
          item: { type: "agentMessage", id: childItemId, text: "" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: CHILD_A,
          turnId: childTurnId,
          itemId: childItemId,
          delta: "child narration must not enter the parent transcript",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: CHILD_A,
          turnId: childTurnId,
          completedAtMs: 1785898350000,
          item: {
            type: "agentMessage",
            id: childItemId,
            phase: "final_answer",
            text: "child result is consumed by the parent model",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "agentMessage",
            id: "root-summary",
            phase: "final_answer",
            text: "The agent completed:\n- Direct Child Researcher: returned one concise result.",
          },
          completedAtMs: 1785898350000,
        },
      },
    ],
  };
}

function buildOutOfOrderNamingScript() {
  const rootTurnId = "019fcfd6-1806-7de1-8564-de69fd55bffb";
  return {
    rootThreadId: ROOT,
    notifications: [
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "collabAgentToolCall",
            id: "call_direct_spawn_ordered",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A, CHILD_B],
            prompt: "Return one concise result.",
            agentsStates: {
              [CHILD_A]: { status: "pendingInit", message: null },
              [CHILD_B]: { status: "pendingInit", message: null },
            },
          },
          completedAtMs: 1785898350000,
        },
      },
      {
        method: "item/completed",
        params: {
          // A nested spawn reports the child agent's own turn id. It must
          // still join the root fleet's naming batch.
          threadId: CHILD_A,
          turnId: `${CHILD_A}-nested-turn`,
          item: {
            type: "collabAgentToolCall",
            id: "call_nested_spawn_ordered",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: CHILD_A,
            receiverThreadIds: [CHILD_C, CHILD_D],
            prompt: "Return one concise result.",
            agentsStates: {
              [CHILD_C]: { status: "pendingInit", message: null },
              [CHILD_D]: { status: "pendingInit", message: null },
            },
          },
          completedAtMs: 1785898350000,
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "collabAgentToolCall",
            id: "call_direct_wait_reordered",
            tool: "wait",
            status: "completed",
            senderThreadId: ROOT,
            // Non-spawn calls can list receivers in any order, but they must
            // not change the original spawn positions.
            receiverThreadIds: [CHILD_D, CHILD_C],
            agentsStates: {
              [CHILD_C]: { status: "running", message: null },
              [CHILD_D]: { status: "running", message: null },
            },
          },
          completedAtMs: 1785898350000,
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "agentMessage",
            id: "root-order-summary",
            phase: "final_answer",
            text: "Agents:\n- Alpha\n- Beta\n- Gamma\n- Delta",
          },
          completedAtMs: 1785898350000,
        },
      },
    ],
  };
}

function buildUnscopedExistingChildScript() {
  const rootTurnId = "019fcfd6-1806-7de1-8564-de69fd55bffb";
  return {
    rootThreadId: ROOT,
    preTurnNotifications: [
      {
        // Establish the root identity before replaying early child traffic;
        // this models the provider's root thread notification and prevents
        // the fixture from racing the runtime's initial session setup.
        method: "thread/started",
        params: { thread: wireFixture.responses.threadStart.thread },
      },
      {
        method: "turn/started",
        params: {
          threadId: CHILD_B,
          turn: {
            id: `${CHILD_B}-pre-turn`,
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: 1785898342,
            completedAt: null,
            durationMs: null,
          },
        },
      },
    ],
    notifications: [
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "collabAgentToolCall",
            id: "call_unscoped_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A, CHILD_B],
            prompt: "Return one concise result.",
            agentsStates: {
              [CHILD_A]: { status: "pendingInit", message: null },
              [CHILD_B]: { status: "pendingInit", message: null },
            },
          },
          completedAtMs: 1785898350000,
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: rootTurnId,
          item: {
            type: "agentMessage",
            id: "root-unscoped-summary",
            phase: "final_answer",
            text: "Agents:\n- Alpha\n- Beta",
          },
          completedAtMs: 1785898350000,
        },
      },
    ],
  };
}

function buildLogicalRootItemScript() {
  const rootTurnId = "019fcfd6-1806-7de1-8564-de69fd55bffb";
  const logicalRootId = "019fcfd6-1806-7de1-8564-de69fd55bfff";
  return {
    rootThreadId: ROOT,
    notifications: [
      {
        method: "item/completed",
        params: {
          // Some provider versions address coordinator items with a logical
          // root id that differs from the thread/start response id.
          threadId: logicalRootId,
          turnId: rootTurnId,
          item: {
            type: "agentMessage",
            id: "logical-root-summary",
            phase: "final_answer",
            text: "The coordinator kept the parent timeline intact.",
          },
          completedAtMs: 1785898350000,
        },
      },
    ],
  };
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

describe("CodexSessionRuntime collab integration", () => {
  it.effect("registers receiver ids and keeps child narration out of the parent stream", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildDirectChildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-direct-child"),
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
      yield* runtime.sendTurn({ input: "direct child" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);
      assert.include(methods, "collabAgent/started");
      assert.include(methods, "collabAgent/item");
      assert.include(methods, "collabAgent/statusChanged");
      assert.include(methods, "collabAgent/renamed");
      assert.include(methods, "turn/completed");
      assert.notInclude(methods, "item/agentMessage/delta");
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.isUndefined((started?.payload as { nickname?: string } | undefined)?.nickname);
      const renamed = events.find((event) => event.method === "collabAgent/renamed");
      assert.equal(
        (renamed?.payload as { nickname?: string } | undefined)?.nickname,
        "Direct Child Researcher",
      );
      const statusChanged = events.find(
        (event) =>
          event.method === "collabAgent/statusChanged" &&
          (event.payload as { status?: { type?: string } } | undefined)?.status?.type === "idle",
      );
      assert.deepEqual((statusChanged?.payload as { status?: unknown } | undefined)?.status, {
        type: "idle",
      });

      const leakedChildEvents = events.filter((event) => {
        if (event.method === "item/agentMessage/delta") return true;
        const payload = event.payload as { threadId?: string } | undefined;
        return payload?.threadId === CHILD_A;
      });
      assert.deepEqual(
        leakedChildEvents.map((event) => event.method),
        [],
        "child notifications must not be emitted as parent-timeline events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("assigns names in global spawn order and ignores later non-spawn receiver order", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildOutOfOrderNamingScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-name-order"),
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
      yield* runtime.sendTurn({ input: "name the children" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const renamed = events.filter((event) => event.method === "collabAgent/renamed");
      assert.deepEqual(
        renamed.map((event) => {
          const payload = event.payload as { agentThreadId?: string; nickname?: string };
          return [payload.agentThreadId, payload.nickname];
        }),
        [
          [CHILD_A, "Alpha"],
          [CHILD_B, "Beta"],
          [CHILD_C, "Gamma"],
          [CHILD_D, "Delta"],
        ],
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not backfill an unscoped child into a later parent turn", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildUnscopedExistingChildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-unscoped-child"),
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
      yield* runtime.sendTurn({ input: "keep the unscoped child separate" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const childBEvents = events.filter(
        (event) =>
          (event.payload as { agentThreadId?: string } | undefined)?.agentThreadId === CHILD_B,
      );
      assert.isAbove(childBEvents.length, 0);
      assert.isTrue(
        childBEvents.every((event) => event.turnId === undefined),
        "an existing child without a spawn turn must not inherit a later turn id",
      );
      assert.notInclude(
        events.map((event) => event.method),
        "collabAgent/renamed",
        "the unscoped child must not be included in the later fleet name batch",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
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
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

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

  it.effect("keeps logical-root items on the coordinator timeline", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildLogicalRootItemScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-logical-root"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "item/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "preserve the parent item" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.include(
        events.map((event) => event.method),
        "item/completed",
      );
      assert.notInclude(
        events.map((event) => event.method),
        "collabAgent/item",
        "an unknown logical-root item must not become a child-agent event",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
