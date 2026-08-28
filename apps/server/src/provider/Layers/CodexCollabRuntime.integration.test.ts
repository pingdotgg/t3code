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
import { type ProviderApprovalDecision, type ProviderEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const decodeMcpElicitationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
    }),
  ),
);

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
        turnId: "root-turn-error",
        completedAtMs: 0,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [ROOT, CHILD_A, CHILD_B],
          agentsStates: {},
        },
      },
    },
    {
      method: "error",
      params: {
        threadId: ROOT,
        turnId: "root-turn-error",
        error: { message: "root error must stay visible" },
        willRetry: false,
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
      const rootError = events.find(
        (event) =>
          event.method === "error" &&
          (event.payload as { error?: { message?: string } }).error?.message ===
            "root error must stay visible",
      );
      assert.isDefined(rootError, "receiver bookkeeping must not suppress a root error");

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

  it.effect("replays only retrying pre-registration child turns after errors", () =>
    Effect.gen(function* () {
      const byIndex = wireFixture.notifications;
      const turnStartedA = byIndex.find(
        (entry) =>
          entry.method === "turn/started" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      const turnStartedB = byIndex.find(
        (entry) =>
          entry.method === "turn/started" &&
          (entry.params as { threadId?: string }).threadId === CHILD_B,
      );
      const registrationA = byIndex.find((entry) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === CHILD_A;
      });
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      const registrationB = byIndex.find((entry) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === CHILD_B;
      });
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const turnIdA = (turnStartedA.params as { turn: { id: string } }).turn.id;
      const turnIdB = (turnStartedB.params as { turn: { id: string } }).turn.id;
      const childC = "child-terminal-thread-first";
      const threadRegistrationA = {
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
                  agent_nickname: "alpha",
                  agent_path: "/root/alpha",
                  depth: 1,
                  parent_thread_id: ROOT,
                },
              },
            },
          },
        },
      };
      const turnStartedC = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: childC,
          turn: { ...turnStartedA.params.turn, id: `${childC}-turn` },
        },
      };
      const threadRegistrationC = {
        ...threadRegistrationA,
        params: {
          thread: {
            ...threadRegistrationA.params.thread,
            id: childC,
            sessionId: childC,
            source: {
              subAgent: {
                thread_spawn: {
                  agent_nickname: "gamma",
                  depth: 1,
                  parent_thread_id: ROOT,
                },
              },
            },
          },
        },
      };
      const registrationC = {
        ...registrationA,
        params: {
          ...registrationA.params,
          item: {
            ...registrationA.params.item,
            agentThreadId: childC,
            agentPath: "/root/gamma",
          },
        },
      };

      const script = {
        rootThreadId: ROOT,
        notifications: [
          turnStartedA,
          {
            method: "error",
            params: {
              threadId: CHILD_A,
              turnId: turnIdA,
              error: { message: "child failed before registration" },
              willRetry: false,
            },
          },
          registrationA,
          threadRegistrationA,
          {
            method: "thread/status/changed",
            params: { threadId: CHILD_A, status: { type: "idle" } },
          },
          {
            method: "turn/completed",
            params: {
              threadId: CHILD_A,
              turn: { id: turnIdA, status: "completed", items: [] },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_A } },
          turnStartedC,
          {
            method: "error",
            params: {
              threadId: childC,
              turnId: `${childC}-turn`,
              error: { message: "thread-first child failed before registration" },
              willRetry: false,
            },
          },
          threadRegistrationC,
          registrationC,
          turnStartedB,
          {
            method: "error",
            params: {
              threadId: CHILD_B,
              turnId: turnIdB,
              error: { message: "child will retry before registration" },
              willRetry: true,
            },
          },
          {
            ...registrationB,
            params: {
              ...registrationB.params,
              item: { ...registrationB.params.item, kind: "interacted" },
            },
          },
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-terminal-before-registration"),
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
      yield* runtime.sendTurn({ input: "error before registration" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const startedThreadIds = events
        .filter((event) => event.method === "collabAgent/turnStarted")
        .map((event) => (event.payload as { agentThreadId?: string }).agentThreadId);
      const childARegistrationEvents = events.filter(
        (event) =>
          (event.method === "collabAgent/started" || event.method === "collabAgent/activity") &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      const childAFailures = events.filter(
        (event) =>
          event.method === "collabAgent/statusChanged" &&
          (event.payload as { agentThreadId?: string; status?: { type?: string } })
            .agentThreadId === CHILD_A &&
          (event.payload as { status?: { type?: string } }).status?.type === "systemError",
      );
      const childATerminalOverrides = events.filter((event) => {
        if (!event.payload || typeof event.payload !== "object") {
          return false;
        }
        const payload = event.payload as {
          agentThreadId?: string;
          status?: { type?: string };
        };
        return (
          payload.agentThreadId === CHILD_A &&
          (event.method === "collabAgent/turnCompleted" ||
            event.method === "collabAgent/closed" ||
            (event.method === "collabAgent/statusChanged" &&
              payload.status?.type !== "systemError"))
        );
      });
      const childCFailures = events.filter(
        (event) =>
          event.method === "collabAgent/statusChanged" &&
          (event.payload as { agentThreadId?: string; status?: { type?: string } })
            .agentThreadId === childC &&
          (event.payload as { status?: { type?: string } }).status?.type === "systemError",
      );

      assert.notInclude(
        startedThreadIds,
        CHILD_A,
        "a terminal child turn must not replay as live when activity registers it later",
      );
      assert.deepEqual(
        childARegistrationEvents.map((event) => event.method),
        ["collabAgent/started"],
        "a failed child needs one start anchor, but later registration must not duplicate it",
      );
      assert.lengthOf(
        childAFailures,
        2,
        "late thread metadata must enrich the terminal state without restarting the child",
      );
      const terminalMetadataFailure = childAFailures.at(-1);
      assert.isDefined(terminalMetadataFailure);
      assert.equal(
        (terminalMetadataFailure.payload as { parentThreadId?: string }).parentThreadId,
        ROOT,
        "the terminal metadata patch must preserve parent linkage from thread registration",
      );
      assert.deepEqual(
        childATerminalOverrides.map((event) => event.method),
        [],
        "trailing lifecycle must not overwrite a terminal child error",
      );
      assert.lengthOf(
        childCFailures,
        2,
        "late activity identity must enrich a thread-first terminal child",
      );
      const childCMetadataFailure = childCFailures.at(-1);
      assert.isDefined(childCMetadataFailure);
      assert.equal(
        (childCMetadataFailure.payload as { agentPath?: string }).agentPath,
        "/root/gamma",
        "the terminal metadata patch must preserve a path learned from late activity",
      );
      assert.include(
        startedThreadIds,
        CHILD_B,
        "a retrying child turn must remain live when activity registers it later",
      );
      assert.notInclude(
        events.map((event) => event.method),
        "error",
        "pre-registration child errors must not leak onto the parent event stream",
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
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const interactedRegistrationA = {
        ...registrationA,
        params: {
          ...registrationA.params,
          item: { ...registrationA.params.item, kind: "interacted" },
        },
      };
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
          interactedRegistrationA,
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

      // Wait for both children's synthetic turnStarted signals before
      // stopping. B arrives through the registered-child path; A is replayed
      // when its later activity registration finds the pre-registration live
      // turn recorded by the foreign-notification suppressor.
      const childrenStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            [CHILD_A, CHILD_B].includes(
              (event.payload as { agentThreadId?: string }).agentThreadId ?? "",
            ),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childrenStarted = yield* Fiber.join(childrenStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childrenStarted._tag === "Some", "child turnStarted replay never arrived");
      if (childrenStarted._tag === "Some") {
        const startedThreadIds = new Set(
          Array.from(childrenStarted.value).map(
            (event) => (event.payload as { agentThreadId?: string }).agentThreadId,
          ),
        );
        assert.isTrue(startedThreadIds.has(CHILD_A), "child A start must replay on registration");
        assert.isTrue(startedThreadIds.has(CHILD_B), "child B start must flow after registration");
      }

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

  const elicitationCases = [
    {
      decision: "accept",
      response: { action: "accept", content: { approval: "once" } },
    },
    {
      decision: "acceptForSession",
      response: {
        action: "accept",
        _meta: { persist: "session" },
        content: { approval: "session" },
      },
    },
    {
      decision: "acceptAlways",
      response: {
        action: "accept",
        _meta: { persist: "always" },
        content: { approval: "always" },
      },
    },
    { decision: "decline", response: { action: "decline" } },
    { decision: "cancel", response: { action: "cancel" } },
  ] satisfies ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly response: Record<string, unknown>;
  }>;

  for (const { decision, response } of elicitationCases) {
    it.live(`returns the MCP elicitation ${decision} response to Codex`, () =>
      Effect.gen(function* () {
        const scriptedRequest = {
          id: 7001,
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            serverName: "computer-use",
            threadId: ROOT,
            turnId: wireFixture.responses.turnStart.turn.id,
            _meta: { app_name: "Safari", persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "session", "always"],
                },
              },
              required: ["approval"],
            },
          },
        };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          notifications: [],
          serverRequests: [scriptedRequest],
        };
        const responsesPath = `${scriptPath}.responses`;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(responsesPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(responsesPath, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-mcp-elicitation"),
          binaryPath: peerPath,
          cwd: "/tmp",
          runtimeMode: "auto",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approvalRequested = yield* Deferred.make<ProviderEvent>();
        const turnCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.method === "mcpServer/elicitation/request"
              ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Open Safari" });
        const approval = yield* Deferred.await(approvalRequested);
        assert.equal(approval.requestKind, "mcp-elicitation");
        assert.isDefined(approval.requestId);
        if (approval.requestId === undefined) return;

        yield* runtime.respondToRequest(approval.requestId, decision);
        yield* Deferred.await(turnCompleted);

        const recordedResponse = yield* decodeMcpElicitationResponse(
          NodeFS.readFileSync(responsesPath, "utf8"),
        );
        assert.equal(recordedResponse.id, scriptedRequest.id);
        assert.deepEqual(recordedResponse.result, response);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
