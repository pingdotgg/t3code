// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const baseProps: ComponentProps<typeof ComposerPrimaryActions> = {
  compact: false,
  canOperateThread: true,
  pendingAction: null,
  isRunning: false,
  canInterrupt: false,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  preserveComposerFocusOnPointerDown: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
};

// Chromium skips the compatibility mouse events after a canceled pointerdown
// but still fires click. jsdom does not, so the press is spelled out here.
function pressWithMouse(target: Element) {
  const init = { bubbles: true, cancelable: true, button: 0 };
  const pointerDown = new MouseEvent("pointerdown", init);
  Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
  target.dispatchEvent(pointerDown);
  if (!pointerDown.defaultPrevented) target.dispatchEvent(new MouseEvent("mousedown", init));
  const pointerUp = new MouseEvent("pointerup", init);
  Object.defineProperty(pointerUp, "pointerType", { value: "mouse" });
  target.dispatchEvent(pointerUp);
  if (!pointerDown.defaultPrevented) target.dispatchEvent(new MouseEvent("mouseup", init));
  target.dispatchEvent(new MouseEvent("click", init));
}

it.each([
  {
    trigger: "Send options",
    item: "Send with full history (180k tokens)",
    props: { compactBeforeSendTokens: 180_000, onSendWithFullHistory: vi.fn() },
    handler: "onSendWithFullHistory",
  },
  {
    trigger: "Implementation actions",
    item: "Implement in a new thread",
    props: {
      showPlanFollowUpPrompt: true,
      promptHasText: false,
      hasSendableContent: false,
      onImplementPlanInNewThread: vi.fn(),
    },
    handler: "onImplementPlanInNewThread",
  },
] as const)(
  "opens the $trigger menu with a mouse while the composer is resting",
  async ({ trigger, item, props, handler }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ComposerPrimaryActions {...baseProps} {...props} />));
      const button = container.querySelector(`[aria-label="${trigger}"]`)!;
      await act(async () => pressWithMouse(button));
      // Base UI opens a mousedown-triggered menu on the next animation frame.
      await act(async () => new Promise((resolve) => requestAnimationFrame(resolve)));
      const menuItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (element) => element.textContent === item,
      );
      expect(menuItem).toBeDefined();
      await act(async () => menuItem!.click());
      expect(props[handler as keyof typeof props]).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
