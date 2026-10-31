import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { createEnvironmentThreadDetailAtoms, sameThreadStructure } from "./threadDetail.ts";
import { mergeOlderHistoryIntoProjection } from "./threadHistoryMerge.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";

const later = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");

const assistant: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-assistant"),
  threadId: v2ThreadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
  type: "assistant_message",
  messageId: MessageId.make("message-assistant"),
  text: "Hel",
  streaming: true,
};

function withItem(item: OrchestrationV2TurnItem, updatedAt = v2Now) {
  return {
    ...v2Projection,
    turnItems: [item],
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      },
    ],
    updatedAt,
  };
}

describe("sameThreadStructure", () => {
  const before = withItem(assistant);

  it("holds through streamed text", () => {
    const next = withItem({ ...assistant, text: "Hello", updatedAt: later }, later);
    expect(sameThreadStructure(before, next)).toBe(true);
  });

  it("sees the item finish streaming", () => {
    const next = withItem({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees a new item", () => {
    const next = { ...before, turnItems: [assistant, { ...assistant, id: TurnItemId.make("b") }] };
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("sees other fields change on a streaming item", () => {
    const next = withItem({ ...assistant, text: "Hello", title: "Answer" });
    expect(sameThreadStructure(before, next)).toBe(false);
  });

  it("holds through a visit mark", () => {
    const thread = { ...before.thread, lastVisitedAt: later, updatedAt: later };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(true);
  });

  it("sees other thread changes", () => {
    const thread = { ...before.thread, title: "Renamed" };
    expect(sameThreadStructure(before, { ...before, thread })).toBe(false);
  });

  it("sees changes outside the turn items", () => {
    expect(sameThreadStructure(before, { ...before, runs: [] })).toBe(false);
  });
});

describe("lastVisitedAtAtom", () => {
  it("follows a visit mark the quiet thread holds through", () => {
    const projection = withItem(assistant);
    const state = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => state);
    const ref = { environmentId: EnvironmentId.make("env"), threadId: v2ThreadId };
    const registry = AtomRegistry.make();
    const unmountQuiet = registry.mount(details.quietThreadAtom(ref));
    const unmountVisit = registry.mount(details.lastVisitedAtAtom(ref));
    const quietBefore = registry.get(details.quietThreadAtom(ref));

    const visited = { ...projection, thread: { ...projection.thread, lastVisitedAt: later } };
    registry.set(
      state,
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(visited) }),
    );

    expect(registry.get(details.quietThreadAtom(ref))).toBe(quietBefore);
    expect(registry.get(details.lastVisitedAtAtom(ref))).toBe(later);
    unmountQuiet();
    unmountVisit();
    registry.dispose();
  });
});

describe("quietThreadAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  function setup(initial: OrchestrationV2ThreadProjection) {
    const stateAtom = Atom.make(
      AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(initial) }),
    );
    const quietAtom = createEnvironmentThreadDetailAtoms(() => stateAtom).quietThreadAtom(ref);
    const registry = AtomRegistry.make();
    registry.mount(quietAtom);
    return {
      read: () => registry.get(quietAtom),
      [Symbol.dispose]: () => registry.dispose(),
      push: (projection: OrchestrationV2ThreadProjection | null) =>
        registry.set(
          stateAtom,
          AsyncResult.success({
            ...EMPTY_ENVIRONMENT_THREAD_STATE,
            data: Option.fromNullishOr(projection),
          }),
        ),
    };
  }

  it("keeps the same value through streamed text", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello there", updatedAt: later }, later));
    expect(thread.read()).toBe(first);
  });

  it("passes a structure change on", () => {
    const thread = setup(withItem(assistant));
    const first = thread.read();
    thread.push(withItem({ ...assistant, text: "Hello", updatedAt: later }, later));
    thread.push(withItem({ ...assistant, text: "Hello", status: "completed", streaming: false }));
    const next = thread.read();
    expect(next).not.toBe(first);
    expect(next?.projection.turnItems[0]).toMatchObject({ status: "completed", streaming: false });
  });

  it("discards structure held before the thread resets", () => {
    const initial = withItem(assistant);
    using thread = setup(initial);
    const first = thread.read();
    thread.push(replaceItem(initial, { ...assistant, text: "Hello" }));
    expect(thread.read()).toBe(first);
    thread.push(null);
    expect(thread.read()).toBeNull();
    const reset = withItem({ ...assistant, title: "Restored", text: "New snapshot" });
    thread.push(reset);
    expect(thread.read()).not.toBe(first);
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
    thread.push(replaceItem(reset, { ...assistant, title: "Restored", text: "More text" }));
    expect(thread.read()?.projection.turnItems[0]).toMatchObject({ title: "Restored" });
  });

  it("leaves out the fields that streaming moves", () => {
    const thread = setup(withItem(assistant));
    const projection = thread.read()?.projection;
    expect(projection).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("updatedAt");
    expect(projection?.thread).not.toHaveProperty("lastVisitedAt");
    expect(projection?.turnItems[0]).not.toHaveProperty("text");
    expect(projection?.turnItems[0]).not.toHaveProperty("updatedAt");
    expect(projection?.visibleTurnItems[0]?.item).not.toHaveProperty("text");
    expect(projection?.visibleTurnItems[0]?.item).toMatchObject({
      messageId: assistant.messageId,
      streaming: true,
    });
  });
});

