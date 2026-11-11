import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { useFocusComposerOnThreadOpen } from "./useFocusComposerOnThreadOpen";

function ThreadProbe(props: { threadId: string }) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useFocusComposerOnThreadOpen(props.threadId, true, () => composerRef.current?.focus());
  return (
    <>
      <div data-sidebar-row="thread:beta">
        <input aria-label="Thread title" />
      </div>
      <textarea aria-label="Message" ref={composerRef} />
    </>
  );
}

// regression: #27195 double-clicking another thread's row lost its rename field to the composer
it("keeps the sidebar rename input when a double-click opens another thread", async () => {
  // The first render schedules the frame.
  using _frames = fakeTimers();
  await using screen = await render(<ThreadProbe threadId="alpha" />, {
    // A bare hook probe; nothing here navigates.
    router: false,
  });
  await act(() => vi.advanceTimersToNextFrame());
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();

  const renameInput = screen.getByRole("textbox", { name: "Thread title" });
  renameInput.element().focus();
  await screen.rerender(<ThreadProbe threadId="beta" />);
  await act(() => vi.advanceTimersToNextFrame());
  await expect.element(renameInput).toHaveFocus();
});
