import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as MilestoneHub from "./MilestoneHub.ts";
import * as OrchestrationMilestones from "./OrchestrationMilestones.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for milestones"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = OrchestrationMilestones.layer.pipe(
  Layer.provideMerge(MilestoneHub.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(
        Layer.provide(NodeCrypto.layerDigest),
        Layer.provide(layerDatabase),
      ),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "milestones" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

it.effect("tells each thread transition once, with its lineage", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const feeder = yield* OrchestrationMilestones.OrchestrationMilestones;
    const hub = yield* MilestoneHub.MilestoneHub;
    const parentThreadId = ThreadId.make("thread:milestone-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-milestone-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:milestones"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-milestone-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:milestone-parent"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-milestone-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childThreadId = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!
      .childThreadId!;
    const childRun = (yield* projections.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
    // A workflow run's agent step, which a filter on its run picks out.
    const stepThreadId = ThreadId.make("thread:milestone-workflow-step");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-milestone-step"),
      threadId: stepThreadId,
      projectId: ProjectId.make("project:milestones"),
      title: "Triage",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
      workflowRun: {
        environmentId: EnvironmentId.make("environment:milestones"),
        runId: "workflow-run:milestones",
        workflow: "review",
        step: "triage",
      },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-milestone-step"),
      threadId: stepThreadId,
      messageId: MessageId.make("message:milestone-step"),
      text: "Triage the issue",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    const stepRun = (yield* projections.getThreadRecords(stepThreadId, ["runs"])).runs[0]!;
    const parent = yield* projections.getThread(parentThreadId);
    const now = yield* DateTime.now;
    const base = (id: string, threadId: ThreadId) => ({
      id: EventId.make(id),
      threadId,
      occurredAt: now,
    });
    const ended = (id: string, run: OrchestrationV2Run, status: OrchestrationV2Run["status"]) =>
      ({
        ...base(id, run.threadId),
        type: "run.updated",
        runId: run.id,
        payload: { ...run, status, startedAt: now, completedAt: now },
      }) satisfies OrchestrationV2DomainEvent;
    const request = (id: string, status: "pending" | "resolved") =>
      ({
        ...base(id, parentThreadId),
        type: "runtime-request.updated",
        payload: {
          id: RuntimeRequestId.make("request:milestone"),
          nodeId: parentRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status,
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: status === "pending" ? null : now,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const shareId = GuestShareId.make("share:milestone");
    const guestMessage = (id: string, status: ThreadGuestMessage["status"]) => ({
      id: GuestMessageId.make(id),
      text: "Can you also check the docs?",
      status,
      submittedAt: DateTime.formatIso(now),
    });
    const shared = (
      id: string,
      messages: ReadonlyArray<ThreadGuestMessage> | null,
    ): OrchestrationV2DomainEvent => {
      const payload: OrchestrationV2AppThread = {
        ...parent,
        guestShare:
          messages === null
            ? null
            : {
                id: shareId,
                host: "tunnel.example",
                createdAt: DateTime.formatIso(now),
                expiresAt: DateTime.formatIso(now),
                guestName: "Sam",
                messages,
              },
      };
      return { ...base(id, parentThreadId), type: "thread.guest-share-updated", payload };
    };
    const wake = {
      ...base("event:wake", parentThreadId),
      type: "message.updated",
      payload: {
        id: MessageId.make("message:pr-wake"),
        threadId: parentThreadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Checks finished on #7.",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "system",
        creationSource: "server",
        notification: {
          source: {
            kind: "monitor",
            pullRequest: {
              host: "github.com",
              repository: "me/app",
              number: 7,
              watchStartedAt: DateTime.formatIso(now),
              headSha: "abc",
              watchEnded: true,
            },
          },
          outcome: "completed",
          summary: "#7: checks passed",
        },
      },
    } satisfies OrchestrationV2DomainEvent;

    for (const event of [
      ended("event:parent-done", parentRun, "completed"),
      // A later update of a settled run is not a second settlement.
      ended("event:parent-done-again", parentRun, "completed"),
      ended("event:child-failed", childRun, "failed"),
      request("event:asked", "pending"),
      request("event:answered", "resolved"),
      shared("event:guest-asked", [guestMessage("guest:one", "pending")]),
      shared("event:guest-sent", [guestMessage("guest:one", "sent")]),
      shared("event:guest-asked-again", [
        guestMessage("guest:one", "sent"),
        guestMessage("guest:two", "pending"),
      ]),
      shared("event:guest-closed", null),
      wake,
      wake,
      ended("event:step-done", stepRun, "completed"),
    ]) {
      yield* feeder.handle(event);
    }

    const { events } = yield* hub.recent({ filter: { includeSubagentChildren: true } });
    assert.deepStrictEqual(
      events.map((event) => [
        event.id,
        event.threadId,
        event.parentThreadId,
        event.isSubagentChild,
      ]),
      [
        [`thread.run_settled:${parentRun.id}`, parentThreadId, null, false],
        [`thread.run_settled:${childRun.id}`, childThreadId, parentThreadId, true],
        ["thread.needs_input:request:milestone", parentThreadId, null, false],
        ["thread.input_resolved:request:milestone", parentThreadId, null, false],
        ["thread.guest_request:guest:one", parentThreadId, null, false],
        ["thread.guest_request_resolved:guest:one", parentThreadId, null, false],
        ["thread.guest_request:guest:two", parentThreadId, null, false],
        ["thread.guest_request_resolved:guest:two", parentThreadId, null, false],
        ["pr.watch_wake:message:pr-wake", parentThreadId, null, false],
        [`thread.run_settled:${stepRun.id}`, stepThreadId, null, false],
      ],
    );
    assert.deepStrictEqual(
      (yield* hub.recent({ filter: { workflowRunIds: ["workflow-run:milestones"] } })).events.map(
        (event) => event.threadId,
      ),
      [stepThreadId],
    );
    const [, child, asked, answered, , sent, , closed, woke] = events;
    assert.deepInclude(child, { outcome: "failed", projectId: parent.projectId });
    assert.deepInclude(asked, { kind: "approval" });
    assert.deepInclude(answered, { resolution: "resolved", actor: { type: "user" } });
    assert.deepInclude(sent, { resolution: "sent" });
    assert.deepInclude(closed, { resolution: "closed" });
    assert.deepInclude(woke, {
      pullRequests: [{ host: "github.com", repository: "me/app", number: 7 }],
      watchEnded: true,
      summary: "#7: checks passed",
    });
    // A subscriber that did not ask for children never hears of the child's run.
    assert.notInclude(
      (yield* hub.recent()).events.map((event) => event.threadId),
      childThreadId,
    );
  }).pipe(Effect.provide(layerTest)),
);
