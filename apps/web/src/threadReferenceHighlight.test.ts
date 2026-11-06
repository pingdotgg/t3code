import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  activeTargetsAtom,
  activeThreadReferencesAtom,
  classifyThreadReferences,
  referenceHighlightRole,
  threadReferenceHighlight,
} from "./threadReferenceHighlight";

const ref = (threadId: string) => ({
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make(threadId),
});
const a = ref("thread-a");
const b = ref("thread-b");
const active = () => appAtomRegistry.get(activeThreadReferencesAtom);

it("keeps every pinned reference until it is removed, whatever the hover does", () => {
  const highlight = threadReferenceHighlight;
  highlight.clear();

  highlight.enter(a);
  highlight.pin(a);
  highlight.pin(b);
  highlight.pin(a);
  highlight.leave(a);
  expect(active()).toEqual({ hovered: null, pinned: [a, b] });

  highlight.enter(ref("thread-c"));
  expect(active().pinned).toEqual([a, b]);
  highlight.leave(a);
  expect(active().hovered).toEqual(ref("thread-c"));

  highlight.unpin(a);
  expect(active().pinned).toEqual([b]);
  highlight.togglePinned(a);
  highlight.togglePinned(b);
  expect(active().pinned).toEqual([a]);

  highlight.clear();
  expect(active()).toEqual({ hovered: null, pinned: [] });
});

it("activates a hover after it rests 200ms and ends it as soon as the pointer leaves", () => {
  vi.useFakeTimers();
  const highlight = threadReferenceHighlight;
  highlight.clear();
  const unmount = appAtomRegistry.mount(activeTargetsAtom);
  const targets = () => appAtomRegistry.get(activeTargetsAtom);
  try {
    highlight.pin(a);
    highlight.enter(b);
    vi.advanceTimersByTime(199);
    expect(targets()).toEqual([a]);
    vi.advanceTimersByTime(1);
    expect(targets()).toEqual([a, b]);

    highlight.leave(b);
    expect(targets()).toEqual([a]);

    highlight.enter(a);
    vi.advanceTimersByTime(200);
    expect(targets()).toEqual([a]);
  } finally {
    unmount();
    highlight.clear();
    vi.useRealTimers();
  }
});

it("classifies targets and the threads that mention or wait on any of them", () => {
  const matches = (mentions: ReadonlyArray<string>, waits: ReadonlyArray<string>) => ({
    mentions: new Set(mentions.map((id) => scopedThreadKey(ref(id)))),
    waits: new Set(waits.map((id) => scopedThreadKey(ref(id)))),
    unavailable: 0,
    pending: false,
  });
  const highlight = classifyThreadReferences([a, b], (target) =>
    target.threadId === a.threadId
      ? matches(["mentions-a", "thread-b"], [])
      : matches([], ["waits-on-b"]),
  );
  const role = (threadId: string) =>
    referenceHighlightRole(highlight, scopedThreadKey(ref(threadId)));

  expect(role("thread-a")).toBe("target");
  expect(role("thread-b")).toBe("target");
  expect(role("mentions-a")).toBe("related");
  expect(role("waits-on-b")).toBe("related");
  expect(role("unrelated")).toBeNull();
});
