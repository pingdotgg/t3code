import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";

import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

import "~/index.css";
import { render } from "../../../test/render";

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "about:blank",
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { GuestHtmlRender } from "../guest/GuestHtmlRender";
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
});

it.each(["inside", "outside", "touch", "sibling", "guest"])(
  "holds sizing until release: %s",
  async (kind) => {
    const outside = kind === "outside" || kind === "sibling" || kind === "guest";
    const border = kind === "guest" ? 2 : 0;
    const url = URL.createObjectURL(
      new Blob(
        [
          injectHtmlRenderBootstrap(`<style>body{margin:0;padding:0}</style><div id="drag" style="height:200px;background:teal;touch-action:none">Drag here</div><script>
    var drag = document.getElementById("drag"), held = false;
    addEventListener("load", function () { parent.postMessage("ready", "*"); });
    drag.addEventListener("pointerdown", function () { held = true; drag.style.height = "300px"; });
    addEventListener("resize", function () { if (held) parent.postMessage("cancelled", "*"); });
    addEventListener("pointerup", function () { held = false; });
  </script>`),
        ],
        { type: "text/html" },
      ),
    );
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    const pin = vi.fn();
    await using screen = await render(
      <>
        {kind === "guest" ? (
          <GuestHtmlRender
            itemId="drag"
            shareId="share"
            reference={{ attachmentId: "attachment", title: "Drag", height: 200 }}
          />
        ) : (
          <HtmlRenderFrame
            environmentId={EnvironmentId.make("environment")}
            htmlRender={{ attachmentId: "attachment", title: "Drag", height: 200 }}
            threadRef={undefined}
            onFullscreenChange={pin}
          />
        )}
        {kind === "sibling" && (
          <HtmlRenderFrame
            environmentId={EnvironmentId.make("environment")}
            htmlRender={{ attachmentId: "sibling", title: "Sibling", height: 200 }}
            threadRef={undefined}
          />
        )}
      </>,
    );
    const frame = screen.container.querySelector("iframe")!;
    frame.src = url;
    const sibling = screen.container.querySelectorAll("iframe")[1];
    if (sibling) sibling.src = url;
    let cancelled = false,
      ready = false,
      siblingReady = !sibling;
    const receive = (event: MessageEvent) => {
      if (sibling && event.source === sibling.contentWindow && event.data === "ready")
        siblingReady = true;
      if (event.source !== frame.contentWindow) return;
      if (kind === "guest" && event.data?.method === "t3/notifications/pointer-held")
        pin(event.data.params.held);
      if (event.data === "cancelled") cancelled = true;
      if (event.data === "ready") ready = true;
    };
    window.addEventListener("message", receive);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", receive) };
    await vi.waitFor(() => expect(ready && siblingReady).toBe(true));
    await vi.waitFor(() => expect(frame.clientHeight).toBe(216 - border));
    const outer = window.frameElement!.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    const x = outer.left + box.left + 30,
      y = outer.top + box.top + 30;
    if (kind === "touch") {
      const first = { x, y, id: 11 };
      await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
      await vi.waitFor(() => expect(pin).toHaveBeenLastCalledWith(true));
      await cdp().send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [first, { x: x + 60, y, id: 12 }],
      });
      await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [first] });
      expect(pin).toHaveBeenLastCalledWith(true);
      expect(frame.clientHeight).toBe(216 - border);
      await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await vi.waitFor(() => expect(pin).toHaveBeenLastCalledWith(true));
      expect(frame.clientHeight).toBe(216 - border);
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y: outside ? outer.top + box.bottom + 30 : y,
        buttons: 1,
      });
      await cdp().send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y: outside ? outer.top + box.bottom + 30 : y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    await vi.waitFor(() => expect(pin).toHaveBeenLastCalledWith(false));
    await vi.waitFor(() => expect(frame.clientHeight).toBe(316 - border));
    if (!outside) expect(cancelled).toBe(false);
  },
);
