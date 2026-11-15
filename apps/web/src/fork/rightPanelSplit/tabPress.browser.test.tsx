import "~/index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ReactNode } from "react";

import { RightPanelTabs, type RightPanelTabsProps } from "~/components/RightPanelTabs";
import type { RightPanelSurface } from "~/rightPanelStore";
import { render } from "../../../test/render";

const BROWSER_SURFACE: RightPanelSurface = {
  id: "browser:tab-1",
  kind: "preview",
  resourceId: "tab-1",
};
const DIFF_SURFACE: RightPanelSurface = { id: "diff", kind: "diff" };

function tabs(
  overrides: Pick<RightPanelTabsProps, "onActivate"> &
    Partial<Pick<RightPanelTabsProps, "onCloseSurface">>,
  children: ReactNode = null,
) {
  const noop = () => {};
  const props: RightPanelTabsProps = {
    mode: "inline",
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: true,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: [BROWSER_SURFACE, DIFF_SURFACE],
    environmentId: EnvironmentId.make("environment-local"),
    activeSurfaceId: DIFF_SURFACE.id,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
    ...overrides,
    children,
  };
  return <RightPanelTabs {...props} />;
}

function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  pointerType: "mouse" | "touch" = "mouse",
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("tab activation", () => {
  it("activates a tab on press anywhere on it, through hand jitter, but not from its close button", async () => {
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    await using screen = await render(tabs({ onActivate, onCloseSurface }));
    const tab = screen.container.querySelector<HTMLElement>('[data-active-tab="false"]')!;
    const box = tab.getBoundingClientRect();
    const midY = box.top + box.height / 2;

    for (const [x, y] of [
      [box.left + 2, midY],
      [box.right - 2, midY],
      [box.left + box.width / 2, box.top + 1],
    ] as const) {
      onActivate.mockClear();
      pointer(document.elementFromPoint(x, y)!, "pointerdown", x, y);
      expect(onActivate).toHaveBeenCalledWith(BROWSER_SURFACE);
      pointer(document, "pointerup", x, y);
    }

    onActivate.mockClear();
    const label = screen.getByRole("button", { name: "Browser", exact: true }).element();
    const start = label.getBoundingClientRect();
    pointer(label, "pointerdown", start.left + 4, start.top + 4);
    pointer(document, "pointermove", start.left + 14, start.top + 10);
    pointer(document, "pointerup", start.left + 14, start.top + 10);
    expect(onActivate).toHaveBeenCalledWith(BROWSER_SURFACE);

    onActivate.mockClear();
    const close = screen.getByRole("button", { name: "Close Browser" }).element();
    const closeBox = close.getBoundingClientRect();
    pointer(close, "pointerdown", closeBox.left + 4, closeBox.top + 4);
    pointer(document, "pointerup", closeBox.left + 4, closeBox.top + 4);
    await userEvent.click(close);
    expect(onCloseSurface).toHaveBeenCalledWith(BROWSER_SURFACE);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("leaves focus where activation put it, activates once per click, and waits for the tap on touch", async () => {
    const onActivate = vi.fn((_surface: RightPanelSurface) =>
      document.querySelector<HTMLElement>('[aria-label="Terminal input"]')?.focus(),
    );
    await using screen = await render(
      tabs({ onActivate }, <textarea aria-label="Terminal input" />),
    );
    const label = screen.getByRole("button", { name: "Browser", exact: true });

    await userEvent.click(label);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(BROWSER_SURFACE);
    await expect.element(screen.getByRole("textbox", { name: "Terminal input" })).toHaveFocus();

    onActivate.mockClear();
    const box = label.element().getBoundingClientRect();
    pointer(label.element(), "pointerdown", box.left + 2, box.top + 2, "touch");
    expect(onActivate).not.toHaveBeenCalled();
    label
      .element()
      .dispatchEvent(new PointerEvent("click", { bubbles: true, detail: 1, pointerType: "touch" }));
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(BROWSER_SURFACE);

    onActivate.mockClear();
    label.element().focus();
    await userEvent.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(BROWSER_SURFACE);
  });
});
