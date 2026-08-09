import { describe, expect, it, vi } from "vite-plus/test";
import {
  clearTimelineAnchor,
  getAnchoredTurnEndRevealOffset,
  getAnchoredTurnMetrics,
  getRowBottom,
  resolveTimelineRouteEpoch,
  resolveTimelineLiveFollowEnabled,
  updateTimelineLiveFollowState,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("invalidates a deferred reveal when switching routes, including switching back", () => {
    const threadA = "environment-local:thread-a";
    const threadB = "environment-local:thread-b";
    const firstThreadAEpoch = { threadKey: threadA };
    let currentEpoch = firstThreadAEpoch;
    const reveal = vi.fn();
    const deferredReveal = () => {
      if (currentEpoch === firstThreadAEpoch) {
        reveal();
      }
    };

    expect(resolveTimelineRouteEpoch(currentEpoch, threadA)).toBe(firstThreadAEpoch);
    currentEpoch = resolveTimelineRouteEpoch(currentEpoch, threadB);
    deferredReveal();
    currentEpoch = resolveTimelineRouteEpoch(currentEpoch, threadA);
    deferredReveal();

    expect(reveal).not.toHaveBeenCalled();
    expect(currentEpoch).not.toBe(firstThreadAEpoch);
  });

  it("clears send-time anchoring when ordinary bottom-follow resumes", () => {
    const anchored = {
      threadKey: "environment-local:thread-a",
      messageId: "message-a",
    };
    const alreadyCleared = {
      threadKey: anchored.threadKey,
      messageId: null,
    };

    expect(clearTimelineAnchor(anchored)).toEqual({
      threadKey: anchored.threadKey,
      messageId: null,
    });
    expect(clearTimelineAnchor(alreadyCleared)).toBe(alreadyCleared);
  });

  it("starts a different thread at the live edge before its reset effect runs", () => {
    const previousThreadState = {
      threadKey: "environment-local:thread-a",
      enabled: false,
    };
    const nextThreadKey = "environment-local:thread-b";

    expect(
      resolveTimelineLiveFollowEnabled(previousThreadState, previousThreadState.threadKey),
    ).toBe(false);
    expect(resolveTimelineLiveFollowEnabled(previousThreadState, nextThreadKey)).toBe(true);
    expect(updateTimelineLiveFollowState(previousThreadState, nextThreadKey, true)).toEqual({
      threadKey: nextThreadKey,
      enabled: true,
    });
  });

  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("recomputes the reveal target after a buffered assistant row receives its real height", () => {
    const estimatedState = buildState({
      positions: [0, 120],
      sizes: [80, 90],
      scroll: 0,
      scrollLength: 700,
    });
    const measuredState = buildState({
      positions: [0, 120],
      sizes: [80, 1_800],
      scroll: 0,
      scrollLength: 700,
    });
    const input = {
      anchorIndex: 0,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    };

    expect(getAnchoredTurnEndRevealOffset({ ...input, state: estimatedState })).toBeNull();
    expect(getAnchoredTurnEndRevealOffset({ ...input, state: measuredState })).toBe(1_416);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});
