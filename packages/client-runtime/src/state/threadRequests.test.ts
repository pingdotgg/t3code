import { presentThreadShell } from "./models.ts";
import { threadKey } from "./entities.ts";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  type ScopedThreadRef,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { projectTurnItemForWire } from "@t3tools/shared/wireProjection";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  createChildThreadApprovalsAtom,
  type PendingThreadRequests,
  derivePendingThreadRequests,
  declinePendingApprovals,
  sendApprovalFeedback,
  makeThreadRequestsResolvedAnnouncer,
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  resolvedQuestionDraftKeys,
  seedUserInputDraftAnswers,
  userInputDraftKey,
  type ApprovalResponder,
  type ThreadRequestsResolved,
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

describe("pruning resolved user input drafts", () => {
  const answered = userInputDraftKey("env", "thread", "answered");
  const pending = userInputDraftKey("env", "thread", "pending");
  const otherThread = userInputDraftKey("env", "thread-2", "answered");
  const otherEnvironment = userInputDraftKey("env-2", "thread", "answered");
  const drafts = {
    [answered]: 1,
    [pending]: 2,
    [otherThread]: 3,
    [otherEnvironment]: 4,
  };

  it("drops only the thread's requests that are no longer pending", () => {
    expect(pruneResolvedUserInputDrafts(drafts, "env", "thread", ["pending"])).toEqual({
      [pending]: 2,
      [otherThread]: 3,
      [otherEnvironment]: 4,
    });
  });

  it("returns the same record when nothing resolved", () => {
    expect(pruneResolvedUserInputDrafts(drafts, "env", "thread", ["answered", "pending"])).toBe(
      drafts,
    );
  });
});

describe("resolved question draft keys", () => {
  const prefix = "env:question-thread-";
  const key = (request: string, question: string) =>
    `${prefix}${encodeURIComponent(JSON.stringify([request, question]))}`;

  it("returns the thread's keys for requests that are no longer pending", () => {
    const keys = [
      key("pending", "first"),
      key("pending", "second"),
      key("pending-2", "first"),
      key("answered", "first"),
      "env:question-other-thread-x",
    ];
    expect(resolvedQuestionDraftKeys(keys, prefix, [RuntimeRequestId.make("pending")])).toEqual([
      key("pending-2", "first"),
      key("answered", "first"),
    ]);
  });
});

