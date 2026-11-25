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
      .map((part) => (part.named ? `<${part.text}>` : part.text))
      .join("");
  expect(named("echo one\rtwo\r\n\tthree")).toBe("echo one<\\r>two<\\r>\n\tthree");
  expect(named("a\b\u001B[2K\u0000\u007F\u0085\u000B\u000C")).toBe(
    "a<\\b><\\e>[2K<U+0000><U+007F><U+0085><U+000B><U+000C>",
  );
  expect(named("a b c‮d⁧e​f‍g\u{E0072}")).toBe(
    "a<U+2028>b<U+2029>c<U+202E>d<U+2067>e<U+200B>f<U+200D>g<U+E0072>",
  );
  // Joiners that shape a letter or an emoji stay, and so does every drawn character.
  const drawn = "git commit -m 'café 👩‍💻 نمی‌خواهم'\n\tgit push";
  expect(approvalTextParts(drawn)).toEqual([{ text: drawn }]);
  expect(approvalTextParts("")).toEqual([]);
});

it("names a joiner or a variation selector that shapes nothing where it stands", () => {
  const named = (text: string) =>
    approvalTextParts(text)
      .map((part) => (part.named ? `<${part.text}>` : part.text))
      .join("");
  const unchanged = (text: string) => expect(approvalTextParts(text)).toEqual([{ text }]);

  // Punctuation, Latin letters with accents, CJK and a lone emoji have nothing to join.
  expect(named("cat 'safe\u2014\u200D.txt'")).toBe("cat 'safe\u2014<U+200D>.txt'");
  expect(named("caf\u00E9\u200D\u00E8 \u00E9\u200C\u00E8")).toBe(
    "caf\u00E9<U+200D>\u00E8 \u00E9<U+200C>\u00E8",
  );
  expect(named("e\u0301\u200Dx")).toBe("e\u0301<U+200D>x");
  expect(named("\u6F22\u200D\u5B57 \u6F22\u200C\u5B57")).toBe(
    "\u6F22<U+200D>\u5B57 \u6F22<U+200C>\u5B57",
  );
  expect(named("\u{1F469}\u200D.txt \u{1F469}\u200C\u{1F4BB}")).toBe(
    "\u{1F469}<U+200D>.txt \u{1F469}<U+200C>\u{1F4BB}",
  );
  // The start and the end of the text.
  expect(named("\u200Da\u200D")).toBe("<U+200D>a<U+200D>");
  expect(named("\u200C\u0646\u0645\u06CC\u200C")).toBe("<U+200C>\u0646\u0645\u06CC<U+200C>");
  expect(named("\u{1F469}\u200D")).toBe("\u{1F469}<U+200D>");
  // A non-joiner needs a joining letter on both sides; a joiner needs one before it, not a digit.
  expect(named("\u0645\u06CC\u200C.txt \u0661\u200D\u0661")).toBe(
    "\u0645\u06CC<U+200C>.txt \u0661<U+200D>\u0661",
  );

  // Variation selectors and tag characters.
  expect(named("a\uFE0Fb\uFE0E 1\uFE0F \u6F22\uFE0F")).toBe(
    "a<U+FE0F>b<U+FE0E> 1<U+FE0F> \u6F22<U+FE0F>",
  );
  expect(named("a\uFE00 a\u{E0100} \u00E9\u034F \u3164")).toBe(
    "a<U+FE00> a<U+E0100> \u00E9<U+034F> <U+3164>",
  );
  expect(named("\u{1F3F4}\u{E0067}\u{E0062}\u{E007F} a\u{E0041}")).toBe(
    "\u{1F3F4}<U+E0067><U+E0062><U+E007F> a<U+E0041>",
  );
  expect(named("a\u180B \u180E")).toBe("a<U+180B> <U+180E>");

  // Each of these shapes what stands beside it.
  unchanged("\u0646\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u0647\u200D");
  unchanged("\u0915\u094D\u200D\u0937 \u0915\u094D\u200C\u0937 \u0DC1\u0DCA\u200D\u0DBB\u0DD3");
  unchanged("\u{1F469}\u200D\u{1F4BB} \u{1F44B}\u{1F3FD} \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}");
  unchanged("\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F \u2764\uFE0F \u2764\uFE0E 1\uFE0F\u20E3");
  unchanged("\u845B\u{E0100} \u8FBB\uFE00 \u182E\u180B \u1820\u180E\u1820");
});

