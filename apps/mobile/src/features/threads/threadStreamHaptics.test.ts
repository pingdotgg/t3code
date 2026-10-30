import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));

import { shouldTickStreamHaptic } from "./threadStreamHaptics";

const mark = (id: string, textLength: number) => ({ id, textLength });

describe("shouldTickStreamHaptic", () => {
  it("ticks for a new stream even inside the throttle window", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a", 40),
        latest: mark("b", 1),
        lastTickAt: 0,
        now: 10,
      }),
    ).toBe(true);
    expect(
      shouldTickStreamHaptic({ previous: null, latest: mark("a", 1), lastTickAt: 0, now: 10 }),
    ).toBe(true);
  });

  it("throttles growth of the same stream", () => {
    const growth = { previous: mark("a", 10), latest: mark("a", 20), lastTickAt: 1_000 };
    expect(shouldTickStreamHaptic({ ...growth, now: 1_200 })).toBe(false);
    expect(shouldTickStreamHaptic({ ...growth, now: 1_320 })).toBe(true);
  });

  it("stays quiet when nothing streams or the text did not grow", () => {
    expect(
      shouldTickStreamHaptic({ previous: mark("a", 10), latest: null, lastTickAt: 0, now: 5_000 }),
    ).toBe(false);
    expect(
      shouldTickStreamHaptic({
        previous: mark("a", 10),
        latest: mark("a", 10),
        lastTickAt: 0,
        now: 5_000,
      }),
    ).toBe(false);
  });
});
