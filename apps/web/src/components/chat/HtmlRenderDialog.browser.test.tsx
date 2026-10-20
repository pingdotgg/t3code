import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import "~/index.css";

import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { cachedUrl, refresh, showError, openLink, openChangeRequestLink } = vi.hoisted(() => ({
  cachedUrl: { lifeMs: 60 * 60_000 },
  refresh: vi.fn(),
  showError: vi.fn(),
  openLink: vi.fn(),
  openChangeRequestLink: vi.fn(),
}));
vi.mock(import("~/browser/useOpenLink"), async (original) => ({
  ...(await original()),
  useOpenLink: () => openLink,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + cachedUrl.lifeMs,
  }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: showError } };
});
vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

beforeEach(async () => {
  refresh.mockReset();
  cachedUrl.lifeMs = 60 * 60_000;
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
});

function button(label: string) {
  return page.getByRole("button", { name: label, exact: true });
}

// A trusted click, so the page also gets the user activation the link handler requires.
async function click(label: string) {
  await button(label).click();
}

it("zooms the loaded page within bounds and resets without reloading it", async () => {
  const frame = document.querySelector("iframe")!;
  const src = frame.src;
  for (let step = 0; step < 4; step += 1) await click("Zoom in");
  await expect.element(button("Zoom in")).toBeDisabled();
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("2");
  for (let step = 0; step < 6; step += 1) await click("Zoom out");
  await expect.element(button("Zoom out")).toBeDisabled();
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("0.5");
  await click("Reset zoom");
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("1");
  expect(document.querySelector("iframe")).toBe(frame);
  expect(frame.src).toBe(src);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
});

it("keeps the close button below native window controls and the zoom bar on screen", async () => {
  await page.viewport(1280, 800);
  document.documentElement.style.setProperty("--native-titlebar-height", "52px");
  try {
    const close = button("Close").element().getBoundingClientRect();
    const zoomBar = button("Zoom in").element().getBoundingClientRect();
    expect(close.top).toBeGreaterThanOrEqual(52);
    expect(zoomBar.bottom).toBeLessThanOrEqual(800);
  } finally {
    document.documentElement.style.removeProperty("--native-titlebar-height");
  }
});

it("closes with the close button or Escape", async () => {
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});

async function renderInline() {
  // Async so a URL minted at mount lands inside act.
  await act(async () =>
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

it("offers only full screen and opens with the inline URL while keeping the inline page loaded", async () => {
  await renderInline();
  expect(document.querySelector('[aria-label="Open in panel"]')).toBeNull();
  const inlineFrame = document.querySelector("iframe")!;
  const originalSrc = inlineFrame.src;
  const expandButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open full screen"]',
  )!;
  expandButton.focus();
  await click("Open full screen");
  expect(refresh).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/original.html#",
  );
  expect(inlineFrame.src).toBe(originalSrc);
  await click("Close");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("iframe")).toBe(inlineFrame);
  expect(document.activeElement).toBe(expandButton);
});

async function renderInlineNearExpiry() {
  cachedUrl.lifeMs = 60_000;
  refresh.mockResolvedValueOnce("https://environment.test/inline.html");
  await renderInline();
  expect(refresh).toHaveBeenCalledOnce();
}

it("opens full screen with a fresh URL when the inline one is near expiry", async () => {
  await renderInlineNearExpiry();
  refresh.mockResolvedValue("https://environment.test/renewed.html");
  await click("Open full screen");
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/renewed.html#",
  );
});

it("routes links from the expanded page through its thread", async () => {
  await renderInline();
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
    await renderInlineNearExpiry();
    if (failure === null) refresh.mockResolvedValue(null);
    else refresh.mockRejectedValue(failure);
    await click("Open full screen");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Page unavailable" }),
    );
  },
);
