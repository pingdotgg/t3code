import { EnvironmentId } from "@t3tools/contracts";
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

  it("opens at the measured page height before its page reports one", async () => {
    setup();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{
          attachmentId: "tall",
          title: "Tall mockup",
          height: 2000,
          heights: [[728, 3684]],
        }}
        threadRef={undefined}
      />,
    );

    expect(screen.getByTitle("Tall mockup").element().parentElement?.style.height).toBe("3684px");
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
    const sized = (width: number) => {
      const container = document.createElement("div");
      container.style.width = `${width}px`;
      document.body.append(container);
      return { container };
    };

    assetUrl.current = page.url;
    {
      await using first = await render(frame(), sized(600));
      await vi.waitFor(() => expect(frameHeight(first)).toBe("1500px"));
    }

    // A page that never reports its height, so only the remembered measurement can size the frame.
    assetUrl.current = "about:blank";
    {
      await using sameWidth = await render(frame(), sized(600));
      expect(frameHeight(sameWidth)).toBe("1500px");
    }
    await using otherWidth = await render(frame(), sized(400));
    expect(frameHeight(otherWidth)).toBe("200px");
  });
});
