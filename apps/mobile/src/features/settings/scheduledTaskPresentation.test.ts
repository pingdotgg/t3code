import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  displayedScheduledTaskEnabled,
  formatNextScheduledTaskRun,
} from "./scheduledTaskPresentation";

const id = ScheduledTaskId.make("task-1");

describe("displayedScheduledTaskEnabled", () => {
  it("shows the requested value until the server sends a newer version", () => {
    const requested = { taskId: id, enabled: true, since: "2026-10-30T07:00:00.000Z" };
    expect(
      displayedScheduledTaskEnabled(
        { id, enabled: false, updatedAt: "2026-10-30T07:00:00.000Z" },
        requested,
      ),
    ).toBe(true);
  });

  it("follows the server once a newer version arrives, including another client's change", () => {
    const requested = { taskId: id, enabled: true, since: "2026-10-30T07:00:00.000Z" };
    expect(
      displayedScheduledTaskEnabled(
        { id, enabled: true, updatedAt: "2026-10-30T07:00:01.000Z" },
        requested,
      ),
    ).toBe(true);
    expect(
      displayedScheduledTaskEnabled(
        { id, enabled: false, updatedAt: "2026-10-30T07:05:00.000Z" },
        requested,
      ),
    ).toBe(false);
  });

  it("ignores a request for another task", () => {
    const requested = {
      taskId: ScheduledTaskId.make("task-2"),
      enabled: true,
      since: "2026-10-30T07:00:00.000Z",
    };
    expect(
      displayedScheduledTaskEnabled(
        { id, enabled: false, updatedAt: "2026-10-30T07:00:00.000Z" },
        requested,
      ),
    ).toBe(false);
  });
});

describe("formatNextScheduledTaskRun", () => {
  it("names the rounded unit for a run later today", () => {
    const now = new Date(2026, 10, 3, 10, 0, 0).getTime();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    expect(formatNextScheduledTaskRun(at(59), now)).toBe("Next run in 59 minutes");
    expect(formatNextScheduledTaskRun(at(59.5), now)).toBe("Next run in 1 hour");
    expect(formatNextScheduledTaskRun(at(150), now)).toBe("Next run in 3 hours");
  });
});