describe("timelineVisibleTurnItemsAtom", () => {
  const ref = { environmentId: EnvironmentId.make("environment-1"), threadId: v2ThreadId };

  it("holds through streamed assistant text while the message reads its own text", () => {
    const stateAtom = Atom.make(
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        data: Option.some<OrchestrationV2ThreadProjection>(withItem(assistant)),
      }),
    );
    const details = createEnvironmentThreadDetailAtoms(() => stateAtom);
    const timelineAtom = details.timelineVisibleTurnItemsAtom(ref);
    const textAtom = details.assistantMessageTextAtom(ref, assistant.id);
    const registry = AtomRegistry.make();
    registry.mount(timelineAtom);
    registry.mount(textAtom);
    const push = (item: OrchestrationV2TurnItem) =>
      registry.set(
        stateAtom,
        AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          data: Option.some(withItem(item, later)),
        }),
      );
    const first = registry.get(timelineAtom);

    push({ ...assistant, text: "Hello", updatedAt: later });
    expect(registry.get(timelineAtom)).toBe(first);
    expect(registry.get(textAtom)).toBe("Hello");

    push({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(registry.get(timelineAtom)[0]?.item).toMatchObject({ text: "Hello", streaming: false });
    registry.dispose();
  });
});

it("only compares replaced entries in a streamed reducer delta", () => {
  const size = 100;
  let slotReads = 0;
  const countReads = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
    new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) slotReads++;
        return Reflect.get(target, key, receiver);
      },
    });
  const items = Array.from({ length: size }, (_, index) => ({
    ...assistant,
    id: TurnItemId.make(`item-${index}`),
    ordinal: index,
  }));
  const before = {
    ...v2Projection,
    turnItems: countReads(items),
    visibleTurnItems: countReads(
      items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
      })),
    ),
  };
  const next = applyOrchestrationV2ProjectionEvent(before, {
    id: EventId.make("text-delta"),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: later,
    payload: { ...items.at(-1)!, text: "Hello", updatedAt: later },
  });
  slotReads = 0;

  expect(sameThreadStructure(before, next!)).toBe(true);
  expect(slotReads).toBeLessThanOrEqual(2);
});

function replaceItem(projection: OrchestrationV2ThreadProjection, item: OrchestrationV2TurnItem) {
  return applyOrchestrationV2ProjectionEvent(projection, {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: item.updatedAt,
    payload: item,
  })!;
}