it("names a joiner or a selector whose neighbour is of the right script but is not its base", () => {
  const named = (text: string) =>
    approvalTextParts(text)
      .map((part) => (part.named ? `<${part.text}>` : part.text))
      .join("");
  const unchanged = (text: string) => expect(approvalTextParts(text)).toEqual([{ text }]);

  // A Mongolian selector after a digit, a punctuation mark or another selector.
  expect(named("\u1810\u180B \u1800\u180C \u182E\u180B\u180B")).toBe(
    "\u1810<U+180B> \u1800<U+180C> \u182E\u180B<U+180B>",
  );
  expect(named("\u1810\u180E\u1820 \u182E\u180E\u182E \u1820\u180E\u180E\u1820")).toBe(
    "\u1810<U+180E>\u1820 \u182E<U+180E>\u182E \u1820<U+180E><U+180E>\u1820",
  );
  // A joiner after a digit, a sign or a lone mark of a joining script, with or without marks.
  expect(named("\u0661\u064B\u200D \u066A\u0301\u200D\u0645 \u061C\u064B\u200D")).toBe(
    "\u0661\u064B<U+200D> \u066A\u0301<U+200D>\u0645 <U+061C>\u064B<U+200D>",
  );
  expect(named("\u0967\u094D\u200D\u0937 \u0967\u094D\u200C\u0937 \u094D\u200D")).toBe(
    "\u0967\u094D<U+200D>\u0937 \u0967\u094D<U+200C>\u0937 \u094D<U+200D>",
  );
  // After a letter that is already a fixed form, a mark of another script or an undrawn mark.
  expect(named("\uFE8D\u200D \u0645\u05B0\u200D \u0645\uFE0F\u200D \u1780\u17B4\u200D")).toBe(
    "\uFE8D<U+200D> \u0645\u05B0<U+200D> \u0645<U+FE0F><U+200D> \u1780<U+17B4><U+200D>",
  );
  // Between letters of two scripts, and a joiner or a non-joiner after another.
  expect(named("\u0645\u200C\u0915 \u0645\u200D\u200D \u0646\u200C\u200C\u0645")).toBe(
    "\u0645<U+200C>\u0915 \u0645\u200D<U+200D> \u0646<U+200C><U+200C>\u0645",
  );
  // A skin tone is not an emoji to join or to select a presentation of.
  expect(named("\u{1F44B}\u{1F3FD}\uFE0F \u2764\uFE0F\uFE0F a\u{1F3FD}\u200D\u{1F4BB}")).toBe(
    "\u{1F44B}\u{1F3FD}<U+FE0F> \u2764\uFE0F<U+FE0F> a\u{1F3FD}<U+200D>\u{1F4BB}",
  );
  expect(named("\u00A9\u{1F3FD}\u200D\u{1F4BB} \u{1F469}\u200D\u{1F3FD}")).toBe(
    "\u00A9\u{1F3FD}<U+200D>\u{1F4BB} \u{1F469}<U+200D>\u{1F3FD}",
  );
  expect(named("\u{1F469}\u200D\u200D\u{1F4BB}")).toBe("\u{1F469}<U+200D><U+200D>\u{1F4BB}");
  // A radical, an iteration mark, a compatibility ideograph, kana and punctuation are not
  // ideographs with variants, and an ideograph takes one selector.
  expect(named("\u2F00\u{E0100} \u3005\u{E0100} \uF900\uFE00 \u3042\u{E0100} \u3001\uFE00")).toBe(
    "\u2F00<U+E0100> \u3005<U+E0100> \uF900<U+FE00> \u3042<U+E0100> \u3001<U+FE00>",
  );
  expect(named("\u845B\u{E0100}\u{E0101} \u8FBB\uFE00\uFE01 \u845B\uFE0D")).toBe(
    "\u845B\u{E0100}<U+E0101> \u8FBB\uFE00<U+FE01> \u845B<U+FE0D>",
  );

  unchanged("\u182E\u180B\u200D\u1820 \u1820\u180F \u0915\u093C\u094D\u200D\u0937");
  unchanged("\u0645\u064E\u200C\u0645 \u{1F44B}\u{1F3FD} \u{1F3F3}\uFE0F\u200D\u{1F308}");
});
