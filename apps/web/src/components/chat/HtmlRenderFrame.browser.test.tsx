import { EnvironmentId } from "@t3tools/contracts";
import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "about:blank",
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("reports leaving full screen when it unmounts while expanded", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });

  it("shows the inline page full screen instead of loading a second copy", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );
    const inlinePage = document.querySelector('iframe[title="Report"]');
    expect(inlinePage).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await vi.waitFor(() => expect(onFullscreenChange).toHaveBeenLastCalledWith(true));

    // A second document would start from scratch and drop what the reader did in the first.
    expect(document.querySelectorAll('iframe[title="Report"]')).toHaveLength(1);
    expect(document.querySelector('iframe[title="Report"]')).toBe(inlinePage);
  });

  it("opens a page's image above the enlarged page, and Escape closes only the image", async () => {
    await using _screen = await renderExpanded();
    const frame = document.querySelector("iframe")!;
    frame.focus();
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            jsonrpc: "2.0",
            method: "t3/notifications/open-image",
            params: { src: "data:image/png;base64,iVBORw0KGgo=", name: "chart.png" },
          },
        }),
      );
    });
    const image = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('[role="dialog"]')].find(
        (dialog) => dialog.getAttribute("aria-label") !== "Expanded Diagram preview",
      );
      expect(found).toBeDefined();
      return found!;
    });
    const { left, top, width, height } = image.getBoundingClientRect();
    expect(image.contains(document.elementFromPoint(left + width / 2, top + height / 2))).toBe(
      true,
    );

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(image.isConnected).toBe(false));
    expect(document.querySelector(":popover-open")).not.toBeNull();
  });

  it("fits the enlarged frame to the page's height and scrolls only the card", async () => {
    await page.viewport(1280, 800);
    await using _screen = await renderExpanded();
    const { frame, card } = frameAndCard();
    await reportHeight(frame, 300);
    expect(frame.getBoundingClientRect().height).toBe(300);
    expect(card.scrollHeight).toBe(card.clientHeight);
    await reportHeight(frame, 5000);
    expect(frame.getBoundingClientRect().height).toBe(5000);
    expect(card.clientHeight).toBeLessThan(800);
    expect(card.scrollHeight).toBeGreaterThan(card.clientHeight);
  });

  it("zooms by reflowing the page to the card's width instead of overflowing it", async () => {
    await page.viewport(1280, 800);
    await using _screen = await renderExpanded();
    const { frame, card } = frameAndCard();
    await reportHeight(frame, 300);
    const contentWidth = frame.getBoundingClientRect().width;
    for (let step = 0; step < 4; step += 1) {
      await userEvent.click(page.getByRole("button", { name: "Zoom in" }));
    }
    expect(frame.getBoundingClientRect().width).toBeCloseTo(contentWidth, 0);
    expect(frame.getBoundingClientRect().height).toBe(600);
    expect(card.scrollWidth).toBe(card.clientWidth);
    await userEvent.click(page.getByRole("button", { name: "Reset zoom" }));
    for (let step = 0; step < 2; step += 1) {
      await userEvent.click(page.getByRole("button", { name: "Zoom out" }));
    }
    expect(frame.getBoundingClientRect().width).toBeCloseTo(contentWidth, 0);
    expect(frame.getBoundingClientRect().height).toBe(150);
  });
});

async function renderExpanded() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
        threadRef={undefined}
      />,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  stack.move();
  return screen;
}

function frameAndCard() {
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  let card = frame.parentElement!;
  while (getComputedStyle(card).overflowY !== "auto") card = card.parentElement!;
  return { frame, card };
}

async function reportHeight(frame: HTMLIFrameElement, height: number) {
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
      }),
    );
  });
}
