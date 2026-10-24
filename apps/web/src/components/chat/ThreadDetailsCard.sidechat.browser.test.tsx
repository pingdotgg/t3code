import { act, render } from "../../../test/render";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { PopoverCreateHandle } from "../ui/popover";
import { useRightPanelStore } from "../../rightPanelStore";
const threadRef = {
  environmentId: EnvironmentId.make("layout-fixture"),
  threadId: ThreadId.make("main"),
};
const containerSize = { width: 1600, height: 900 };
const report = vi.fn();
const presentation = vi.fn();
const canvas = {
  container: containerSize,
  lane: { padding: 48, minChatWidth: 640 },
  layout: resolveChatCanvasLayout({ container: containerSize, preview: null }),
  previewKey: null,
  reportPreview: vi.fn(),
  clearPreview: vi.fn(),
  registerTimeline: vi.fn(),
  reportDetailsCard: report,
  detailsCardTopInset: 0,
};
function Fixture({ sidechat = false }: { sidechat?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [handle] = useState(PopoverCreateHandle);
  return (
    <ChatCanvasContext value={canvas}>
      <button
        ref={anchor}
        onClick={() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true)}
      >
        Workspace details
      </button>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={anchor}
        handle={handle}
        onPresentationChange={presentation}
        popoverOnly={sidechat}
      >
        {() => <span>Workspace content</span>}
      </ThreadDetailsCard>
    </ChatCanvasContext>
  );
}
it("yields the main column while sidechat is open, keeps details accessible, and restores the inline preference", async () => {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  presentation.mockClear();
  report.mockClear();
  await using screen = await render(<Fixture />);
  const container = screen.container;
  await screen.rerender(<Fixture />);
  expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
  await screen.rerender(<Fixture sidechat />);
  expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
  expect(presentation).toHaveBeenLastCalledWith("popover");
  expect(report).toHaveBeenLastCalledWith(null);
  await act(() => container.querySelector("button")!.click());
  expect(document.querySelector('[data-thread-details-panel="popover"]')?.textContent).toContain(
    "Workspace content",
  );
  await screen.rerender(<Fixture />);
  expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
  expect(presentation).toHaveBeenLastCalledWith("inline");
});