describe("pendingRequestsAtom", () => {
  const approvalRequest: OrchestrationV2RuntimeRequest = {
    id: RuntimeRequestId.make("approval"),
    nodeId: NodeId.make("request-node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
    createdAt: v2Now,
    resolvedAt: null,
  };
  const questionRequest: OrchestrationV2RuntimeRequest = {
    ...approvalRequest,
    id: RuntimeRequestId.make("question"),
    kind: "user_input",
    responseCapability: { type: "message" },
  };
  const approval = {
    ...assistant,
    id: TurnItemId.make("approval-item"),
    type: "approval_request" as const,
    requestId: approvalRequest.id,
    requestKind: "command" as const,
    prompt: "Run the command?",
    reason: "Needs permission",
  };
  const question = {
    ...assistant,
    id: TurnItemId.make("question-item"),
    type: "user_input_request" as const,
    requestId: questionRequest.id,
    questions: [
      {
        id: "next",
        header: "Next",
        question: "Continue?",
        options: [{ label: "Yes", value: "yes", description: "Continue work" }],
      },
    ],
  };
  const initial: OrchestrationV2ThreadProjection = {
    ...withItem(assistant),
    turnItems: [approval, question, assistant],
    runtimeRequests: [approvalRequest, questionRequest],
  };

  function setup(projection: OrchestrationV2ThreadProjection, details = createDetails()) {
    const registry = AtomRegistry.make();
    const atom = details.atoms.pendingRequestsAtom({
      environmentId: EnvironmentId.make("pending-requests-env"),
      threadId: v2ThreadId,
    });
    const push = (next: OrchestrationV2ThreadProjection | null) =>
      registry.set(
        details.state,
        AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          data: Option.fromNullishOr(next),
        }),
      );
    push(projection);
    registry.mount(atom);
    return { read: () => registry.get(atom), push, [Symbol.dispose]: () => registry.dispose() };
  }

  function createDetails() {
    const state = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE));
    return { state, atoms: createEnvironmentThreadDetailAtoms(() => state) };
  }

  it("avoids history scans through 100 irrelevant replacements with two pending requests", () => {
    let itemTypeReads = 0;
    let requestStatusReads = 0;
    const countItem = (item: typeof assistant) =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (key === "type") itemTypeReads++;
          return Reflect.get(target, key, receiver);
        },
      });
    let projection: OrchestrationV2ThreadProjection = {
      ...initial,
      turnItems: [
        approval,
        question,
        ...Array.from({ length: 998 }, (_, ordinal) =>
          countItem({ ...assistant, id: TurnItemId.make(`stream-${ordinal}`), ordinal }),
        ),
      ],
      runtimeRequests: initial.runtimeRequests.map(
        (request) =>
          new Proxy(request, {
            get(target, key, receiver) {
              if (key === "status") requestStatusReads++;
              return Reflect.get(target, key, receiver);
            },
          }),
      ),
    };
    using thread = setup(projection);
    const selected = thread.read();
    expect(selected).toEqual({
      approvals: [
        {
          requestId: approvalRequest.id,
          requestKind: "command",
          createdAt: "2026-06-20T00:00:00.000Z",
          detail: approval.prompt,
          reason: approval.reason,
          responseCapability: "live",
        },
      ],
      userInputs: [
        {
          requestId: questionRequest.id,
          createdAt: "2026-06-20T00:00:00.000Z",
          questions: [{ ...question.questions[0], multiSelect: false }],
          responseCapability: "message",
          responseMode: "message",
          dismissible: true,
        },
      ],
    });
    let totalItemTypeReads = 0;
    let totalRequestStatusReads = 0;
    for (let update = 0; update < 100; update++) {
      const streamed = countItem({
        ...assistant,
        id: TurnItemId.make("stream-997"),
        ordinal: 997,
        text: `Chunk ${update}`,
      });
      projection = replaceItem(projection, streamed);
      // Exclude reducer work; only count the mounted selector's reads after warmup.
      itemTypeReads = 0;
      requestStatusReads = 0;
      thread.push(projection);
      expect(thread.read()).toBe(selected);
      totalItemTypeReads += itemTypeReads;
      totalRequestStatusReads += requestStatusReads;
    }
    expect.soft(totalItemTypeReads).toBeLessThanOrEqual(400);
    expect(totalRequestStatusReads).toBe(0);
  });

  it.each(["pending", "resolved"] as const)(
    "reuses exact arrays without revisiting %s requests",
    (status) => {
      let statusReads = 0;
      const projection = {
        ...initial,
        runtimeRequests: [
          {
            ...approvalRequest,
            get status() {
              statusReads++;
              return status;
            },
          },
        ],
      };
      using thread = setup(projection);
      const selected = thread.read();
      statusReads = 0;
      for (let update = 0; update < 10; update++) {
        thread.push({
          ...projection,
          thread: { ...projection.thread, title: `Renamed ${update}`, lastVisitedAt: later },
        });
        expect(thread.read()).toBe(selected);
      }
      expect(statusReads).toBe(0);
      expect(selected?.approvals.length).toBe(status === "pending" ? 1 : 0);
    },
  );

  function replaceRequest(
    projection: OrchestrationV2ThreadProjection,
    request: OrchestrationV2RuntimeRequest,
  ) {
    return applyOrchestrationV2ProjectionEvent(projection, {
      id: EventId.make(`event-${request.id}`),
      type: "runtime-request.updated",
      threadId: v2ThreadId,
      occurredAt: later,
      payload: request,
    })!;
  }

  it("updates capabilities, prompts, options, questions and request resolution", () => {
    using thread = setup(initial);
    let selected = thread.read();
    const check = (projection: OrchestrationV2ThreadProjection) => {
      thread.push(projection);
      const next = thread.read();
      expect(next).toEqual(derivePendingThreadRequests(projection));
      expect(next).not.toBe(selected);
      selected = next;
      return next;
    };
    let projection = replaceRequest(initial, {
      ...approvalRequest,
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("new-session"),
        supportsFeedback: true,
      },
    });
    expect(check(projection)?.approvals[0]?.supportsFeedback).toBe(true);
    projection = replaceItem(projection, {
      ...approval,
      prompt: "Use the other command?",
      reason: "Different permission",
      options: [{ label: "Allow once", decision: "accept" }],
    });
    expect(check(projection)?.approvals[0]).toMatchObject({
      detail: "Use the other command?",
      reason: "Different permission",
      options: [{ label: "Allow once", decision: "accept" }],
    });
    projection = replaceItem(projection, {
      ...question,
      questions: [
        {
          ...question.questions[0]!,
          question: "Which next?",
          multiSelect: true,
          options: [{ label: "No", value: "no", description: "Stop work" }],
        },
      ],
    });
    expect(check(projection)?.userInputs[0]?.questions[0]).toMatchObject({
      question: "Which next?",
      multiSelect: true,
      options: [{ value: "no" }],
    });
    projection = replaceRequest(projection, {
      ...questionRequest,
      responseCapability: { type: "not_resumable", reason: "Runtime exited" },
    });
    expect(check(projection)?.userInputs[0]).toMatchObject({
      responseCapability: "not_resumable",
      dismissible: false,
    });
    projection = replaceRequest(projection, {
      ...approvalRequest,
      responseCapability: { type: "not_resumable", reason: "Runtime exited" },
    });
    expect(check(projection)?.approvals[0]?.responseCapability).toBe("not_resumable");
    projection = replaceRequest(projection, {
      ...approvalRequest,
      status: "resolved",
      resolvedAt: later,
    });
    expect(check(projection)?.approvals).toEqual([]);
    projection = replaceRequest(projection, {
      ...questionRequest,
      status: "resolved",
      resolvedAt: later,
    });
    expect(check(projection)?.userInputs).toEqual([]);
    const settled = thread.read();
    projection = { ...projection, runtimeRequests: [] };
    thread.push(projection);
    expect(thread.read()).toBe(settled);
    expect(thread.read()).toEqual({ approvals: [], userInputs: [] });
    projection = replaceRequest(projection, questionRequest);
    expect(check(projection)?.userInputs).toHaveLength(1);
    projection = replaceRequest(projection, approvalRequest);
    expect(check(projection)?.approvals).toHaveLength(1);
    const unchanged = thread.read();
    thread.push({ ...projection, runtimeRequests: projection.runtimeRequests.slice() });
    expect(thread.read()).toBe(unchanged);
  });

  it.each([approval, question])("rescans replacements to and from $type", (requestItem) => {
    using thread = setup(initial);
    const selected = thread.read();
    const withoutRequest = replaceItem(initial, { ...assistant, id: requestItem.id });
    thread.push(withoutRequest);
    expect(thread.read()).toEqual(derivePendingThreadRequests(withoutRequest));
    expect(thread.read()).not.toBe(selected);
    const restored = replaceItem(withoutRequest, requestItem);
    thread.push(restored);
    expect(thread.read()).toEqual(selected);
    expect(thread.read()).not.toBe(selected);
  });

  it("falls back for skipped replacements, snapshot branches, prepends and reordered requests", () => {
    let statusReads = 0;
    const start = {
      ...initial,
      runtimeRequests: [
        {
          ...approvalRequest,
          get status() {
            statusReads++;
            return approvalRequest.status;
          },
        },
        questionRequest,
      ],
    };
    using thread = setup(start);
    const check = (projection: OrchestrationV2ThreadProjection) => {
      statusReads = 0;
      thread.push(projection);
      thread.read();
      expect(statusReads).toBeGreaterThan(0);
      expect(thread.read()).toEqual(derivePendingThreadRequests(projection));
    };
    const selected = thread.read();
    check({ ...start, turnItems: start.turnItems.slice() });
    expect(thread.read()).toBe(selected);
    const gap = replaceItem(replaceItem(start, { ...assistant, text: "Skipped stream update" }), {
      ...assistant,
      text: "After skipped stream update",
    });
    check(gap);
    expect(thread.read()).toBe(selected);
    const consecutive = replaceItem(gap, { ...assistant, text: "After fallback" });
    statusReads = 0;
    thread.push(consecutive);
    expect(thread.read()).toBe(selected);
    expect(statusReads).toBe(0);
    const changed = replaceItem(consecutive, { ...approval, prompt: "Changed while skipped" });
    const skipped = replaceItem(changed, { ...assistant, text: "After skipped approval" });
    check(skipped);
    expect(thread.read()?.approvals[0]?.detail).toBe("Changed while skipped");
    const snapshot = { ...start, turnItems: start.turnItems.slice() };
    const resumed = replaceItem(snapshot, { ...assistant, text: "Other snapshot branch" });
    check(resumed);
    expect(thread.read()?.approvals[0]?.detail).toBe(approval.prompt);
    const olderQuestion = {
      ...question,
      id: TurnItemId.make("older-question"),
      ordinal: 0,
      questions: [{ ...question.questions[0]!, question: "Older question?" }],
    };
    const prepended = mergeOlderHistoryIntoProjection(resumed, [
      withItem(olderQuestion).visibleTurnItems[0]!,
    ]);
    check(prepended);
    expect(thread.read()?.userInputs[0]?.questions[0]?.question).toBe("Older question?");
    check({ ...prepended, turnItems: prepended.turnItems.toReversed() });
    expect(thread.read()?.userInputs[0]?.questions[0]?.question).toBe("Continue?");
    check({ ...start, turnItems: [] });
    expect(thread.read()?.userInputs).toEqual([]);
    check(start);
    expect(thread.read()?.userInputs).toHaveLength(1);
  });

  it("clears selection on null and recomputes after reload and registry disposal", () => {
    const details = createDetails();
    const selected = (() => {
      using thread = setup(initial, details);
      const selected = thread.read();
      thread.push(null);
      expect(thread.read()).toBeNull();
      thread.push(initial);
      expect(thread.read()).toEqual(selected);
      expect(thread.read()).not.toBe(selected);
      return selected;
    })();
    const reloaded = replaceItem(initial, { ...approval, prompt: "Reloaded approval" });
    using thread = setup(reloaded, details);
    expect(thread.read()?.approvals[0]?.detail).toBe("Reloaded approval");
    expect(thread.read()).toEqual(derivePendingThreadRequests(reloaded));
    expect(thread.read()).not.toBe(selected);
  });
});

