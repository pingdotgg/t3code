import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  pendingSnapShotAnimationIdsForTarget,
  scheduleSnapShotAnimationDestination,
  shouldAnimateSnapShotArrival,
  updateSnapShotAnimationSource,
} from "./snapShotAnimation";

describe("window capture animation", () => {
  beforeEach(() => dismissAllSnapShotAnimations());

  it("keeps each reserved composer slot with its target and source", () => {
    const draft = "draft-1" as DraftId;
    const thread = {
      environmentId: "environment-1" as EnvironmentId,
      threadId: "thread-1" as ThreadId,
    } satisfies ScopedThreadRef;
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-08-29T00:00:00.000Z",
      appName: "T3 Code",
      windowTitle: "Capture animation",
    };

    beginSnapShotAnimation("capture-1", draft);
    updateSnapShotAnimationSource("capture-1", source);

    const pending = getPendingSnapShotAnimations();
    expect(pending[0]).toMatchObject({ target: draft });
    expect(pendingSnapShotAnimationIdsForTarget(pending, draft)).toEqual(["capture-1"]);
    expect(pendingSnapShotAnimationIdsForTarget(pending, thread)).toEqual([]);
    expect(pending[0]?.source).toEqual(source);
  });

  it("keeps one card through Strict Mode and the attachment handoff", async () => {
    const start = vi.fn();
    beginSnapShotAnimation("capture-1", "draft-1" as DraftId);

    const stopFirstSetup = scheduleSnapShotAnimationDestination("capture-1", start);
    stopFirstSetup();
    const stopPlaceholder = scheduleSnapShotAnimationDestination("capture-1", start);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    stopPlaceholder();
    const stopAttachment = scheduleSnapShotAnimationDestination("capture-1", start);
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(2);
    expect(getPendingSnapShotAnimations()).toHaveLength(1);
    finishSnapShotAnimation("capture-1");
    stopAttachment();
  });

  it("uses composer arrival feedback only for a fresh capture", () => {
    const now = Date.parse("2026-09-01T12:00:05.000Z");

    expect(shouldAnimateSnapShotArrival("2026-09-01T12:00:02.000Z", now)).toBe(true);
    expect(shouldAnimateSnapShotArrival("2026-09-01T11:59:00.000Z", now)).toBe(false);
    expect(shouldAnimateSnapShotArrival("invalid", now)).toBe(false);
  });
});
