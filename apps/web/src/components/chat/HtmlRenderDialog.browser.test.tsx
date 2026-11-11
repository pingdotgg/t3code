import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

import { HtmlRenderDialog } from "./HtmlRenderDialog";

const dialog = (
  <HtmlRenderDialog
    src="https://environment.test/page.html"
    htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
    onClose={() => {}}
  />
);

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

it("fits the frame to the page's height and scrolls only the card", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(dialog);
  const { frame, card } = frameAndCard();
  await vi.waitFor(() => {
    expect(
      frame
        .closest('[role="dialog"]')!
        .getAnimations()
        .some((animation) => animation.playState === "running"),
    ).toBe(false);
  });
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
  await using _screen = await render(dialog);
  const { frame, card } = frameAndCard();
  await vi.waitFor(() => {
    expect(
      frame
        .closest('[role="dialog"]')!
        .getAnimations()
        .some((animation) => animation.playState === "running"),
    ).toBe(false);
  });
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
