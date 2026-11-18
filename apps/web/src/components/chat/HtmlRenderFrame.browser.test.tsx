import { EnvironmentId } from "@t3tools/contracts";
import { HTML_RENDER_MAX_FIT_HEIGHT } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";

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

// A real gesture, so Chromium picks the element that scrolls as it would for a trackpad swipe.
async function swipeDown(element: Element) {
  const box = element.getBoundingClientRect();
  const tester = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  await cdp().send("Input.synthesizeScrollGesture", {
    x: tester.left + box.left + box.width / 2,
    y: tester.top + box.top + 50,
    yDistance: -150,
    gestureSourceType: "mouse",
    preventFling: true,
  });
}

async function renderInThread(page: string) {
  assetUrl.current = `data:text/html,${encodeURIComponent(page)}`;
  const container = document.createElement("div");
  // Load does not bubble, but the container sees it while capturing, from before the frame exists.
  const loaded = new Promise((resolve) =>
    container.addEventListener("load", resolve, { capture: true, once: true }),
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <div data-testid="thread" className="h-[300px] overflow-auto">
        <HtmlRenderFrame
          environmentId={EnvironmentId.make("environment")}
          htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
          threadRef={undefined}
        />
        <div className="h-[1000px]" />
      </div>,
      { container },
    ),
  );
  await loaded;
  const thread = screen.getByTestId("thread").element();
  const frame = screen.getByTitle("Report").element();
  stack.move();
  return { screen, thread, frame };
}

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

  it("hands a swipe over a fitted page to the thread, but lets a page past the fit cap scroll", async () => {
    setup();
    // Half a pixel taller than its 200px frame, as rounding leaves some pages.
    {
      const fitted = await renderInThread('<body style="margin:0;height:200.5px">');
      await using _screen = fitted.screen;
      await swipeDown(fitted.frame);
      await vi.waitFor(() => expect(fitted.thread.scrollTop).toBeGreaterThan(0));
    }

    const tall = await renderInThread(
      `<body style="margin:0;height:30000px"><script>parent.postMessage(${JSON.stringify(sizeChanged(30000))}, "*");</script>`,
    );
    await using _screen = tall.screen;
    await vi.waitFor(() =>
      expect(tall.frame.getBoundingClientRect().height).toBe(HTML_RENDER_MAX_FIT_HEIGHT),
    );
    await swipeDown(tall.frame);
    expect(tall.thread.scrollTop).toBe(0);
  });
});
