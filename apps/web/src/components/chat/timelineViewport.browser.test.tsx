import { describe, expect, it } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { attachTimelineViewport } from "./timelineViewport";

describe("attachTimelineViewport", () => {
  it("reports an upward scroll only while input is on an embedded frame", async () => {
    // A plain scroller; the viewport needs no routes.
    await using screen = await render(
      <div>
        <div data-testid="outside" style={{ height: 40 }} />
        <div data-testid="timeline" style={{ height: 300, overflowY: "auto" }}>
          <div style={{ height: 1200 }} />
          <iframe
            title="render"
            sandbox=""
            srcDoc="<p>frame</p>"
            style={{ display: "block", height: 200 }}
          />
          <div data-testid="tail" style={{ height: 1200 }} />
        </div>
      </div>,
      { router: false },
    );
    const timeline = screen.getByTestId("timeline").element() as HTMLElement;
    const tail = screen.getByTestId("tail").element() as HTMLElement;
    const scrolled = () =>
      new Promise<void>((resolve) =>
        timeline.addEventListener("scroll", () => resolve(), { once: true }),
      );
    let scroll = scrolled();
    timeline.scrollTop = 1500;
    await scroll;
    // A list that never adjusts its own scroll.
    const list = { getState: () => ({ listen: () => () => {} }) } as unknown as LegendListRef;
    const viewport = attachTimelineViewport(timeline, list);
    const sources: string[] = [];
    viewport.subscribe((navigation) => sources.push(navigation.source));

    await userEvent.hover(screen.getByTestId("outside"));
    scroll = scrolled();
    timeline.scrollTop -= 100;
    await scroll;
    // Content that shrinks and grows back in one task clamps scrollTop with no input at all.
    scroll = scrolled();
    timeline.scrollTop = timeline.scrollHeight;
    await scroll;
    scroll = scrolled();
    tail.style.height = "400px";
    void timeline.scrollTop;
    tail.style.height = "1200px";
    await scroll;
    expect(sources).toEqual([]);

    await userEvent.hover(screen.getByTitle("render"));
    scroll = scrolled();
    timeline.scrollTop -= 100;
    await scroll;
    expect(sources).toEqual(["scroll"]);
    const frame = screen.getByTitle("render").element() as HTMLIFrameElement;
    const resize = (height: number, source: Window | null = frame.contentWindow) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
        }),
      );
    sources.length = 0;
    resize(200);
    resize(400);
    expect(sources).toEqual([]);
    frame.focus();
    resize(400, window);
    resize(400);
    expect(sources).toEqual([]);
    resize(600);
    resize(200);
    expect(sources).toEqual(["command", "command"]);
    viewport.dispose();
    resize(800);
    expect(sources).toEqual(["command", "command"]);
  });
});
