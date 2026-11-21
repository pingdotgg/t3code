import { describe, expect, it } from "vite-plus/test";

import { usageCrossings, usageReadings } from "./usageNotice";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const claude = (weekly: number, session: number) => [
  {
    id: "weekly",
    kind: "weekly" as const,
    label: "Weekly",
    usedPercent: weekly,
    resetsAt: "2026-11-26T22:00:00Z",
  },
  {
    id: "session",
    kind: "session" as const,
    label: "Session",
    usedPercent: session,
    resetsAt: "2026-11-21T03:12:00Z",
  },
];

describe("usage notices", () => {
  it("Given weekly usage that rises from 78 to 82 percent, when the readings are compared, then one message names the window and the 80 percent level", () => {
    const messages = usageCrossings(
      usageReadings("Claude", claude(78, 10), NOW),
      usageReadings("Claude", claude(82, 12), NOW),
    );
    expect(messages).toEqual([
      "Usage notice: Claude weekly 82%, resets in 5d 22h. It passed 80 percent.",
    ]);
  });

  it("Given usage that moves without crossing a level, when the readings are compared, then there is no message", () => {
    expect(
      usageCrossings(
        usageReadings("Claude", claude(51, 10), NOW),
        usageReadings("Claude", claude(79, 49), NOW),
      ),
    ).toEqual([]);
  });
});
