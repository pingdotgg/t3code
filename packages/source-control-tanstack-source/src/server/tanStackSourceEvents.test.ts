import { describe, expect, it } from "vite-plus/test";

import { frameReader } from "./tanStackSourceEvents.ts";

describe("frameReader", () => {
  it("records the id-only frames Source opens with and reports only frames with an event", () => {
    const cursor = { lastEventId: undefined as string | undefined };
    const read = frameReader(cursor);
    // Captured from `GET /repos/{owner}/{repo}/events?scope=pr&number=4`, then one change.
    const lines = [
      ": ok",
      "",
      "id: 135",
      "",
      "id: 136",
      "event: item",
      'data: {"type":"item"}',
      "",
    ];
    expect(lines.map(read)).toEqual([false, false, false, false, false, false, false, true]);
    expect(cursor.lastEventId).toBe("136");
  });
});
