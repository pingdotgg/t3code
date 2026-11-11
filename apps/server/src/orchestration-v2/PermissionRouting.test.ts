import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as PermissionRouting from "./PermissionRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for permission routing"),
  respondToRuntimeRequest: () => Effect.void,
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  IdAllocator.layer,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "permission-routing" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:permission-routing");
const requestId = RuntimeRequestId.make("request:permission-routing");
const nodeId = NodeId.make("node:permission-routing");
const providerSessionId = ProviderSessionId.make("session:permission-routing");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-permission-routing"),
    threadId,
    projectId: ProjectId.make("project:permission-routing"),
    title: "Permission routing",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

  return { orchestrator, eventSink, idAllocator };
});

const writePendingApproval = Effect.fn("writePendingApproval")(function* (input: {
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly whenNobody?: "wait" | "permit";
  readonly assignee?: { type: "any-operator" } | { type: "subject"; subject: string };
}) {
  const now = yield* DateTime.now;
  const stamped = PermissionRouting.stampPendingApprovalRouting({
    request: {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId,
        supportsFeedback: true,
      },
      createdAt: now,
      resolvedAt: null,
    },
    policy: {
      defaultApprover: input.assignee ?? { type: "any-operator" },
      whenNobody: input.whenNobody ?? "wait",
    },
    now,
  });
  yield* input.eventSink.write({
    events: [
      {
        id: yield* input.idAllocator.allocate.event({ threadId }),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-5.1-codex",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      },
      {
        id: yield* input.idAllocator.allocate.event({ threadId }),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: stamped,
        nodeId,
      },
    ],
  });
  return stamped;
});

it.layer(layerTest)("permission routing", (it) => {
  it.effect("stamps routing and records audited policy-nobody-permit on accept", () =>
    Effect.gen(function* () {
      const { orchestrator, eventSink, idAllocator } = yield* setup;
      const pending = yield* writePendingApproval({
        eventSink,
        idAllocator,
        whenNobody: "permit",
      });

      assert.deepEqual(pending.routing?.assignee, { type: "any-operator" });
      assert.equal(pending.routing?.whenNobody, "permit");

      const resolvedBy = PermissionRouting.resolveNobodyPermit({
        request: pending,
        sessions: [],
      });
      assert.equal(resolvedBy?.source, "policy-nobody-permit");

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("policy-permit"),
        threadId,
        requestId,
        decision: "accept",
        resolvedBy: resolvedBy!,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const resolved = projection.runtimeRequests.find((request) => request.id === requestId);
      assert.equal(resolved?.status, "resolved");
      assert.equal(resolved?.decision, "accept");
      assert.equal(resolved?.resolvedBy?.source, "policy-nobody-permit");
    }),
  );

  it.effect("consider leaves wait-policy approvals pending without EnvironmentAuth", () =>
    Effect.gen(function* () {
      const { orchestrator, eventSink, idAllocator } = yield* setup;
      yield* writePendingApproval({
        eventSink,
        idAllocator,
        assignee: { type: "subject", subject: "alice" },
        whenNobody: "wait",
      });

      yield* orchestrator.dispatch({
        type: "permission-routing.consider",
        commandId: CommandId.make("consider-wait"),
        threadId,
        requestId,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const pending = projection.runtimeRequests.find((request) => request.id === requestId);
      assert.equal(pending?.status, "pending");
      assert.equal(pending?.resolvedBy, undefined);
    }),
  );

  it.effect("records human resolvedBy on a normal approval response", () =>
    Effect.gen(function* () {
      const { orchestrator, eventSink, idAllocator } = yield* setup;
      yield* writePendingApproval({ eventSink, idAllocator });

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("human-accept"),
        threadId,
        requestId,
        decision: "accept",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const resolved = projection.runtimeRequests.find((request) => request.id === requestId);
      assert.equal(resolved?.resolvedBy?.source, "human");
    }),
  );

  it.effect("consider does not auto-permit when session state is unknown", () =>
    Effect.gen(function* () {
      const { orchestrator, eventSink, idAllocator } = yield* setup;
      yield* writePendingApproval({
        eventSink,
        idAllocator,
        whenNobody: "permit",
      });

      // Harness has no EnvironmentAuth, so sessions are null and consider must fail closed.
      yield* orchestrator.dispatch({
        type: "permission-routing.consider",
        commandId: CommandId.make("consider-unknown"),
        threadId,
        requestId,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const pending = projection.runtimeRequests.find((request) => request.id === requestId);
      assert.equal(pending?.status, "pending");
    }),
  );
});
