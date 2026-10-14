// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { refresh, showError, openLink, openChangeRequestLink } = vi.hoisted(() => ({
  refresh: vi.fn(),
  showError: vi.fn(),
  openLink: vi.fn(),
  openChangeRequestLink: vi.fn(),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/lib/openPullRequestLink", () => ({
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + 60 * 60_000,
  }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: showError } }));

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  refresh.mockReset();
  openLink.mockReset().mockResolvedValue(undefined);
  openChangeRequestLink.mockReset().mockReturnValue(false);
  showError.mockClear();
  onClose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <HtmlRenderDialog
        src="https://environment.test/page.html"
        title="Diagram"
        onClose={onClose}
      />,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}

it("zooms the loaded page within bounds and resets without reloading it", async () => {
  const frame = document.querySelector("iframe")!;
  const src = frame.src;
  for (let step = 0; step < 6; step += 1) await click("Zoom in");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("2");
  for (let step = 0; step < 8; step += 1) await click("Zoom out");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("0.5");
  await click("Reset zoom");
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("1");
  expect(document.querySelector("iframe")).toBe(frame);
  expect(frame.src).toBe(src);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
});

it("closes with the close button or Escape", async () => {
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onClose).toHaveBeenCalledOnce();
});

async function renderInline() {
  await act(() =>
    root.render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
      />,
    ),
  );
}

it("offers only full screen and opens with a fresh URL while keeping the inline page loaded", async () => {
  await renderInline();
  expect(document.querySelector('[aria-label="Open in panel"]')).toBeNull();
  const inlineFrame = document.querySelector("iframe")!;
  const originalSrc = inlineFrame.src;
  const expandButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open full screen"]',
  )!;
  expandButton.focus();
  refresh.mockResolvedValue("https://environment.test/renewed.html");
  await click("Open full screen");
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/renewed.html#",
  );
  expect(inlineFrame.src).toBe(originalSrc);
  await click("Close");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("iframe")).toBe(inlineFrame);
  expect(document.activeElement).toBe(expandButton);
});

it("routes links from the expanded page through its thread", async () => {
  await renderInline();
  refresh.mockResolvedValue("https://environment.test/renewed.html");
  openChangeRequestLink.mockReturnValue(true);
  await click("Open full screen");
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  frame.focus();
  const url = "https://github.com/pingdotgg/t3code/pull/17561";
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url } },
      }),
    );
  });
  expect(openChangeRequestLink).toHaveBeenCalledWith(
    expect.objectContaining({ metaKey: false, ctrlKey: false }),
    url,
    undefined,
    EnvironmentId.make("environment"),
  );
  expect(openLink).not.toHaveBeenCalled();
});

it.each([null, new Error("Disconnected")])(
  "reports an unavailable URL instead of opening a blank page: %s",
  async (failure) => {
    await renderInline();
    if (failure === null) refresh.mockResolvedValue(null);
    else refresh.mockRejectedValue(failure);
    await click("Open full screen");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Page unavailable" }),
    );
  },
);
