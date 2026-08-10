import type { DesktopAgentActivitySource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { visibleDesktopAgentActivities } from "./desktopAgentActivityBridge";

const now = Date.parse("2026-08-10T20:00:00.000Z");

function activity(
  phase: DesktopAgentActivitySource["phase"],
  updatedAt: string,
): DesktopAgentActivitySource {
  return {
    sourceId: "remote-env:thread-1",
    label: "Build Mac · Ship the bridge",
    phase,
    updatedAt,
  };
}

describe("visibleDesktopAgentActivities", () => {
  it("keeps active work regardless of the last thread update", () => {
    const result = visibleDesktopAgentActivities(
      [activity("running", "2026-08-10T10:00:00.000Z")],
      now,
    );

    expect(result).toHaveLength(1);
  });

  it("drops terminal work after the visibility window", () => {
    const result = visibleDesktopAgentActivities(
      [
        activity("completed", "2026-08-10T19:50:00.000Z"),
        activity("failed", "2026-08-10T19:40:00.000Z"),
      ],
      now,
    );

    expect(result.map((item) => item.phase)).toEqual(["completed"]);
  });
});
