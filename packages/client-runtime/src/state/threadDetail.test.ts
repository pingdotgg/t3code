import {
  EnvironmentId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadDetailAtoms, sameThreadStructure } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "./threadState.ts";

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
      push: (projection: OrchestrationV2ThreadProjection) =>
        registry.set(
          stateAtom,
          AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
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
