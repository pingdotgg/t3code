import { MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useStableCallback } from "../../hooks/useStableCallback";
import { attachTimelineViewport, type TimelineViewport } from "./timelineViewport";
import { useTimelineFollow } from "./useTimelineFollow";

const THREAD_KEY = "environment:thread";

function FollowHarness() {
  const legendListRef = useRef<LegendListRef | null>(null);
  const viewportRef = useRef<TimelineViewport | null>(null);
  const [anchor, setAnchor] = useState<{
    threadKey: string | null;
    messageId: MessageId | null;
  }>({ threadKey: null, messageId: null });
  const follow = useTimelineFollow({
    legendListRef,
    composerTimelineInset: 0,
    routeThreadKey: THREAD_KEY,
    activeThreadKey: THREAD_KEY,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: [],
    timelineAnchorMessageId: anchor.messageId,
    setTimelineAnchor: setAnchor,
  });
  const attachViewport = useStableCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const viewport = attachTimelineViewport(node);
    viewportRef.current = viewport;
    const detach = follow.attachTimelineViewport(viewport);
    return () => {
      detach();
      viewport.dispose();
      viewportRef.current = null;
    };
  });
  return (
    <div ref={attachViewport}>
      <output aria-label="Follow mode">
        {follow.timelineLiveFollowEnabled ? "following" : "released"}
      </output>
      <output aria-label="Anchor">{anchor.messageId ?? "none"}</output>
      {follow.showScrollToBottom && <span>Scroll to end</span>}
      <button onClick={() => follow.anchorNewTurn(THREAD_KEY, MessageId.make("first"))}>
        Send
      </button>
      <button
        onClick={() => {
          viewportRef.current?.navigate({ releasesFollow: true });
          follow.onIsAtEndChangeStable(false);
          follow.anchorNewTurn(THREAD_KEY, MessageId.make("while-reading"));
        }}
      >
        Read history and send
      </button>
      <button onClick={() => follow.onIsAtEndChangeStable(true)}>Reach end</button>
    </div>
  );
}

it("anchors sends only while following, reading the mode at send time", async () => {
  await using screen = await render(<FollowHarness />);
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(screen.getByRole("status", { name: "Anchor" })).toHaveTextContent("first");
  await expect
    .element(screen.getByRole("status", { name: "Follow mode" }))
    .toHaveTextContent("following");

  await screen.getByRole("button", { name: "Read history and send" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Follow mode" }))
    .toHaveTextContent("released");
  await expect.element(screen.getByRole("status", { name: "Anchor" })).toHaveTextContent("first");
  await expect.element(screen.getByText("Scroll to end", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Reach end" }).click();
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .element(screen.getByRole("status", { name: "Follow mode" }))
    .toHaveTextContent("following");
  await expect.element(screen.getByRole("status", { name: "Anchor" })).toHaveTextContent("first");
  await expect.element(screen.getByText("Scroll to end", { exact: true })).not.toBeInTheDocument();
});
