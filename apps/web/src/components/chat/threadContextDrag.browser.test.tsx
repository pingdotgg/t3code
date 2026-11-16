import { memo, useRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { act, render } from "../../../test/render";
import { beginLayoutContentDrag } from "../../layout/layoutDrag";
import {
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropTargetProps,
  useThreadContextDrop,
} from "./threadContextDrag";

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

function ComposerMentionTarget({ received }: { received: Array<ThreadId> }) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, "composer", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return (
    <div
      {...threadContextDropTargetProps()}
      data-testid="composer"
      ref={targetRef}
      style={{ width: 200, height: 80 }}
    />
  );
}

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

  it("takes a thread dragged from a layout content source as a mention", async () => {
    const received: Array<ThreadId> = [];
    const threadRef: ScopedThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-dragged" as ThreadId,
    };
    await using screen = await render(
      <>
        <button
          type="button"
          onPointerDown={(event) => beginLayoutContentDrag(event, { kind: "thread", threadRef })}
        >
          Thread chip
        </button>
        <ComposerMentionTarget received={received} />
      </>,
    );
    const chip = screen
      .getByRole("button", { name: "Thread chip" })
      .element()
      .getBoundingClientRect();
    const composer = screen.getByTestId("composer").element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
    const drop = { x: composer.left + 20, y: composer.top + 20 };

    await act(() => {
      screen
        .getByRole("button", { name: "Thread chip" })
        .element()
        .dispatchEvent(pointer("pointerdown", chip.left + 4, chip.top + 4));
      window.dispatchEvent(pointer("pointermove", drop.x, drop.y));
      window.dispatchEvent(pointer("pointerup", drop.x, drop.y));
    });

    expect(received).toEqual(["thread-dragged"]);
  });
});
