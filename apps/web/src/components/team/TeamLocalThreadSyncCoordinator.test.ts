import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { m } from "~/i18n/messages";
import {
  clearLocalThreadAccess,
  prepareTeamThreadAccess,
  readLocalThreadAccess,
} from "~/state/team";
import {
  formatTeamThreadEnvBlockReason,
  teamInaccessibleEnvironmentBannerItem,
} from "./teamComposerBanner";
import {
  createStreamingSyncThrottleController,
  STREAMING_SYNC_THROTTLE_MS,
} from "./TeamLocalThreadSyncCoordinator";

describe("TeamLocalThreadSyncCoordinator streaming throttle (P2-11)", () => {
  it("flushes immediately on turn start, coalesces rapid streaming deltas, and flushes immediately on terminal state / visibility / unmount", () => {
    vi.useFakeTimers();
    try {
      let nowMs = 10_000;
      const flushes: Array<{ readonly key: string; readonly at: number }> = [];
      const controller = createStreamingSyncThrottleController({
        throttleMs: STREAMING_SYNC_THROTTLE_MS,
        now: () => nowMs,
        onFlush: (key) => {
          flushes.push({ key, at: nowMs });
        },
      });

      const key = "team-env\0thread-1";

      // 1. Turn starts (inactive -> active): flushes immediately (leading sync).
      controller.schedule(key, { isActive: true });
      expect(flushes).toHaveLength(1);
      expect(flushes[0]?.at).toBe(10_000);

      // 2. Rapid burst of 10 streaming deltas over 300ms: coalesced into zero immediate RPCs.
      for (let i = 1; i <= 10; i += 1) {
        nowMs += 30;
        controller.schedule(key, { isActive: true });
      }
      expect(flushes).toHaveLength(1);

      // 3. Advancing past the trailing throttle window (720ms from first delta at 10_030) fires exactly 1 trailing flush.
      nowMs = 10_750;
      vi.advanceTimersByTime(720);
      expect(flushes).toHaveLength(2);
      expect(flushes[1]?.at).toBe(10_750);

      // 4. Another delta schedules a trailing timer, then turn completes (isActive: false) -> flushes immediately!
      nowMs = 10_850;
      controller.schedule(key, { isActive: true });
      expect(flushes).toHaveLength(2);

      nowMs = 10_900;
      controller.schedule(key, { isActive: false });
      expect(flushes).toHaveLength(3);
      expect(flushes[2]?.at).toBe(10_900);

      // Advancing time after terminal flush does NOT trigger a duplicate trailing flush.
      nowMs = 12_000;
      vi.advanceTimersByTime(2_000);
      expect(flushes).toHaveLength(3);

      // 5. Next turn starts -> immediate leading flush, then mid-stream delta -> flushed immediately on visibility hide.
      controller.schedule(key, { isActive: true });
      expect(flushes).toHaveLength(4);
      nowMs = 12_100;
      controller.schedule(key, { isActive: true });
      expect(flushes).toHaveLength(4);
      controller.flushAllPending();
      expect(flushes).toHaveLength(5);

      // 6. Another pending delta is flushed on dispose (unmount).
      nowMs = 12_200;
      controller.schedule(key, { isActive: true });
      expect(flushes).toHaveLength(5);
      controller.dispose();
      expect(flushes).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Team creator-aware own_local_mirror banner (P1-7)", () => {
  it("renders creator-aware copy with Open local thread button instead of other_member_local", () => {
    const onOpenLocalThread = vi.fn();
    const onForkThread = vi.fn();
    const onEnterNoteMode = vi.fn();

    const connectedBanner = teamInaccessibleEnvironmentBannerItem({
      envAccess: {
        canExecute: false,
        reason: "own_local_mirror",
        environmentLabel: "Alice Laptop",
      },
      ownerPseudo: "alice",
      environmentLabel: "Alice Laptop",
      canLeaveNote: false,
      onOpenLocalThread,
      onForkThread,
      onEnterNoteMode,
      resolve: m,
    });
    expect(connectedBanner).not.toBeNull();
    expect(connectedBanner?.variant).toBe("info");
    expect(connectedBanner?.description).toContain("your local environment (Alice Laptop)");
    expect(connectedBanner?.description).toContain("Open the live local thread");
    expect(connectedBanner?.description).not.toContain("alice's local machine");

    const offlineReason = formatTeamThreadEnvBlockReason(
      {
        canExecute: false,
        reason: "own_local_mirror",
        environmentLabel: "Alice Laptop",
      },
      "alice",
      m,
      { canOpenLocalThread: false },
    );
    expect(offlineReason).toContain("not connected here");

    const colleagueReason = formatTeamThreadEnvBlockReason(
      {
        canExecute: false,
        reason: "other_member_local",
        environmentLabel: "Alice Laptop",
      },
      "alice",
      m,
    );
    expect(colleagueReason).toContain("alice's local machine");
  });
});

describe("Local thread access", () => {
  it("keeps the local mirror's destination, View and Lock together", () => {
    const local = EnvironmentId.make("local");
    const team = EnvironmentId.make("team");
    const thread = ThreadId.make("thread-lock-a");
    const access = { teamEnvironmentId: team, viewId: null, locked: true };
    expect(prepareTeamThreadAccess(local, thread, access)).toEqual({});
    expect(readLocalThreadAccess(local, thread)).toEqual(access);
    expect(readLocalThreadAccess(team, thread)).toBeNull();
    clearLocalThreadAccess(local, thread);
    expect(readLocalThreadAccess(local, thread)).toBeNull();
  });
});
