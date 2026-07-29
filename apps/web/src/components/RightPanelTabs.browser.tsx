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

async function mountTabs() {
  const callbacks = {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseAll: vi.fn(),
    onCopyPath: vi.fn(),
    onAddBrowser: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddFiles: vi.fn(),
    onAddDiff: vi.fn(),
    onToggleMaximize: vi.fn(),
  };
  const screen = await render(
    <RightPanelTabs
      surfaces={surfaces}
      activeSurfaceId="files"
      previewSessions={previewSessions}
      terminalLabels={{ "terminal-a": "Terminal 2" }}
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
  });

  it("renders surface titles and the active browser favicon", async () => {
    const { screen } = await mountTabs();
    try {
      await expect.element(page.getByTitle("Files")).toBeInTheDocument();
      await expect.element(page.getByTitle("index.ts")).toBeInTheDocument();
      await expect.element(page.getByTitle("Terminal 2")).toBeInTheDocument();
      const browserTab = page.getByTitle("Local dashboard");
      await expect.element(browserTab).toBeInTheDocument();
      const browserTabElement = await browserTab.element();
      expect(browserTabElement.querySelector("img")?.src).toBe(
        `${globalThis.location.origin}/favicon.ico`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches add-menu and maximize actions", async () => {
    const { callbacks, screen } = await mountTabs();
    try {
      await page.getByLabelText("Add surface").click();
      await page.getByRole("menuitem", { name: "Browser" }).click();
      expect(callbacks.onAddBrowser).toHaveBeenCalledOnce();

      await page.getByLabelText("Add surface").click();
      await page.getByRole("menuitem", { name: "Terminal" }).click();
      expect(callbacks.onAddTerminal).toHaveBeenCalledOnce();

      await page.getByLabelText("Maximize panel").click();
      expect(callbacks.onToggleMaximize).toHaveBeenCalledOnce();
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

      await page.getByLabelText("Actions for index.ts").click();
      await page.getByRole("menuitem", { name: "Copy path" }).click();
      expect(callbacks.onCopyPath).toHaveBeenCalledWith("src/index.ts");

      await page.getByLabelText("Actions for index.ts").click();
      await page.getByRole("menuitem", { name: "Close others" }).click();
      expect(callbacks.onCloseOthers).toHaveBeenCalledWith(surfaces[1]);

      await page.getByLabelText("Actions for index.ts").click();
      await page.getByRole("menuitem", { name: "Close to the right" }).click();
      expect(callbacks.onCloseToRight).toHaveBeenCalledWith(surfaces[1]);

      await page.getByLabelText("Actions for index.ts").click();
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
});
