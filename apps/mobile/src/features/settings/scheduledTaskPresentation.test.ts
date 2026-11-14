import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { displayedScheduledTaskEnabled } from "./scheduledTaskPresentation";

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
