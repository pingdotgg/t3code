import { act, memo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { THREAD_CONTEXT_DROP_EVENT, useThreadContextDrop } from "./threadContextDrag";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ChatComposer is memoized and reused across thread navigation; each render's
// drop callback must write into the draft of the thread it last rendered.
const ComposerDropTarget = memo(function ComposerDropTarget({
  draftKey,
  drafts,
}: {
  draftKey: string;
  drafts: Map<string, Array<ThreadId>>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, draftKey, (refs, isActive) => {
    if (!isActive()) return;
    drafts.get(draftKey)?.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

// Same target key, so the listener effect never re-runs: only the effect event
// itself can hand the drop the latest props (React 19.2 kept the first render's).
const StableKeyDropTarget = memo(function StableKeyDropTarget({
  received,
}: {
  received: Array<ThreadId>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, "thread-a", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

describe("useThreadContextDrop", () => {
  it("drops into the last rendered thread's draft when the memoized target is reused", async () => {
    const drafts = new Map<string, Array<ThreadId>>([
      ["thread-a", []],
      ["thread-b", []],
    ]);

    await act(() => root.render(<ComposerDropTarget draftKey="thread-a" drafts={drafts} />));
    await act(() => root.render(<ComposerDropTarget draftKey="thread-b" drafts={drafts} />));

    const dropped: ScopedThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-dropped" as ThreadId,
    };
    const target = container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    act(() => {
      target!.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [dropped] }));
    });

    expect(drafts.get("thread-b")).toEqual(["thread-dropped"]);
    expect(drafts.get("thread-a")).toEqual([]);
  });

  it("reads the latest props in a memoized target whose listener stays attached", async () => {
    const first: Array<ThreadId> = [];
    const latest: Array<ThreadId> = [];

    await act(() => root.render(<StableKeyDropTarget received={first} />));
    await act(() => root.render(<StableKeyDropTarget received={latest} />));

    const target = container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    act(() => {
      target!.dispatchEvent(
        new CustomEvent(THREAD_CONTEXT_DROP_EVENT, {
          detail: [{ environmentId: ENVIRONMENT_ID, threadId: "thread-dropped" as ThreadId }],
        }),
      );
    });

    expect(latest).toEqual(["thread-dropped"]);
    expect(first).toEqual([]);
  });
});
