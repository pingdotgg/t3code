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
import {
  type ProviderApprovalDecision,
  type ProviderEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
const GLM_PROFILE = {
  modelProvider: "openrouter",
  model: "z-ai/glm-5.3-flash",
  reasoningEffort: "max",
} as const;
const GLM_CHILD_PROFILE = {
  modelProvider: GLM_PROFILE.modelProvider,
  model: GLM_PROFILE.model,
  reasoningEfforts: ["high", "max"],
} as const;
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

function capturedStartedActivity(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => {
    const item = (entry.params as { item?: { type?: string; kind?: string } }).item;
    return item?.type === "subAgentActivity" && item.kind === "started";
  });
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      item: {
        ...captured.params.item,
        agentThreadId: childId,
        agentPath: "/root/model-check",
      },
    },
  };
}

function capturedSpawnedThread(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started");
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: childId,
        sessionId: childId,
        parentThreadId: ROOT,
        agentNickname: "model-check",
        agentRole: "verifier",
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "model-check",
              agent_path: "/root/model-check",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: ROOT,
            },
          },
        },
      },
    },
  };
}

function capturedTurnStarted(childId = CHILD_A) {
  const captured = wireFixture.notifications.find(
    (entry) =>
      entry.method === "turn/started" &&
      (entry.params as { threadId?: string }).threadId === CHILD_A,
  );
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      threadId: childId,
      turn: {
        ...captured.params.turn,
        id: `${childId}-turn-profile-proof`,
      },
    },
  };
}

function childSettings(
  threadId: string,
  model: string,
  effort: string,
  modelProvider: string | null = "openai",
) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default", settings: { model } },
        cwd: "/workspace/repo",
        effort,
        model,
        ...(modelProvider ? { modelProvider } : {}),
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  };
}

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

function readRecordedArchives() {
  const archivePath = `${scriptPath}.archives`;
  if (!NodeFS.existsSync(archivePath)) return [];
  return NodeFS.readFileSync(archivePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { threadId: string });
}

