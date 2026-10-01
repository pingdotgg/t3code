import "../index.css";

import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RightPanelSurface } from "../rightPanelStore";
import { RightPanelTabs } from "./RightPanelTabs";

const surfaces: readonly RightPanelSurface[] = [
  { id: "files", kind: "files" },
  { id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts", revealLine: null },
  { id: "terminal:terminal-a", kind: "terminal", resourceId: "terminal-a" },
  { id: "browser:preview-a", kind: "preview", resourceId: "preview-a" },
  { id: "insights", kind: "insights" },
];

const previewSessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "preview-a": {
    threadId: "thread-a",
    tabId: "preview-a",
    navStatus: {
      _tag: "Success",
      url: `${globalThis.location.origin}/dashboard`,
      title: "Local dashboard",
    },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-07-27T00:00:00.000Z",
  },
};

async function mountTabs(
  mounted: readonly RightPanelSurface[] = surfaces,
  activeSurfaceId = "files",
  dirtyFilePaths?: ReadonlySet<string>,
) {
  // Panel width is clamped to a share of the viewport, and the tab strip
  // scrolls once tabs overflow. Pin a desktop viewport so layout assertions
  // do not depend on the runner's default window size.
  await page.viewport(1280, 800);
  const callbacks = {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onClosePanel: vi.fn(),
    onCopyPath: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddFiles: vi.fn(),
    onAddDiff: vi.fn(),
    onAddInsights: vi.fn(),
    onToggleMaximize: vi.fn(),
  };
  const screen = await render(
    <RightPanelTabs
      mode="inline"
      surfaces={mounted}
      activeSurfaceId={activeSurfaceId}
      previewSessions={previewSessions}
      terminalLabels={{ "terminal-a": "Terminal 2" }}
      {...(dirtyFilePaths ? { dirtyFilePaths } : {})}
      {...callbacks}
    >
      <div>Active surface</div>
    </RightPanelTabs>,
  );
  return { callbacks, screen };
}

