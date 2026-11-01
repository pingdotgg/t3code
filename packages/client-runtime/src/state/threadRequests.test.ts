import { presentThreadShell } from "./models.ts";
import { threadKey } from "./entities.ts";
import {
  EnvironmentId,
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