it("matches full structure comparisons across streamed, batched, and reordered updates", () => {
  const message = { ...assistant, ordinal: 2 };
  const reasoning = {
    ...assistant,
    id: TurnItemId.make("reasoning"),
    type: "reasoning" as const,
    ordinal: 1,
  };
  const initial = mergeOlderHistoryIntoProjection(withItem(message), [
    withItem(reasoning).visibleTurnItems[0]!,
  ]);
  const updates = [
    { ...message, text: "Hello", updatedAt: later },
    { ...reasoning, text: "Thinking", updatedAt: later },
    { ...reasoning, text: "Done", status: "completed" as const, streaming: false },
    { ...message, text: "Hello there", updatedAt: later },
    { ...message, text: "Hello there", ordinal: 0 },
    { ...message, text: "More text", ordinal: 0 },
    { ...message, text: "More text", ordinal: 2 },
    { ...message, text: "More text", runId: RunId.make("another-run") },
  ];
  const projections = [initial];
  const withoutHints = (projection: OrchestrationV2ThreadProjection) => ({
    ...projection,
    turnItems: projection.turnItems.slice(),
    visibleTurnItems: projection.visibleTurnItems.slice(),
  });
  const consecutive: boolean[] = [];
  for (const item of updates) {
    const previous = projections.at(-1)!;
    const next = replaceItem(previous, item);
    consecutive.push(sameThreadStructure(previous, next));
    // All earlier snapshots include readers that skip one or several updates in a batch.
    for (const before of projections) {
      expect(sameThreadStructure(before, next)).toBe(
        sameThreadStructure(withoutHints(before), withoutHints(next)),
      );
    }
    projections.push(next);
  }

  // A resumed snapshot can reuse item ids while changing a different row.
  const snapshot = withoutHints(projections[1]!);
  const resumed = replaceItem(snapshot, { ...reasoning, title: "Restored reasoning" });
  const sibling = replaceItem(initial, { ...message, text: "Another stream" });
  const reconnected = replaceItem(resumed, { ...message, text: "Resumed stream" });
  for (const before of [initial, sibling, projections[1]!, resumed]) {
    expect(sameThreadStructure(before, reconnected)).toBe(
      sameThreadStructure(withoutHints(before), withoutHints(reconnected)),
    );
  }
  expect(sameThreadStructure(sibling, reconnected)).toBe(false);
  expect(sameThreadStructure(resumed, reconnected)).toBe(true);

  expect(consecutive).toEqual([true, true, false, true, false, true, false, false]);
  expect(sameThreadStructure(initial, projections[4]!)).toBe(false);
  expect(projections[5]!.visibleTurnItems.map((row) => [row.item.id, row.position])).toEqual([
    [assistant.id, 0],
    [reasoning.id, 1],
  ]);
  expect(projections[7]!.visibleTurnItems.map((row) => [row.item.id, row.position])).toEqual([
    [reasoning.id, 0],
    [assistant.id, 1],
  ]);
});
