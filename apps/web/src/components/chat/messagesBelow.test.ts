import { describe, expect, it, vi } from "vite-plus/test";
import { countTimelineMessagesBelow } from "./MessagesTimeline.logic";

describe("countTimelineMessagesBelow", () => {
  const state = {
    scroll: 0,
    scrollLength: 400,
    positionAtIndex: (index: number) => index * 100,
    sizeAtIndex: () => 100,
  };

  it("counts only indexed messages, including one partly obscured by the composer", () => {
    // Rows 1 and 3 are tool activity, not messages.
    expect(countTimelineMessagesBelow([0, 2, 4, 5], state, 150)).toBe(3);
    expect(countTimelineMessagesBelow([0, 2, 4, 5], { ...state, scroll: 50 }, 150)).toBe(2);
  });

  it("decreases while scrolling down and increases when scrolling back up", () => {
    const indices = [0, 1, 2, 3, 4, 5];
    expect(countTimelineMessagesBelow(indices, state, 100)).toBe(3);
    expect(countTimelineMessagesBelow(indices, { ...state, scroll: 200 }, 100)).toBe(1);
    expect(countTimelineMessagesBelow(indices, { ...state, scroll: 300 }, 100)).toBe(0);
    expect(countTimelineMessagesBelow(indices, state, 100)).toBe(3);
  });

  it("updates for appended messages, streaming growth, and viewport or composer resizing", () => {
    expect(countTimelineMessagesBelow([0, 1, 2], state, 100)).toBe(0);
    expect(countTimelineMessagesBelow([0, 1, 2, 3], state, 100)).toBe(1);
    expect(countTimelineMessagesBelow([0, 1, 2], { ...state, sizeAtIndex: () => 150 }, 100)).toBe(
      1,
    );
    expect(countTimelineMessagesBelow([0, 1, 2], { ...state, scrollLength: 250 }, 100)).toBe(2);
    expect(countTimelineMessagesBelow([0, 1, 2], state, 250)).toBe(2);
  });

  it("accounts for the header and actual overlay rather than reserved footer space", () => {
    const indices = [0, 1, 2, 3];
    expect(countTimelineMessagesBelow(indices, state, 110, 24)).toBe(2);
    expect(countTimelineMessagesBelow(indices, { ...state, scroll: 35 }, 110, 24)).toBe(1);
    // A collapsed composer leaves reserved scroll space, but no longer obscures that area.
    expect(countTimelineMessagesBelow(indices, state, 204, 24)).toBe(3);
  });

  it("does not count blank end space or an empty timeline", () => {
    expect(countTimelineMessagesBelow([0, 1], { ...state, scroll: 500 }, 100)).toBe(0);
    expect(countTimelineMessagesBelow([], state, 100)).toBe(0);
  });

  it("waits for valid measurements and tolerates fractional pixel rounding", () => {
    expect(countTimelineMessagesBelow([0], undefined, 100)).toBe(0);
    expect(countTimelineMessagesBelow([0], {}, 100)).toBe(0);
    expect(countTimelineMessagesBelow([0], { ...state, sizeAtIndex: () => undefined }, 100)).toBe(
      0,
    );
    expect(countTimelineMessagesBelow([0], { ...state, positionAtIndex: () => NaN }, 100)).toBe(0);
    expect(countTimelineMessagesBelow([0, 1, 2], { ...state, scroll: -0.5 }, 100)).toBe(0);
  });

  it("counts virtualized rows whose sizes have not been measured yet", () => {
    expect(
      countTimelineMessagesBelow(
        [0, 1, 2, 3, 4, 5],
        {
          ...state,
          sizeAtIndex: () => undefined,
        },
        150,
      ),
    ).toBe(4);
  });

  it.each([undefined, NaN, Infinity, -Infinity])(
    "falls back to the next row for an invalid height: %s",
    (height) => {
      const unmeasured = {
        ...state,
        positionAtIndex: (index: number) => 200 + index * 100,
        sizeAtIndex: () => height,
      };
      expect(countTimelineMessagesBelow([0], unmeasured, 150)).toBe(1);
      expect(countTimelineMessagesBelow([0], { ...unmeasured, scroll: 100 }, 150)).toBe(0);
    },
  );

  it.each([undefined, NaN, Infinity, -Infinity])(
    "falls back to the row top when the next position is invalid: %s",
    (nextPosition) => {
      const unmeasured = {
        ...state,
        positionAtIndex: (index: number) => (index === 0 ? 300 : nextPosition),
        sizeAtIndex: () => NaN,
      };
      expect(countTimelineMessagesBelow([0], unmeasured, 150)).toBe(1);
      expect(countTimelineMessagesBelow([0], { ...unmeasured, scroll: 100 }, 150)).toBe(0);
    },
  );

  it("uses logarithmic cached position reads for long histories", () => {
    const indices = Array.from({ length: 10_000 }, (_, index) => index);
    const positionAtIndex = vi.fn(state.positionAtIndex);
    expect(countTimelineMessagesBelow(indices, { ...state, positionAtIndex }, 100)).toBe(9997);
    expect(positionAtIndex.mock.calls.length).toBeLessThanOrEqual(14);
  });
});
