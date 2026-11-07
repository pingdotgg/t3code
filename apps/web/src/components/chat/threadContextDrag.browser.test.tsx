import { memo, useRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { act, render } from "../../../test/render";
import { THREAD_CONTEXT_DROP_EVENT, useThreadContextDrop } from "./threadContextDrag";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;

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

// Keep the key stable to isolate effect-event updates; React 19.2 retained initial props.
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

    await using screen = await render(<ComposerDropTarget draftKey="thread-a" drafts={drafts} />);
    await screen.rerender(<ComposerDropTarget draftKey="thread-b" drafts={drafts} />);

    const dropped: ScopedThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-dropped" as ThreadId,
    };
    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
      target!.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [dropped] }));
    });

    expect(drafts.get("thread-b")).toEqual(["thread-dropped"]);
    expect(drafts.get("thread-a")).toEqual([]);
  });

  it("reads the latest props in a memoized target whose listener stays attached", async () => {
    const first: Array<ThreadId> = [];
    const latest: Array<ThreadId> = [];

    await using screen = await render(<StableKeyDropTarget received={first} />);
    await screen.rerender(<StableKeyDropTarget received={latest} />);

    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
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
