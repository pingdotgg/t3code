import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  declinePendingApprovals,
  sendApprovalFeedback,
  seedUserInputDraftAnswers,
  type ApprovalResponder,
  type ThreadPendingApproval,
} from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");

describe("declining approvals before sending", () => {
  const approval: ThreadPendingApproval = {
    requestId,
    requestKind: "command",
    createdAt: "2026-10-19T00:00:00Z",
    responseCapability: "live",
  };
  const second: ThreadPendingApproval = {
    ...approval,
    requestId: RuntimeRequestId.make("second-approval"),
  };

  it("declines every pending approval before the send continues", async () => {
    let resolve!: (value: Awaited<ReturnType<ApprovalResponder>>) => void;
    const firstResponse = new Promise<Awaited<ReturnType<ApprovalResponder>>>((done) => {
      resolve = done;
    });
    const respond = vi.fn<ApprovalResponder>(async (id) =>
      id === requestId ? firstResponse : AsyncResult.success(undefined),
    );
    const send = vi.fn();
    const submission = (async () => {
      if (await declinePendingApprovals([approval, second], respond)) send();
    })();
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
    expect(send).not.toHaveBeenCalled();
    resolve(AsyncResult.success(undefined));
    await submission;
    expect(respond).toHaveBeenCalledWith(second.requestId, "decline");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([AsyncResult.failure(Cause.fail("decline failed")), undefined])(
    "does not send when a decline is unsuccessful: %s",
    async (response) => {
      const send = vi.fn();
      if (await declinePendingApprovals([approval], async () => response)) send();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("skips approvals the provider can no longer answer", async () => {
    const respond = vi.fn(async () => AsyncResult.success(undefined));
    expect(
      await declinePendingApprovals(
        [{ ...approval, responseCapability: "not_resumable" }],
        respond,
      ),
    ).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });

  it("sends feedback only to the displayed request, leaving other approvals pending", async () => {
    const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.success(undefined));
    const pending = derivePendingThreadRequests({
      runtimeRequests: [
        {
          ...projection.runtimeRequests[0]!,
          kind: "command",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("claude-session"),
            supportsFeedback: true,
          },
        },
        { ...projection.runtimeRequests[0]!, id: second.requestId, kind: "command" },
      ],
      turnItems: [],
    });
    expect(await sendApprovalFeedback(pending.approvals[0]!, "  Safer please.  ", respond)).toBe(
      true,
    );
    expect(respond.mock.calls).toEqual([[approval.requestId, "decline", "Safer please."]]);
  });

  it("keeps feedback unsent when unsupported, stale, empty or rejected", async () => {
    const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.failure(Cause.fail("failed")));
    expect(await sendApprovalFeedback(approval, "Safer please.", respond)).toBe(false);
    expect(
      await sendApprovalFeedback(
        { ...approval, supportsFeedback: true, responseCapability: "not_resumable" },
        "Safer please.",
        respond,
      ),
    ).toBe(false);
    expect(await sendApprovalFeedback({ ...approval, supportsFeedback: true }, "  ", respond)).toBe(
      false,
    );
    expect(respond).not.toHaveBeenCalled();
    expect(
      await sendApprovalFeedback({ ...approval, supportsFeedback: true }, "Safer please.", respond),
    ).toBe(false);
  });
});

describe("initial user input drafts", () => {
  const questions = [
    { id: "editor", initialAnswer: "  Proposed commit\n\n" },
    { id: "empty", initialAnswer: "" },
    { id: "ordinary" },
    { id: "choices", initialAnswer: "Ignore this", allowCustomAnswer: false },
  ];

  it("seeds editable answers and preserves edits and selections on later snapshots", () => {
    const seeded = seedUserInputDraftAnswers(questions, {});
    expect(seeded).toEqual({
      editor: { customAnswer: "  Proposed commit\n\n" },
      empty: { customAnswer: "" },
    });
    const edits = {
      ...seeded,
      editor: { customAnswer: "" },
      empty: { selectedOptionValues: ["empty"], customAnswer: "" },
    };
    expect(seedUserInputDraftAnswers(questions, edits)).toEqual(edits);
    expect(
      seedUserInputDraftAnswers(questions, { editor: { customAnswer: "Edited commit" } }).editor,
    ).toEqual({ customAnswer: "Edited commit" });
    expect(seedUserInputDraftAnswers(questions, {}).editor).toEqual({
      customAnswer: "  Proposed commit\n\n",
    });
  });
});
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        queueQuestionIndex: 0,
        queueQuestionTotal: 1,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });
});

