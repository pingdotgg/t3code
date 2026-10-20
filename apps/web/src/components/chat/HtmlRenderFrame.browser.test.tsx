import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import { EnvironmentId } from "@t3tools/contracts";
import {
  htmlRenderTheme,
  HTML_RENDER_DEFAULT_FONTS,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";

import "~/index.css";

import { HtmlRenderFrame } from "./HtmlRenderFrame";

const page = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: page.url,
    expiresAt: Date.now() + 60 * 60_000,
  }),
  useAssetUrlRefresh: () => vi.fn(),
}));
vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  URL.revokeObjectURL(page.url);
});

it("grows past the agent's height to fit the page the client lays out", async () => {
  page.url = URL.createObjectURL(
    new Blob([injectHtmlRenderBootstrap('<div style="height:2345px"></div>')], {
      type: "text/html",
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment-1")}
        htmlRender={{ attachmentId: "html", title: "Tall page", height: 400 }}
        threadRef={undefined}
      />,
    ),
  );

  const box = container.firstElementChild as HTMLElement;
  await expect.poll(() => box.style.height).toBe("2345px");
  expect(box.querySelector("iframe")?.clientHeight).toBe(2345);
});

// Real input, so the press reaches the sandboxed page as a trusted event.
async function mouse(type: "mousePressed" | "mouseReleased", x: number, y: number) {
  const frame = window.frameElement?.getBoundingClientRect();
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: (frame?.left ?? 0) + x,
    y: (frame?.top ?? 0) + y,
    button: "left",
    buttons: type === "mousePressed" ? 1 : 0,
    clickCount: 1,
  });
}

it("keeps its height through a press, so a page's drag survives growing", async () => {
  // Like many drag scripts, the page grows when a drag starts and cancels the
  // drag when its window resizes.
  page.url = URL.createObjectURL(
    new Blob(
      [
        injectHtmlRenderBootstrap(`<div id="list" style="height:200px"></div><script>
          var list = document.getElementById("list"), dragging = false, cancelled = false;
          addEventListener("load", function () { parent.postMessage({ test: "ready" }, "*"); });
          list.addEventListener("pointerdown", function (e) {
            dragging = true;
            list.setPointerCapture(e.pointerId);
            list.style.height = "260px";
            // A size report would be posted in the next frame, so this arrives after it.
            requestAnimationFrame(function () {
              requestAnimationFrame(function () { parent.postMessage({ test: "settled" }, "*"); });
            });
          });
          addEventListener("resize", function () { if (dragging) cancelled = true; });
          addEventListener("pointerup", function () {
            parent.postMessage({ test: "dropped", dragging: dragging, cancelled: cancelled }, "*");
            dragging = false;
          });
        </script>`),
      ],
      { type: "text/html" },
    ),
  );
  // The page's own reports and its size reports, in the order the frame posted them.
  const reports: unknown[] = [];
  const onReport = (event: MessageEvent) => {
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) reports.push({ height });
    else if (typeof (event.data as { test?: unknown } | null)?.test === "string") {
      reports.push(event.data);
    }
  };
  window.addEventListener("message", onReport);
  const fullscreen: boolean[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root!.render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment-1")}
        htmlRender={{ attachmentId: "html", title: "Drag page", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={(value) => fullscreen.push(value)}
      />,
    ),
  );
  const box = container.firstElementChild as HTMLElement;
  await expect.poll(() => reports).toContainEqual({ test: "ready" });

  const rect = box.getBoundingClientRect();
  await mouse("mousePressed", rect.left + 20, rect.top + 20);
  await expect.poll(() => reports).toContainEqual({ test: "settled" });
  expect(reports).not.toContainEqual({ height: 260 });
  // The hold reaches the timeline, which stops following the thread's end.
  await expect.poll(() => fullscreen.at(-1)).toBe(true);
  await mouse("mouseReleased", rect.left + 20, rect.top + 20);

  await expect
    .poll(() => reports)
    .toContainEqual({ test: "dropped", dragging: true, cancelled: false });
  await expect.poll(() => box.style.height).toBe("260px");
  await expect.poll(() => fullscreen.at(-1)).toBe(false);
  window.removeEventListener("message", onReport);
});
