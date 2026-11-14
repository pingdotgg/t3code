import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { OrbitReadyTimelineInput } from "../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../session-logic";
import { withOrbitFirstMessage } from "./useOrbitReady";

const ready = (over: Partial<OrbitReadyTimelineInput> = {}): OrbitReadyTimelineInput =>
  ({
    view: {} as OrbitReadyTimelineInput["view"],
    setup: null,
    threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") },
    messageId: "m-1",
    firstMessage: { text: "Add a meetup page", createdAt: "2026-11-14T22:00:00.000Z" },
    locksComposer: true,
    ...over,
  }) as OrbitReadyTimelineInput;

const message = (id: string): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: "2026-11-14T22:00:01.000Z",
  message: {
    id: MessageId.make(id),
    role: "user",
    text: "loaded",
    runId: null,
    streaming: false,
    createdAt: "2026-11-14T22:00:01.000Z",
    updatedAt: "2026-11-14T22:00:01.000Z",
  },
});

describe("withOrbitFirstMessage", () => {
  it("puts the sent first message in front while nothing is loaded and the Instance is being made", () => {
    const entries = withOrbitFirstMessage([], ready());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "m-1", kind: "message" });
    expect(entries[0]?.kind === "message" && entries[0].message.text).toBe("Add a meetup page");
  });

  it("uses the loaded messages as they are, so the first message never shows twice", () => {
    const loaded = [message("m-1")];
    expect(withOrbitFirstMessage(loaded, ready())).toBe(loaded);
  });

  it("keeps the first message while the thread's messages first load, also after ready", () => {
    const entries = withOrbitFirstMessage([], ready({ locksComposer: false }), true);
    expect(entries).toHaveLength(1);
  });

  it("adds nothing once the Instance is ready (a later empty timeline stays empty)", () => {
    const empty: TimelineEntry[] = [];
    expect(withOrbitFirstMessage(empty, ready({ locksComposer: false }))).toBe(empty);
    expect(withOrbitFirstMessage(empty, null)).toBe(empty);
  });
});
