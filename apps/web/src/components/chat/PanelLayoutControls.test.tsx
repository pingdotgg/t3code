// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { Popover, PopoverCreateHandle, PopoverPopup } from "../ui/popover";
import { PanelLayoutControls } from "./PanelLayoutControls";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Owns thread details visibility the way ChatView and ThreadDetailsCard do together. */
function Controls({ presentation }: { presentation: ThreadPanelPresentation }) {
  const [handle] = useState(PopoverCreateHandle);
  const [inlineOpen, setInlineOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(false);
  return (
    <>
      <Popover
        handle={handle}
        open={presentation === "popover" && popoverOpen}
        onOpenChange={setPopoverOpen}
      >
        <PopoverPopup>Thread details card</PopoverPopup>
      </Popover>
      <PanelLayoutControls
        showTerminalControl={false}
        showRightPanelControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={presentation === "inline" ? inlineOpen : popoverOpen}
        threadPanelPresentation={presentation}
        threadPanelPopoverHandle={handle}
        threadPanelShortcutLabel="⌥⌘X"
        threadPanelHasAttention={false}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        onToggleTerminal={() => undefined}
        onToggleThreadPanel={() => setInlineOpen((open) => !open)}
        onToggleRightPanel={() => undefined}
      />
    </>
  );
}

async function renderControls(...presentations: ReadonlyArray<ThreadPanelPresentation>) {
  for (const presentation of presentations) {
    await act(async () => root.render(<Controls presentation={presentation} />));
  }
}

function threadToggle() {
  const element = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Toggle thread details panel"]',
  );
  if (!element) throw new Error("Thread details toggle was not rendered");
  return element;
}

function openTooltip() {
  return document.querySelector('[data-slot="tooltip-popup"][data-open]');
}

function detailsCard() {
  return document.querySelector('[data-slot="popover-popup"]')?.textContent ?? null;
}

/** Moves the pointer onto `element` the way a browser reports it, then rests past the delay. */
async function hover(element: Element) {
  const entered: Array<Element> = [];
  for (let node: Element | null = element; node && node !== container; node = node.parentElement) {
    entered.unshift(node);
  }
  await act(async () => {
    // mouseenter does not bubble: every element the pointer enters gets its own.
    for (const node of entered) node.dispatchEvent(new MouseEvent("mouseenter"));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("PanelLayoutControls thread details toggle", () => {
  it.each([
    ["inline", "popover"],
    ["popover", "inline"],
  ] as const)("shows its shortcut on hover after switching from %s to %s", async (from, to) => {
    await renderControls(from, to);

    await hover(threadToggle());

    expect(openTooltip()?.textContent).toBe("Toggle thread details (⌥⌘X)");
  });

  it.each(["inline", "popover"] as const)(
    "shows its shortcut on keyboard focus in %s presentation",
    async (presentation) => {
      await renderControls(presentation);

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        threadToggle().focus();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(openTooltip()?.textContent).toBe("Toggle thread details (⌥⌘X)");
    },
  );

  it("toggles the inline card on click", async () => {
    await renderControls("inline");
    expect(threadToggle().getAttribute("aria-pressed")).toBe("true");

    await click(threadToggle());
    expect(threadToggle().getAttribute("aria-pressed")).toBe("false");

    await click(threadToggle());
    expect(threadToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("opens and closes the popover card on click", async () => {
    await renderControls("popover");
    expect(detailsCard()).toBeNull();

    await click(threadToggle());
    expect(detailsCard()).toBe("Thread details card");
    expect(threadToggle().getAttribute("aria-pressed")).toBe("true");

    await click(threadToggle());
    expect(threadToggle().getAttribute("aria-pressed")).toBe("false");
  });
});