describe("announcing resolved thread requests", () => {
  const environmentId = EnvironmentId.make("env");
  const threadId = v2Projection.thread.id;
  const first = RuntimeRequestId.make("first");
  const second = RuntimeRequestId.make("second");

  function record() {
    const events: ThreadRequestsResolved[] = [];
    const unsubscribe = onThreadRequestsResolved((event) => events.push(event));
    return { events, [Symbol.dispose]: unsubscribe };
  }

  it("announces the first projection, then only when a request leaves pending", () => {
    using recorder = record();
    const announce = makeThreadRequestsResolvedAnnouncer(environmentId, threadId);

    announce([first]);
    announce([first, second]);
    announce([first, second]);
    announce([second]);

    expect(recorder.events).toEqual([
      { environmentId, threadId, pendingRequestIds: [first] },
      { environmentId, threadId, pendingRequestIds: [second] },
    ]);
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

  it("seeds a question with the id __proto__ as its own draft", () => {
    const seeded = seedUserInputDraftAnswers(
      [
        { id: "__proto__", initialAnswer: "Proposed" },
        { id: "name", initialAnswer: "Control" },
      ],
      {},
    );

    expect(JSON.stringify(seeded)).toBe(
      '{"__proto__":{"customAnswer":"Proposed"},"name":{"customAnswer":"Control"}}',
    );
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

type QuestionItem = Extract<
  OrchestrationV2ThreadProjection["turnItems"][number],
  { readonly type: "user_input_request" }
>;

describe("question history through exact row replacements", () => {
  const baseItem = {
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "running" as const,
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
  };
  const assistantItem = (ordinal: number, text = "Hel") => ({
    ...baseItem,
    id: TurnItemId.make(`assistant-${ordinal}`),
    ordinal,
    type: "assistant_message" as const,
    messageId: MessageId.make(`message-${ordinal}`),
    text,
    streaming: true,
  });
  const localRow = (
    item: OrchestrationV2ThreadProjection["turnItems"][number],
    position: number,
  ) => ({
    item,
    position,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  });
  const updated = (
    current: OrchestrationV2ThreadProjection,
    item: OrchestrationV2ThreadProjection["turnItems"][number],
  ) =>
    applyOrchestrationV2ProjectionEvent(current, {
      id: EventId.make(`event-${item.id}`),
      type: "turn-item.updated",
      threadId: current.thread.id,
      occurredAt: v2Now,
      payload: item,
    })!;

  it("reads only the replaced row and leaves the request index alone", () => {
    const size = 1_000;
    const counts = { items: 0, requestIds: 0 };
    const items = Array.from({ length: size }, (_, index) => assistantItem(index));
    const countedRows = items.map((item, index) => {
      const row = localRow(item, index);
      return Object.defineProperty(row, "item", {
        enumerable: true,
        get: () => {
          counts.items += 1;
          return item;
        },
      });
    });
    const countedRequests = Array.from({ length: 400 }, (_, index) => {
      const request = {
        ...projection.runtimeRequests[0]!,
        id: RuntimeRequestId.make(`request-${index}`),
      };
      return Object.defineProperty(request, "id", {
        enumerable: true,
        get: () => {
          counts.requestIds += 1;
          return RuntimeRequestId.make(`request-${index}`);
        },
      });
    });
    const initial: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      turnItems: items,
      visibleTurnItems: countedRows,
      runtimeRequests: countedRequests,
    };
    const project = createQuestionHistoryProjector();
    const scan = (current: OrchestrationV2ThreadProjection) => {
      counts.items = 0;
      counts.requestIds = 0;
      const result = project(current);
      return { result, ...counts };
    };
    expect(scan(initial)).toMatchObject({ items: size, requestIds: 400 });

    const adjacent = updated(initial, assistantItem(size - 1, "Hello"));
    const hinted = scan(adjacent);
    expect(hinted.result).toBe(adjacent.visibleTurnItems);
    expect(hinted).toMatchObject({ items: 0, requestIds: 0 });

    // A skipped delta has no hint for this exact pair, so it scans again.
    const skipped = updated(
      updated(adjacent, assistantItem(size - 1, "Hello t")),
      assistantItem(size - 1, "Hello there"),
    );
    const fallback = scan(skipped);
    expect(fallback.result).toBe(skipped.visibleTurnItems);
    expect(fallback).toMatchObject({ items: size - 1, requestIds: 0 });
  });

  it("matches a full projection through streamed rows, request changes and answers", () => {
    const question = projection.turnItems[0] as QuestionItem;
    const resolved = (answers: Record<string, string>) => ({
      ...projection.runtimeRequests[0]!,
      status: "resolved" as const,
      answers,
    });
    const explicitRequestId = RuntimeRequestId.make("explicit-question");
    const explicitAnswer = {
      requestId: explicitRequestId,
      answers: { next: "Explicit" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    };
    const unanswered: QuestionItem = {
      ...question,
      id: TurnItemId.make("explicit-question-item"),
      ordinal: 1,
      requestId: explicitRequestId,
    };
    const explicit: QuestionItem = { ...unanswered, questionAnswer: explicitAnswer };
    const explicitRequest = {
      ...resolved({ next: "From request" }),
      id: explicitRequestId,
    };
    const stream = assistantItem(2);
    const inherited = {
      ...localRow({ ...question, id: TurnItemId.make("inherited-question-item") }, 3),
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("parent-thread"),
    };
    const turnItems = [question, explicit, stream];
    let current: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      turnItems,
      visibleTurnItems: [...turnItems.map(localRow), inherited],
      runtimeRequests: [projection.runtimeRequests[0]!, explicitRequest],
    };
    const project = createQuestionHistoryProjector();
    const step = (next: OrchestrationV2ThreadProjection) => {
      current = next;
      const result = project(next);
      expect(result).toEqual(createQuestionHistoryProjector()(next));
      return result;
    };
    const answerOf = (rows: ReadonlyArray<{ readonly item: unknown }>, index: number) =>
      (rows[index]!.item as { readonly questionAnswer?: { readonly answers: unknown } })
        .questionAnswer?.answers;

    expect(step(current)).toBe(current.visibleTurnItems);
    expect(step(updated(current, assistantItem(2, "Hello")))).toBe(current.visibleTurnItems);

    // The last duplicate request wins, and every row asking it gets the answer.
    const answered = step({
      ...current,
      runtimeRequests: [
        projection.runtimeRequests[0]!,
        resolved({ next: "Continue" }),
        explicitRequest,
      ],
    });
    expect(answerOf(answered, 0)).toEqual({ next: "Continue" });
    expect(answerOf(answered, 1)).toEqual({ next: "Explicit" });
    expect(answerOf(answered, 3)).toEqual({ next: "Continue" });

    const whileOverlaid = step(updated(current, assistantItem(2, "Hello there")));
    expect(whileOverlaid[0]).toBe(answered[0]);
    expect(whileOverlaid[3]).toBe(answered[3]);

    const changedAnswer = step({
      ...current,
      runtimeRequests: [resolved({ next: "Stop" }), explicitRequest],
    });
    expect(answerOf(changedAnswer, 0)).toEqual({ next: "Stop" });

    const reopened = step({
      ...current,
      runtimeRequests: [projection.runtimeRequests[0]!, explicitRequest],
    });
    expect(reopened).toBe(current.visibleTurnItems);

    // Dropping an explicit answer falls back to its resolved request.
    const restored = step(updated(current, unanswered));
    expect(answerOf(restored, 1)).toEqual({ next: "From request" });

    const retitled: QuestionItem = {
      ...unanswered,
      questions: [{ ...question.questions[0]!, question: "Now what?" }],
    };
    const retitledRows = step(updated(current, retitled));
    expect(retitledRows[1]!.item).toMatchObject({
      questionAnswer: { questionTextById: { next: "Now what?" } },
    });
  });
});

it("loads only child approvals and retains their destination across environments", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const parent = { environmentId: local, threadId: ThreadId.make("parent") };
  const childId = ThreadId.make("child");
  const children = Atom.make(
    [local, remote].map((environmentId) => ({
      ...presentThreadShell(environmentId, v2ThreadShell),
      id: childId,
      title: environmentId,
      hasPendingApprovals: true,
    })),
  );
  const details = Atom.family((key: string) =>
    Atom.make<PendingThreadRequests | null>({
      approvals: [
        {
          requestId: RuntimeRequestId.make(key),
          requestKind: "command",
          createdAt: "2026-10-19T00:00:00Z",
          responseCapability: "live",
        },
      ],
      userInputs: [],
    }),
  );
  const readDetails = vi.fn((ref: ScopedThreadRef) => details(threadKey(ref)));
  const approvalsAtom = createChildThreadApprovalsAtom({
    childThreadInputsAtom: () => children,
    pendingRequestsAtom: readDetails,
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(approvalsAtom(parent));
  const pending = registry.get(approvalsAtom(parent));
  expect(pending.map((entry) => entry.thread)).toEqual(
    [local, remote].map((environmentId) => ({ environmentId, threadId: childId })),
  );
  expect(pending.map((entry) => entry.title)).toEqual(["local", "remote"]);
  registry.set(details(threadKey({ environmentId: remote, threadId: childId })), {
    approvals: [],
    userInputs: [],
  });
  expect(registry.get(approvalsAtom(parent))).toEqual([pending[0]]);
  readDetails.mockClear();
  registry.set(
    children,
    registry
      .get(children)
      .map((child) => ({ ...child, hasPendingApprovals: false, hasPendingUserInput: true })),
  );
  expect(registry.get(approvalsAtom(parent))).toEqual([]);
  expect(readDetails).not.toHaveBeenCalled();
  unmount();
  registry.dispose();
});

describe("pending v2 approvals", () => {
  it.each([false, true])("lists approval files and their detail source (wire: %s)", (wire) => {
    const approvalId = RuntimeRequestId.make("file-approval");
    const approvalNode = NodeId.make("file-approval-node");
    const nativeItemRef = {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "item-7",
      strength: "strong" as const,
    };
    const base = {
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
    };
    const approvals = derivePendingThreadRequests({
      runtimeRequests: [
        {
          ...projection.runtimeRequests[0]!,
          id: approvalId,
          nodeId: approvalNode,
          kind: "file-change",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("live-session"),
          },
        },
      ],
      turnItems: [
        (wire ? projectTurnItemForWire : (item: OrchestrationV2TurnItem) => item)({
          ...base,
          id: TurnItemId.make("file-change-item"),
          nativeItemRef,
          type: "file_change",
          fileName: "src/app.ts",
          additions: 4,
          deletions: 1,
          diffStr: "@@ -1 +1 @@\n-a\n+b",
        }),
        {
          ...base,
          id: TurnItemId.make("multi-file-item"),
          nativeItemRef,
          type: "file_change",
          fileName: "src/one.ts",
          changes: [
            { path: "src/one.ts", operation: "update" },
            { path: "src/two.ts", operation: "add" },
          ],
        },
        {
          ...base,
          id: TurnItemId.make("other-file-change-item"),
          nativeItemRef: { ...nativeItemRef, nativeId: "item-8" },
          type: "file_change",
          fileName: "src/other.ts",
        },
        {
          ...base,
          id: TurnItemId.make("file-approval-item"),
          nodeId: approvalNode,
          nativeItemRef,
          type: "approval_request",
          requestId: approvalId,
          requestKind: "file-change",
          prompt: "update src/app.ts",
        },
      ],
    }).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.files).toEqual([
      {
        path: "src/app.ts",
        source: {
          threadId: v2Projection.thread.id,
          itemId: TurnItemId.make("file-change-item"),
          revision: DateTime.formatIso(v2Now),
        },
        additions: 4,
        deletions: 1,
        ...(wire ? {} : { diff: "@@ -1 +1 @@\n-a\n+b" }),
      },
      ...["src/one.ts", "src/two.ts"].map((path, index) => ({
        path,
        operation: index === 0 ? "update" : "add",
        source: {
          threadId: v2Projection.thread.id,
          itemId: TurnItemId.make("multi-file-item"),
          revision: DateTime.formatIso(v2Now),
        },
      })),
    ]);
  });
});
