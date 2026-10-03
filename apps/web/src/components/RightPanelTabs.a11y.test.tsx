// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";
import type { PreviewPanelMode } from "./preview/PreviewPanelShell";

let root: Root;
let container: HTMLDivElement;
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const onAddTerminal = vi.fn();

async function renderTabs(open: boolean, mode: PreviewPanelMode = "inline") {
  await act(async () => {
    root.render(
      <RightPanelTabs
        mode={mode}
        open={open}
        surfaces={[{ id: "diff", kind: "diff" }]}
        environmentId={null}
        activeSurfaceId="diff"
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={() => undefined}
        onCloseSurface={() => undefined}
        onCloseOtherSurfaces={() => undefined}
        onCloseSurfacesToRight={() => undefined}
        onCloseAllSurfaces={() => undefined}
        onCopyFilePath={() => undefined}
        onAddBrowser={() => undefined}
        onAddBrowserInProfile={() => undefined}
        onAddTerminal={onAddTerminal}
        onAddPullRequest={() => undefined}
        onAddPullRequests={() => undefined}
        onAddDiff={() => undefined}
        onAddFiles={() => undefined}
        onAddDevice={() => undefined}
        browserAvailable={false}
        terminalAvailable
        diffAvailable={false}
        filesAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
      >
        <div>content</div>
      </RightPanelTabs>,
    );
  });
  await act(async () => vi.advanceTimersToNextFrame());
}

async function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Add panel surface"]')!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () => vi.advanceTimersToNextFrame());
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu).not.toBeNull();
  expect(container.contains(menu)).toBe(false);
  return menu;
}

describe("collapsed panel portaled menu", () => {
  it.each(["sheet", "sidebar", "embedded"] as const)(
    "keeps the menu available in %s mode when open is false",
    async (mode) => {
      await renderTabs(true, mode);
      const menu = await openMenu();
      await renderTabs(false, mode);
      expect(document.querySelector('[role="menu"]')).toBe(menu);
    },
  );

  it("closes the menu on collapse and does not reopen it with the panel", async () => {
    await renderTabs(true);
    await openMenu();
    await renderTabs(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await renderTabs(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const menu = await openMenu();
    await act(async () =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })),
    );
    expect(onAddTerminal).toHaveBeenCalledOnce();
  });
});
