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
const MEMORY = "memory-consolidation-thread";

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

  it.effect("registers spawnAgent receiver threads without v2 metadata", () =>
    Effect.gen(function* () {
      const childTraffic = wireFixture.notifications.filter((entry) => {
        const params = entry.params as {
          readonly threadId?: unknown;
          readonly thread?: { readonly id?: unknown };
        };
        const threadId =
          typeof params.threadId === "string"
            ? params.threadId
            : typeof params.thread?.id === "string"
              ? params.thread.id
              : undefined;
        return threadId === CHILD_A || threadId === CHILD_B;
      });
      const childTrafficWithoutRegistration = childTraffic.filter((entry) => {
        const item = (entry.params as { readonly item?: { readonly type?: unknown } }).item;
        return item?.type !== "subAgentActivity";
      });
      const rootThreadStarted = wireFixture.notifications.find(
        (entry) => entry.method === "thread/started",
      );
      assert.isDefined(rootThreadStarted);
      const childThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: CHILD_A,
            sessionId: CHILD_A,
            parentThreadId: ROOT,
            source: {
              subAgent: {
                thread_spawn: {
                  agent_path: "/root/alpha",
                  agent_nickname: "alpha",
                  agent_role: "reviewer",
                  depth: 1,
                  parent_thread_id: ROOT,
                },
              },
            },
            agentNickname: "alpha",
            agentRole: "reviewer",
          },
        },
      };
      const spawn = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: "root-spawn-turn",
          completedAtMs: 1785898349265,
          item: {
            type: "collabAgentToolCall",
            id: "call_live_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A, CHILD_B],
            agentsStates: {
              [CHILD_A]: { message: null, status: "running" },
              [CHILD_B]: { message: null, status: "running" },
            },
            model: "gpt-5.6-luna",
            reasoningEffort: "max",
            prompt: "Audit this work in parallel",
          },
        },
      };

      const childBCompleted = {
        method: "turn/completed",
        params: {
          threadId: CHILD_B,
          turn: {
            id: "019fcfd6-2f29-79e3-aa6a-c5836a519d3f",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: 1785898348,
            completedAt: 1785898350,
            durationMs: 3792,
          },
        },
      };

      // The child traffic is real captured lifecycle data, but this script
      // deliberately omits thread_spawn and subAgentActivity registration.
      // The spawnAgent item is the only identity signal.
      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          rootThreadId: ROOT,
          notifications: [
            spawn,
            childThreadStarted,
            ...childTrafficWithoutRegistration,
            childBCompleted,
          ],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-spawn-item"),
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
      yield* runtime.sendTurn({ input: "fan out from a spawn item" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedChildIds = new Set(
        events
          .filter((event) => event.method === "collabAgent/started")
          .map((event) => (event.payload as { agentThreadId?: string }).agentThreadId)
          .filter((agentThreadId): agentThreadId is string => agentThreadId !== undefined),
      );
      assert.deepEqual(startedChildIds, new Set([CHILD_A, CHILD_B]));
      assert.equal(events.filter((event) => event.method === "collabAgent/started").length, 2);
      assert.isAtLeast(
        events.filter((event) => event.method === "collabAgent/turnStarted").length,
        2,
      );
      assert.isAtLeast(
        events.filter((event) => event.method === "collabAgent/turnCompleted").length,
        2,
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not register failed spawnAgent attempts", () =>
    Effect.gen(function* () {
      const childTraffic = wireFixture.notifications.filter((entry) => {
        const params = entry.params as { readonly threadId?: unknown };
        return params.threadId === CHILD_B;
      });
      const childTrafficWithoutRegistration = childTraffic.filter((entry) => {
        const item = (entry.params as { readonly item?: { readonly type?: unknown } }).item;
        return item?.type !== "subAgentActivity";
      });
      const failedSpawn = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: "root-failed-spawn-turn",
          completedAtMs: 1785898349265,
          item: {
            type: "collabAgentToolCall",
            id: "call_failed_spawn",
            tool: "spawnAgent",
            status: "failed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A],
            agentsStates: {
              [CHILD_A]: { message: "spawn failed", status: "errored" },
            },
            prompt: "Audit this work",
          },
        },
      };
      const partiallyFailedSpawn = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: "root-partial-spawn-turn",
          completedAtMs: 1785898349266,
          item: {
            type: "collabAgentToolCall",
            id: "call_partial_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A, CHILD_B],
            agentsStates: {
              [CHILD_A]: { message: "agent failed", status: "errored" },
              [CHILD_B]: { message: null, status: "running" },
            },
            prompt: "Audit this work in parallel",
          },
        },
      };
      const childBCompleted = {
        method: "turn/completed",
        params: {
          threadId: CHILD_B,
          turn: {
            id: "019fcfd6-2f29-79e3-aa6a-c5836a519d3f",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: 1785898348,
            completedAt: 1785898350,
            durationMs: 3792,
          },
        },
      };

      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          rootThreadId: ROOT,
          notifications: [
            failedSpawn,
            partiallyFailedSpawn,
            ...childTrafficWithoutRegistration,
            childBCompleted,
          ],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-failed-spawn"),
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
      yield* runtime.sendTurn({ input: "handle failed spawns" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedChildIds = events
        .filter((event) => event.method === "collabAgent/started")
        .map((event) => (event.payload as { agentThreadId?: string }).agentThreadId)
        .filter((agentThreadId): agentThreadId is string => agentThreadId !== undefined);
      assert.deepEqual(startedChildIds, [CHILD_B]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stamps nested spawns with the current parent turn", () =>
    Effect.gen(function* () {
      const firstTurnId = "root-parent-turn-1";
      const secondTurnId = "root-parent-turn-2";
      const receiverBookkeeping = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: firstTurnId,
          completedAtMs: 1785898349265,
          item: {
            type: "collabAgentToolCall",
            id: "call_receiver_bookkeeping",
            tool: "wait",
            status: "completed",
            senderThreadId: ROOT,
            receiverThreadIds: [CHILD_A],
            agentsStates: {},
          },
        },
      };
      const nestedSpawn = {
        method: "item/completed",
        params: {
          threadId: ROOT,
          turnId: secondTurnId,
          completedAtMs: 1785898349266,
          item: {
            type: "collabAgentToolCall",
            id: "call_nested_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: CHILD_A,
            receiverThreadIds: [CHILD_B],
            agentsStates: {
              [CHILD_B]: { message: null, status: "running" },
            },
            prompt: "Inspect this nested task",
          },
        },
      };

      NodeFS.writeFileSync(
        scriptPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          rootThreadId: ROOT,
          turnIds: [firstTurnId, secondTurnId],
          notificationsByTurn: [[receiverBookkeeping], [nestedSpawn]],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-nested-spawn"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const firstEventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.method === "turn/completed" && event.turnId === firstTurnId,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "record the first parent turn" });
      yield* Fiber.join(firstEventsFiber);

      const secondEventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.method === "turn/completed" && event.turnId === secondTurnId,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.sendTurn({ input: "spawn from the nested agent" });

      const secondEvents = Array.from(yield* Fiber.join(secondEventsFiber));
      const started = secondEvents.find(
        (event) =>
          event.method === "collabAgent/started" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(started);
      assert.equal(started.turnId, secondTurnId);

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
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
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
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
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
});
