import { EnvironmentId } from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, type Screen } from "../../../test/render";

const assetUrl = vi.hoisted(() => ({ current: "about:blank" }));

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: assetUrl.current,
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

function setup() {
  assetUrl.current = "about:blank";
}

function pageUrl(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
}

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderFrame", () => {
  it("reports leaving full screen when it unmounts while expanded", async () => {
    setup();
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

  it("reopens at the page height it last measured", async () => {
    setup();
    using page = (() => {
      const html = `<script>parent.postMessage(${JSON.stringify(sizeChanged(1500))}, "*");</script>`;
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const frame = () => (
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "measured", title: "Mockup", height: 200 }}
        threadRef={undefined}
      />
    );
    const frameHeight = (screen: Screen) =>
      screen.getByTitle("Mockup").element().parentElement?.style.height;

    assetUrl.current = page.url;
    {
      await using first = await render(frame());
      await vi.waitFor(() => expect(frameHeight(first)).toBe("1500px"));
    }

    // A page that never reports its height, so only the remembered measurement can size the frame.
    assetUrl.current = "about:blank";
    await using second = await render(frame());
    expect(frameHeight(second)).toBe("1500px");
  });

  it("offers Cite for text selected in the page, with the visible text around it", async () => {
    setup();
    // The sandboxed page is out of the test's reach, so it selects its own text once it loads.
    using page = pageUrl(
      injectHtmlRenderBootstrap(
        `<p>Intro line.</p><p id="quote">Quoted words</p><p>Outro.</p><script>getSelection().selectAllChildren(document.getElementById("quote"));</script>`,
      ),
    );
    assetUrl.current = page.url;
    const onCite = vi.fn(() => true);
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "quoted", title: "Notes", height: 200 }}
        threadRef={undefined}
        onCite={onCite}
      />,
    );
    (screen.getByTitle("Notes").element() as HTMLIFrameElement).focus();
    const cite = screen.getByRole("button", { name: "Cite selection in composer" });
    await expect.element(cite).toBeVisible();

    await userEvent.click(cite);
    expect(onCite).toHaveBeenCalledWith({
      text: "Quoted words",
      start: "Intro line.".length,
      end: "Intro line.Quoted words".length,
      prefix: "Intro line.",
      suffix: "Outro.",
    });
    await expect.element(cite).not.toBeInTheDocument();
  });
});
