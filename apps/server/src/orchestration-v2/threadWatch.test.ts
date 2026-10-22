import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  observeThreadWatch,
  standardWebhookKey,
  standardWebhookSignature,
  threadWatchEventId,
  type ThreadWatchState,
  UNSEEN,
} from "./threadWatch.ts";

const THREAD_ID = ThreadId.make("thread");
const RUN_1 = RunId.make("run-1");
const RUN_2 = RunId.make("run-2");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "agent",
    creationSource: "mcp",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: RUN_1,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at("2026-10-20T12:00:00.000Z"),
    updatedAt: at("2026-10-20T12:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const completed = (runId = RUN_1, completedAt = "2026-10-20T12:05:00.000Z") =>
  shell({
    status: "completed",
    activityRunStatus: null,
    latestRunId: runId,
    latestRunCompletedAt: at(completedAt),
  });

function told(shells: ReadonlyArray<OrchestrationV2ThreadShell | null>) {
  let state: ThreadWatchState = UNSEEN;
  return shells.map((next) => {
    const observed = observeThreadWatch(next, state);
    state = observed.state;
    return observed.kinds.join("+") || null;
  });
}

describe("observeThreadWatch", () => {
  it("tells each completion, question, approval and failure once", () => {
    const approval = shell({
      latestRunId: RUN_2,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: "command",
        createdAt: at("2026-10-20T12:06:00.000Z"),
      },
    });
    const question = shell({
      latestRunId: RUN_2,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-2"),
        kind: "user_input",
        createdAt: at("2026-10-20T12:07:00.000Z"),
      },
    });
    assert.deepStrictEqual(
      told([
        shell(),
        completed(),
        completed(),
        approval,
        approval,
        question,
        shell({ latestRunId: RUN_2, status: "failed", activityRunStatus: null }),
        { ...completed(RUN_2, "2026-10-20T12:09:00.000Z"), settledOverride: "settled" },
        null,
      ]),
      [null, "completed", null, "approval", null, "question", "failed", "completed+ended", null],
    );
  });

  it("gives a second question in the same run its own event id", () => {
    const asking = (id: string) =>
      shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make(id),
          kind: "user_input",
          createdAt: at("2026-10-20T12:06:00.000Z"),
        },
      });
    const first = observeThreadWatch(asking("request-1"), UNSEEN);
    const answered = observeThreadWatch(shell(), first.state);
    const second = observeThreadWatch(asking("request-2"), answered.state);
    assert.deepStrictEqual(second.kinds, ["question"]);
    assert.notStrictEqual(
      threadWatchEventId("tw", "question", first.state, at("2026-10-20T12:06:00.000Z")),
      threadWatchEventId("tw", "question", second.state, at("2026-10-20T12:06:00.000Z")),
    );
  });
});

describe("Standard Webhooks signing", () => {
  it("matches the reference vector", () => {
    const key = standardWebhookKey("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
    assert.isNotNull(key);
    assert.strictEqual(
      standardWebhookSignature({
        key: key!,
        id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
        timestamp: 1614265330,
        body: '{"test": 2432232314}',
      }),
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
  });

  it("accepts only whsec_ secrets holding 24 to 64 bytes", () => {
    const encode = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");
    assert.strictEqual(standardWebhookKey(`whsec_${encode(24)}`)?.length, 24);
    assert.strictEqual(standardWebhookKey(`whsec_${encode(64)}`)?.length, 64);
    assert.isNull(standardWebhookKey(`whsec_${encode(23)}`));
    assert.isNull(standardWebhookKey(`whsec_${encode(65)}`));
    assert.isNull(standardWebhookKey(encode(32)));
    assert.isNull(standardWebhookKey("whsec_not base64!"));
  });
});
