import { describe, expect, it } from "vite-plus/test";

import type { GitHubEvent } from "./events.ts";
import { appendEvent, readEvents } from "./event-log.ts";

const event = {
  version: 1,
  deliveryId: "delivery-1",
  event: "pull_request",
  action: "opened",
  repository: { id: 1, fullName: "pingdotgg/t3code", url: null },
  pullRequestNumbers: [42],
  headSha: "head-sha",
  actor: null,
  receivedAt: null,
  occurredAt: "2026-08-18T12:00:00Z",
  details: {},
} satisfies GitHubEvent;

describe("appendEvent", () => {
  it("assigns ordered sequences and deduplicates github deliveries", () => {
    const first = appendEvent(undefined, event, 100);
    const duplicate = appendEvent(first.state, event, 100);
    const second = appendEvent(
      first.state,
      { ...event, deliveryId: "delivery-2", action: "synchronize" },
      100,
    );

    expect(first.storedEvent?.sequence).toBe(1);
    expect(duplicate).toMatchObject({ duplicate: true, storedEvent: null });
    expect(second.storedEvent?.sequence).toBe(2);
    expect(second.state.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it("bounds retention, filters by pull request, and rejects expired cursors", () => {
    let state = appendEvent(undefined, event, 2).state;
    state = appendEvent(
      state,
      { ...event, deliveryId: "delivery-2", pullRequestNumbers: [43] },
      2,
    ).state;
    state = appendEvent(
      state,
      { ...event, deliveryId: "delivery-3", pullRequestNumbers: [42] },
      2,
    ).state;

    expect(state.events.map(({ sequence }) => sequence)).toEqual([2, 3]);
    expect(readEvents(state, { after: 2, pullRequestNumber: 42 })).toEqual({
      expired: false,
      future: false,
      earliestSequence: 2,
      latestSequence: 3,
      events: [state.events[1]],
    });
    expect(readEvents(state, { after: 0 })).toMatchObject({
      expired: true,
      future: false,
      earliestSequence: 2,
    });
    expect(readEvents(state, { after: 4 })).toMatchObject({
      expired: false,
      future: true,
      latestSequence: 3,
      events: [],
    });
  });
});