describe("pending question queues", () => {
  const baseRequest = projection.runtimeRequests[0]!;
  const baseItem = projection.turnItems[0]!;
  if (baseItem.type !== "user_input_request") throw new Error("expected a question item");
  const question = baseItem.questions[0]!;
  const at = (minute: number) => DateTime.add(v2Now, { minutes: minute });

  const queue = (
    requests: ReadonlyArray<{
      readonly id: string;
      readonly createdAt: number;
      readonly resolvedAt?: number;
      readonly questions?: number;
    }>,
  ) => {
    const projected = {
      ...projection,
      runtimeRequests: requests.map((request) => ({
        ...baseRequest,
        id: RuntimeRequestId.make(request.id),
        createdAt: at(request.createdAt),
        ...(request.resolvedAt === undefined
          ? {}
          : { status: "resolved" as const, resolvedAt: at(request.resolvedAt) }),
      })),
      turnItems: requests.map((request) => ({
        ...baseItem,
        id: TurnItemId.make(`${request.id}-item`),
        requestId: RuntimeRequestId.make(request.id),
        questions: Array.from({ length: request.questions ?? 1 }, (_, index) => ({
          ...question,
          id: `${request.id}-${index}`,
        })),
      })),
    };
    return derivePendingThreadRequests(projected).userInputs.map((input) => [
      input.requestId,
      input.queueQuestionIndex,
      input.queueQuestionTotal,
    ]);
  };

  it("orders pending questions by creation time, not projection order", () => {
    expect(
      queue([
        { id: "newer", createdAt: 2 },
        { id: "older", createdAt: 1 },
      ]),
    ).toEqual([
      ["older", 0, 2],
      ["newer", 1, 2],
    ]);
  });

  it("counts simultaneous single-question requests as one queue", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(queue(ids.map((id, index) => ({ id, createdAt: index })))).toEqual(
      ids.map((id, index) => [id, index, 5]),
    );
  });

  it("keeps queue positions after earlier questions are answered", () => {
    expect(
      queue([
        { id: "a", createdAt: 0, resolvedAt: 10 },
        { id: "b", createdAt: 0, resolvedAt: 11 },
        { id: "c", createdAt: 0 },
        { id: "d", createdAt: 0 },
        { id: "e", createdAt: 0 },
      ]),
    ).toEqual([
      ["c", 2, 5],
      ["d", 3, 5],
      ["e", 4, 5],
    ]);
  });

  it("starts a new queue for questions asked after the previous one resolved", () => {
    expect(
      queue([
        { id: "a", createdAt: 0, resolvedAt: 1 },
        { id: "b", createdAt: 2, resolvedAt: 3 },
        { id: "c", createdAt: 4 },
      ]),
    ).toEqual([["c", 0, 1]]);
  });

  it("flattens multi-question prompts into the queue count", () => {
    expect(
      queue([
        { id: "a", createdAt: 0, questions: 3 },
        { id: "b", createdAt: 1 },
      ]),
    ).toEqual([
      ["a", 0, 4],
      ["b", 3, 4],
    ]);
  });

  it("joins requests that overlap through a chain", () => {
    expect(
      queue([
        { id: "a", createdAt: 0, resolvedAt: 10 },
        { id: "b", createdAt: 5, resolvedAt: 20 },
        { id: "c", createdAt: 15 },
      ]),
    ).toEqual([["c", 2, 3]]);
  });

  it("does not hold a queue open for a settled request without a resolution time", () => {
    const projected = {
      ...projection,
      runtimeRequests: [
        { ...baseRequest, id: RuntimeRequestId.make("old"), status: "expired" as const },
        { ...baseRequest, id: requestId, createdAt: at(1) },
      ],
      turnItems: [
        { ...baseItem, id: TurnItemId.make("old-item"), requestId: RuntimeRequestId.make("old") },
        baseItem,
      ],
    };
    expect(derivePendingThreadRequests(projected).userInputs[0]).toMatchObject({
      queueQuestionIndex: 0,
      queueQuestionTotal: 1,
    });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});
