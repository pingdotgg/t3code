import { describe, expect, it } from "vite-plus/test";
import {
  delayedStatusDeadline,
  shownDelayedStatus,
  stepDelayedStatus,
  type DelayedStatusState,
} from "./delayedStatus.ts";

function step(
  state: DelayedStatusState<string> | null,
  value: string | null,
  now: number,
  key = "thread-1",
) {
  const deadline = state === null ? null : delayedStatusDeadline(state);
  return stepDelayedStatus(
    state,
    { key, value, deadlinePassed: deadline !== null && now >= deadline },
    () => now,
  );
}

describe("stepDelayedStatus", () => {
  it("shows a status only after it stays set for the show delay", () => {
    const pending = step(null, "syncing", 0);
    expect(delayedStatusDeadline(pending)).toBe(400);
    expect(step(pending, "syncing", 399)).toBe(pending);
    const shown = step(pending, "syncing", 400);
    expect(shownDelayedStatus(shown, "thread-1")).toBe("syncing");
    const slow = stepDelayedStatus(
      null,
      { key: "thread-1", value: "failed", deadlinePassed: false, showDelayMs: 5_000 },
      () => 0,
    );
    expect(delayedStatusDeadline(slow)).toBe(5_000);
    expect(shownDelayedStatus(step(slow, "failed", 4_999), "thread-1")).toBeNull();
    expect(shownDelayedStatus(step(slow, "failed", 5_000), "thread-1")).toBe("failed");
    expect(step(slow, null, 200).phase).toBe("idle");
  });

  it("never shows a status that clears before the show delay", () => {
    const pending = step(null, "syncing", 0);
    const cleared = step(pending, null, 200);
    expect(cleared.phase).toBe("idle");
    expect(delayedStatusDeadline(step(cleared, "syncing", 300))).toBe(700);
  });

  it("shows the latest value when the show delay passes", () => {
    const pending = step(null, "connecting", 0);
    const changed = step(pending, "syncing", 200);
    expect(changed).toBe(pending);
    expect(shownDelayedStatus(step(changed, "syncing", 400), "thread-1")).toBe("syncing");
  });

  it("holds a shown status for the minimum visible time after it clears", () => {
    const shown = step(step(null, "syncing", 0), "syncing", 400);
    expect(delayedStatusDeadline(shown)).toBe(800);
    expect(step(shown, null, 500)).toBe(shown);
    expect(step(shown, null, 800).phase).toBe("idle");
  });

  it("hides immediately once the minimum visible time has passed", () => {
    const shown = step(step(null, "syncing", 0), "syncing", 400);
    expect(step(shown, "syncing", 900)).toBe(shown);
    expect(step(shown, null, 1000).phase).toBe("idle");
  });

  it("restarts the minimum visible time when the shown value changes", () => {
    const shown = step(step(null, "syncing", 0), "syncing", 400);
    const replaced = step(shown, "replaying", 600);
    expect(shownDelayedStatus(replaced, "thread-1")).toBe("replaying");
    expect(delayedStatusDeadline(replaced)).toBe(1000);
  });

  it("hides the status and restarts the delay when the key changes", () => {
    const shown = step(step(null, "syncing", 0), "syncing", 400);
    expect(shownDelayedStatus(shown, "thread-2")).toBeNull();
    const other = step(shown, "syncing", 500, "thread-2");
    expect(shownDelayedStatus(other, "thread-2")).toBeNull();
    expect(delayedStatusDeadline(other)).toBe(900);
    const cleared = step(shown, null, 500, "cleared");
    expect(shownDelayedStatus(cleared, "cleared")).toBeNull();
    const retry = stepDelayedStatus(
      cleared,
      { key: "thread-1", value: "failed", deadlinePassed: false, showDelayMs: 5_000 },
      () => 501,
    );
    expect(shownDelayedStatus(retry, "thread-1")).toBeNull();
    expect(delayedStatusDeadline(retry)).toBe(5_501);
  });
});