describe("RightPanelTabs", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // Drag tests persist a width; keep suites independent of execution order.
    globalThis.localStorage.clear();
  });

  it("renders surface titles and the active browser favicon", async () => {
    const { screen } = await mountTabs();
    try {
      await expect.element(page.getByTitle("Files")).toBeInTheDocument();
      await expect.element(page.getByTitle("Insights")).toBeInTheDocument();
      await expect.element(page.getByTitle("src/index.ts")).toBeInTheDocument();
      await expect.element(page.getByTitle("Terminal 2")).toBeInTheDocument();
      const browserTab = page.getByTitle("Local dashboard");
      await expect.element(browserTab).toBeInTheDocument();
      const browserTabElement = await browserTab.element();
      expect(browserTabElement.parentElement!.querySelector("img")?.src).toBe(
        `${globalThis.location.origin}/favicon.ico`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the surface title bar compact", async () => {
    const { screen } = await mountTabs();
    try {
      const tabBar = document.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
      expect(tabBar.getBoundingClientRect().height).toBe(44);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the browser close control in the tab header and uses compact tab text", async () => {
    const { callbacks, screen } = await mountTabs(surfaces, "browser:preview-a");
    try {
      const tabBar = document.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
      const closeButton = await page.getByLabelText("Close browser panel").element();
      const browserTab = await page.getByTitle("Local dashboard").element();
      const fileTab = await page.getByTitle("src/index.ts").element();

      expect(closeButton.parentElement).toBe(tabBar);
      expect(getComputedStyle(browserTab.parentElement!).fontSize).toBe("12px");
      expect(getComputedStyle(fileTab.parentElement!).fontSize).toBe("12px");
      const closeFile = await page.getByLabelText("Close index.ts").element();
      expect(closeFile.getBoundingClientRect().right).toBeLessThanOrEqual(
        fileTab.getBoundingClientRect().left,
      );
      expect(getComputedStyle(fileTab.parentElement!).borderWidth).toBe("0px");

      await page.getByLabelText("Close browser panel").click();
      expect(callbacks.onClosePanel).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches add-menu and maximize actions", async () => {
    const { callbacks, screen } = await mountTabs();
    try {
      await page.getByLabelText("Add surface").click();
      await page.getByRole("menuitem", { name: "Browser" }).click();
      expect(callbacks.onAddBrowserInProfile).not.toHaveBeenCalled();
      await page.getByRole("menuitem", { name: "Default", exact: true }).click();
      expect(callbacks.onAddBrowserInProfile).toHaveBeenCalledOnce();
      expect(callbacks.onAddBrowserInProfile).toHaveBeenCalledWith("default");

      await page.getByLabelText("Add surface").click();
      await page.getByRole("menuitem", { name: "Terminal" }).click();
      expect(callbacks.onAddTerminal).toHaveBeenCalledOnce();

      await page.getByLabelText("Add surface").click();
      await page.getByRole("menuitem", { name: "Insights" }).click();
      expect(callbacks.onAddInsights).toHaveBeenCalledOnce();

      await page.getByLabelText("Maximize panel").click();
      expect(callbacks.onToggleMaximize).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the add-surface button adjacent to the last tab", async () => {
    // Two tabs leave slack in the strip, which is where a growing spacer would
    // otherwise fling the add button to the far edge of the tab bar.
    const { screen } = await mountTabs(surfaces.slice(0, 2));
    try {
      const addButton = await page.getByLabelText("Add surface").element();
      // The title sits on the tab's activate button; measure the whole tab,
      // which also carries the actions and close affordances.
      const lastTab = (await page.getByTitle("index.ts").element()).parentElement!;
      const tabList = document.querySelector("[data-right-panel-tab-list]");
      expect(tabList?.contains(addButton)).toBe(true);

      const addRect = addButton.getBoundingClientRect();
      const lastTabRect = lastTab.getBoundingClientRect();
      const tabBarRect = document
        .querySelector("[data-right-panel-tabbar]")!
        .getBoundingClientRect();
      expect(addRect.left - lastTabRect.right).toBeLessThan(16);
      expect(tabBarRect.right - addRect.right).toBeGreaterThan(16);
    } finally {
      await screen.unmount();
    }
  });

  it("resizes the panel by dragging the left edge handle", async () => {
    const { screen } = await mountTabs();
    try {
      const panel = document.querySelector<HTMLElement>('[data-preview-panel-mode="inline"]')!;
      const handle = panel.querySelector<HTMLElement>('[role="separator"]')!;
      const startWidth = panel.getBoundingClientRect().width;

      // Pointer capture rejects synthetic pointer ids, so stub it out and drive
      // the drag through the handle the capture would have retargeted moves to.
      handle.setPointerCapture = () => {};
      handle.hasPointerCapture = () => false;
      handle.releasePointerCapture = () => {};

      const start = handle.getBoundingClientRect();
      const centerY = start.top + start.height / 2;
      const dispatch = (type: string, clientX: number) => {
        handle.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX,
            clientY: centerY,
          }),
        );
      };

      const startX = start.left + start.width / 2;
      dispatch("pointerdown", startX);
      // Dragging the left edge leftwards must widen a right-anchored panel.
      dispatch("pointermove", startX - 120);
      dispatch("pointerup", startX - 120);

      await vi.waitFor(() => {
        expect(panel.getBoundingClientRect().width).toBeCloseTo(startWidth + 120, 0);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches file context actions and middle-click close", async () => {
    const { callbacks, screen } = await mountTabs();
    try {
      const fileTab = page.getByTitle("index.ts");
      await fileTab.click();
      expect(callbacks.onActivate).toHaveBeenCalledWith(surfaces[1]);
      await expect
        .element(page.getByRole("menuitem", { name: "Copy path" }))
        .not.toBeInTheDocument();

      await page.getByTitle("src/index.ts").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Copy path" }).click();
      expect(callbacks.onCopyPath).toHaveBeenCalledWith("src/index.ts");

      await page.getByTitle("src/index.ts").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close others" }).click();
      expect(callbacks.onCloseOthers).toHaveBeenCalledWith(surfaces[1]);

      await page.getByTitle("src/index.ts").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close to the right" }).click();
      expect(callbacks.onCloseToRight).toHaveBeenCalledWith(surfaces[1]);

      await page.getByTitle("src/index.ts").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close all" }).click();
      expect(callbacks.onCloseAll).toHaveBeenCalledOnce();

      const terminalTab = await page.getByTitle("Terminal 2").element();
      terminalTab.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
      );
      expect(callbacks.onClose).toHaveBeenCalledWith(surfaces[2]);
    } finally {
      await screen.unmount();
    }
  });

  it("marks dirty file tabs and exposes the full path", async () => {
    const { screen } = await mountTabs(surfaces, "files", new Set(["src/index.ts"]));
    try {
      await expect.element(page.getByLabelText("Unsaved changes")).toBeInTheDocument();
      await expect.element(page.getByTitle("src/index.ts")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows no dirty marker without pending edits", async () => {
    const { screen } = await mountTabs();
    try {
      await expect
        .element(page.getByRole("button", { name: "Close index.ts" }))
        .toBeInTheDocument();
      expect(page.getByLabelText("Unsaved changes")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
