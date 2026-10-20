import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  htmlRenderTheme,
  HTML_RENDER_DEFAULT_FONTS,
  injectHtmlRenderBootstrap,
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