function readRecordedSidecar<T>(suffix: string): ReadonlyArray<T> {
  const sidecarPath = `${scriptPath}.${suffix}`;
  if (!NodeFS.existsSync(sidecarPath)) return [];
  return NodeFS.readFileSync(sidecarPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

describe("CodexSessionRuntime collab integration", () => {
  it.effect("looks up child model metadata once after activity registration", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        recordArchives: true,
        recordRequests: true,
        rootProfile: {
          modelProvider: "openrouter",
          model: "z-ai/glm-5.3-flash",
          reasoningEffort: "max",
        },
        notifications: [
          capturedStartedActivity(),
          capturedStartedActivity(),
          {
            ...capturedStartedActivity(CHILD_B),
            params: {
              ...capturedStartedActivity(CHILD_B).params,
              item: { ...capturedStartedActivity(CHILD_B).params.item, kind: "interacted" },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_B } },
          capturedSpawnedThread(ROOT),
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            modelProvider: "openrouter",
            model: "z-ai/glm-5.3-flash",
            reasoningEffort: "max",
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-activity"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: "z-ai/glm-5.3-flash",
        expectedProfile: {
          modelProvider: "openrouter",
          model: "z-ai/glm-5.3-flash",
          reasoningEffort: "max",
        },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const metadataFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/metadataUpdated" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      const session = yield* runtime.start();
      assert.equal(session.model, "z-ai/glm-5.3-flash");
      yield* runtime.sendTurn({ input: "start one child" });
      const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
      assert.deepInclude(metadataEvents[0]?.payload, {
        agentThreadId: CHILD_A,
        modelProvider: "openrouter",
        model: "z-ai/glm-5.3-flash",
        effort: "max",
      });
      assert.equal(metadataEvents[0]?.providerInstanceId, "codex_glm53");
      assert.deepEqual(readRecordedRequests(), [
        {
          method: "thread/resume",
          params: { threadId: CHILD_A, excludeTurns: true },
        },
      ]);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps child settings and reroutes newer than the resume snapshot", () =>
    Effect.gen(function* () {
      const statusChanged = wireFixture.notifications.find(
        (entry) =>
          entry.method === "thread/status/changed" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(statusChanged);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          childSettings(CHILD_A, "child-before", "medium"),
          capturedSpawnedThread(),
          childSettings(CHILD_A, "child-after", "high"),
          {
            method: "model/rerouted",
            params: {
              threadId: CHILD_A,
              turnId: `${CHILD_A}-turn`,
              fromModel: "child-after",
              toModel: "child-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: ROOT,
              turnId: `${ROOT}-turn`,
              fromModel: "gpt-5.6-sol",
              toModel: "root-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            model: "stale-snapshot",
            reasoningEffort: "low",
            notifications: [statusChanged],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-spawn"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.method === "collabAgent/statusChanged" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one spawned child" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.deepInclude(started?.payload, {
        agentThreadId: CHILD_A,
        model: "child-before",
        effort: "medium",
      });
      const childStatus = events.find((event) => event.method === "collabAgent/statusChanged");
      assert.deepInclude(childStatus?.payload, {
        agentThreadId: CHILD_A,
        model: "child-rerouted",
        effort: "high",
      });
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "model/rerouted" &&
            (event.payload as { threadId?: string }).threadId === ROOT,
        ),
        "the root reroute must stay on the parent path",
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === "thread/settings/updated" || event.method === "model/rerouted") &&
            (event.payload as { threadId?: string }).threadId === CHILD_A,
        ),
        "child metadata notifications must not leak to the parent path",
      );
      assert.equal(readRecordedRequests().length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the parent closed when Codex reports a different effective profile", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        notifications: [],
        rootProfile: {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-parent-profile-mismatch"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const result = yield* runtime.start().pipe(Effect.result);
      if (result._tag !== "Failure") {
        assert.fail("the mismatched parent profile must fail before the session becomes ready");
      }
      assert.equal(result.failure._tag, "CodexSessionRuntimeProfileMismatchError");
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("verifies High and Max from authoritative parent turn readback", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        rootProfile: GLM_PROFILE,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-parent-high-max"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: { ...GLM_PROFILE, reasoningEffort: "high" },
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "high turn", effort: "high" });
      yield* runtime.sendTurn({ input: "max turn", effort: "max" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const [name, firstAttempt] of [
    ["transient error", { error: "profile readback temporarily unavailable" }],
    ["malformed response", { malformed: true }],
    ["timed-out response", { hang: true }],
  ] as const) {
    it.live(
      `retries a ${name} while proving the parent turn profile`,
      () =>
        Effect.gen(function* () {
          const script = {
            rootThreadId: ROOT,
            rootProfile: GLM_PROFILE,
            recordRootReadbacks: true,
            rootTurnReadbackAttempts: [[firstAttempt, {}]],
            notifications: [],
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.root-readbacks`, { force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(scriptPath, { force: true });
              NodeFS.rmSync(`${scriptPath}.root-readbacks`, { force: true });
            }),
          );

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-glm-parent-${name.replaceAll(" ", "-")}`),
            providerInstanceId: ProviderInstanceId.make("codex_glm53"),
            binaryPath: peerPath,
            cwd: "/tmp",
            runtimeMode: "full-access",
            model: GLM_PROFILE.model,
            expectedProfile: GLM_PROFILE,
            expectedChildProfile: GLM_CHILD_PROFILE,
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });

          yield* runtime.start();
          yield* runtime.sendTurn({ input: `recover from ${name}`, effort: "max" });
          assert.lengthOf(
            readRecordedSidecar<{ turnIndex: number; resumeAttempt: number }>("root-readbacks"),
            2,
          );
          yield* runtime.sendTurn({ input: `continue after ${name}`, effort: "max" });
          assert.lengthOf(
            readRecordedSidecar<{ turnIndex: number; resumeAttempt: number }>("root-readbacks"),
            3,
          );
          yield* runtime.close;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 10_000 },
    );
  }

  it.live(
    "fails the parent closed after the bounded profile proof window expires",
    () =>
      Effect.gen(function* () {
        const script = {
          rootThreadId: ROOT,
          rootProfile: GLM_PROFILE,
          recordRootReadbacks: true,
          rootTurnReadbackAttempts: [[{ hang: true }, { hang: true }, { hang: true }]],
          notifications: [],
        };
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(`${scriptPath}.root-readbacks`, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(`${scriptPath}.root-readbacks`, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-glm-parent-proof-timeout"),
          providerInstanceId: ProviderInstanceId.make("codex_glm53"),
          binaryPath: peerPath,
          cwd: "/tmp",
          runtimeMode: "full-access",
          model: GLM_PROFILE.model,
          expectedProfile: GLM_PROFILE,
          expectedChildProfile: GLM_CHILD_PROFILE,
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });

        yield* runtime.start();
        const result = yield* runtime
          .sendTurn({ input: "must not hang without parent proof", effort: "max" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CodexSessionRuntimeProfileProofError");
          if (result.failure._tag === "CodexSessionRuntimeProfileProofError") {
            assert.equal(result.failure.operation, "thread/resume");
            assert.match(result.failure.causeTag, /Timeout/);
            assert.ok(result.failure.cause);
          }
        }
        assert.lengthOf(
          readRecordedSidecar<{ turnIndex: number; resumeAttempt: number }>("root-readbacks"),
          3,
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 10_000 },
  );

  it.effect("returns a typed proof error for persistently malformed parent readback", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        rootProfile: GLM_PROFILE,
        rootTurnReadbackAttempts: [[{ malformed: true }, { malformed: true }, { malformed: true }]],
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-parent-proof-malformed"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      const result = yield* runtime
        .sendTurn({ input: "reject malformed proof", effort: "max" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "CodexSessionRuntimeProfileProofError");
        if (result.failure._tag === "CodexSessionRuntimeProfileProofError") {
          assert.equal(result.failure.operation, "thread/resume");
          assert.equal(result.failure.causeTag, "SchemaError");
          assert.ok(result.failure.cause);
        }
      }
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const [name, readback] of [
    ["missing", { ...GLM_PROFILE, omitReasoningEffort: true }],
    ["wrong", { ...GLM_PROFILE, reasoningEffort: "medium" }],
  ] as const) {
    it.effect(`fails a parent turn with ${name} authoritative effort`, () =>
      Effect.gen(function* () {
        const script = {
          rootThreadId: ROOT,
          rootProfile: GLM_PROFILE,
          rootTurnReadbacks: [readback],
          notifications: [],
        };
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make(`thread-glm-parent-${name}-effort`),
          providerInstanceId: ProviderInstanceId.make("codex_glm53"),
          binaryPath: peerPath,
          cwd: "/tmp",
          runtimeMode: "full-access",
          model: GLM_PROFILE.model,
          expectedProfile: { ...GLM_PROFILE, reasoningEffort: "high" },
          expectedChildProfile: GLM_CHILD_PROFILE,
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });

        yield* runtime.start();
        const result = yield* runtime
          .sendTurn({ input: "must verify high", effort: "high" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "CodexSessionRuntimeProfileMismatchError");
        }
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("fails and archives only a child with the wrong provider", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        rootProfile: GLM_PROFILE,
        recordArchives: true,
        notifications: [capturedStartedActivity()],
        childResumeSnapshots: {
          [CHILD_A]: {
            ...GLM_PROFILE,
            modelProvider: "openai",
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-child-profile-mismatch"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const mismatchFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "collabAgent/profileMismatch"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one child" });
      const [mismatch] = Array.from(yield* Fiber.join(mismatchFiber));
      assert.ok(mismatch);
      assert.deepInclude(mismatch.payload, {
        agentThreadId: CHILD_A,
        modelProvider: "openai",
        model: "z-ai/glm-5.3-flash",
        effort: "max",
      });
      assert.match(
        (mismatch.payload as { error?: string }).error ?? "",
        /expected openrouter\/z-ai\/glm-5\.3-flash\/high\|max/,
      );
      assert.deepEqual(readRecordedArchives(), [{ threadId: CHILD_A }]);
      yield* runtime.sendTurn({ input: "parent remains live", effort: "max" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts delayed authoritative child metadata after the former one-second cutoff", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        rootProfile: GLM_PROFILE,
        notifications: [
          capturedStartedActivity(),
          childSettings(CHILD_A, GLM_PROFILE.model, "high", null),
        ],
        childResumeSnapshots: {
          [CHILD_A]: { ...GLM_PROFILE, reasoningEffort: "high", delayMs: 1_200 },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-child-settings-race"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const firstProfileEventFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/profileMismatch" ||
            event.method === "collabAgent/metadataUpdated",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one child" });
      const [firstProfileEvent] = Array.from(yield* Fiber.join(firstProfileEventFiber));
      assert.equal(
        firstProfileEvent?.method,
        "collabAgent/metadataUpdated",
        JSON.stringify(firstProfileEvent?.payload),
      );
      assert.deepInclude(firstProfileEvent?.payload, {
        agentThreadId: CHILD_A,
        modelProvider: "openrouter",
        model: GLM_PROFILE.model,
        effort: "high",
      });
      // A second turn succeeding proves the provisional notification did
      // not kill the valid app-server while thread/resume was delayed.
      yield* runtime.sendTurn({ input: "continue after profile verification" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails, interrupts, and archives only a persistently unverified native child", () =>
    Effect.gen(function* () {
      const script = {
        rootThreadId: ROOT,
        rootProfile: GLM_PROFILE,
        recordArchives: true,
        notifications: [capturedTurnStarted(), capturedStartedActivity()],
        childResumeSnapshots: { [CHILD_A]: { error: "profile unavailable" } },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
      NodeFS.rmSync(`${scriptPath}.interrupts`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.archives`, { force: true });
          NodeFS.rmSync(`${scriptPath}.interrupts`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-child-profile-unavailable"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const proofFailureFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "collabAgent/profileProofFailed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one child" });
      const [proofFailure] = Array.from(yield* Fiber.join(proofFailureFiber));
      assert.ok(proofFailure);
      assert.match(
        (proofFailure.payload as { error?: string }).error ?? "",
        /profile proof failed during thread\/resume after bounded retries/,
      );
      assert.match((proofFailure.payload as { errorTag?: string }).errorTag ?? "", /RequestError/);
      assert.deepEqual(readRecordedArchives(), [{ threadId: CHILD_A }]);
      assert.deepEqual(readRecordedSidecar<{ threadId: string; turnId: string }>("interrupts"), [
        { threadId: CHILD_A, turnId: `${CHILD_A}-turn-profile-proof` },
      ]);
      yield* runtime.sendTurn({ input: "parent remains live after child proof failure" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("emits ten inherited GLM child profiles from native v2 events", () =>
    Effect.gen(function* () {
      const childIds = Array.from({ length: 10 }, (_, index) => `glm-child-${index + 1}`);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        rootProfile: GLM_PROFILE,
        notifications: childIds.map((childId) => capturedStartedActivity(childId)),
        childResumeSnapshots: Object.fromEntries(
          childIds.map((childId, index) => [
            childId,
            {
              ...GLM_PROFILE,
              reasoningEffort: index % 2 === 0 ? "max" : "high",
              ...(index === 0 ? { transientErrors: 1 } : {}),
            },
          ]),
        ),
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-glm-ten-children"),
        providerInstanceId: ProviderInstanceId.make("codex_glm53"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        model: GLM_PROFILE.model,
        expectedProfile: GLM_PROFILE,
        expectedChildProfile: GLM_CHILD_PROFILE,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const metadataFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "collabAgent/metadataUpdated"),
        Stream.take(10),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start ten children" });
      const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
      assert.equal(metadataEvents.length, 10);
      assert.deepEqual(
        metadataEvents
          .map((event) => (event.payload as { agentThreadId: string }).agentThreadId)
          .toSorted(),
        childIds.toSorted(),
      );
      for (const event of metadataEvents) {
        const childId = (event.payload as { agentThreadId: string }).agentThreadId;
        const childNumber = Number(childId.slice("glm-child-".length));
        assert.equal(event.providerInstanceId, "codex_glm53");
        assert.deepInclude(event.payload, {
          modelProvider: "openrouter",
          model: "z-ai/glm-5.3-flash",
          effort: childNumber % 2 === 1 ? "max" : "high",
        });
      }
      assert.equal(readRecordedRequests().length, 11);
      assert.deepEqual(readRecordedArchives(), []);
      yield* runtime.sendTurn({ input: "all verified siblings remain live", effort: "max" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not delay the parent turn when the child lookup fails", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      for (const [name, childSnapshot] of [
        ["hang", { hang: true }],
        ["error", { error: "child unavailable" }],
      ] as const) {
        yield* Effect.gen(function* () {
          const marker = `lookup-${name}`;
          const script = {
            rootThreadId: ROOT,
            recordRequests: true,
            resumeRequestMarker: marker,
            notifications: [capturedStartedActivity()],
            childResumeSnapshots: { [CHILD_A]: childSnapshot },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-collab-model-${name}`),
            binaryPath: peerPath,
            cwd: "/tmp",
            runtimeMode: "full-access",
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const eventsFiber = yield* runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.method === "serverRequest/resolved" &&
                (event.payload as { requestId?: string }).requestId === marker,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "finish without child metadata" });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.isTrue(events.some((event) => event.method === "turn/completed"));
          assert.equal(readRecordedRequests().length, 1);

          yield* runtime.close;
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }).pipe(Effect.scoped);
      }
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
