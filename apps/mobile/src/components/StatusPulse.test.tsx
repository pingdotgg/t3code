import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { STATUS_PULSE_STEPS } from "./statusPulseCadence";
import { StatusPulse } from "./StatusPulse";

const reanimatedState = vi.hoisted(() => ({
  opacity: { value: 1 },
  reduceMotion: false,
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  makeMutable: () => reanimatedState.opacity,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useReducedMotion: () => reanimatedState.reduceMotion,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let rendered: ReactTestRenderer | undefined;

function renderActivePulse(count = 1) {
  act(() => {
    rendered = create(
      <>
        {Array.from({ length: count }, (_, index) => (
          <StatusPulse active key={index}>
            <></>
          </StatusPulse>
        ))}
      </>,
    );
  });
}

describe("StatusPulse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reanimatedState.opacity.value = 1;
    reanimatedState.reduceMotion = false;
  });

  afterEach(() => {
    if (rendered !== undefined) {
      act(() => rendered?.unmount());
      rendered = undefined;
    }
    vi.useRealTimers();
  });

  it("renders eight discrete timer steps over the documented 1.9 second cadence", () => {
    renderActivePulse();

    expect(vi.getTimerCount()).toBe(1);
    for (const step of STATUS_PULSE_STEPS) {
      act(() => {
        vi.advanceTimersByTime(step.delayMs);
      });
      expect(reanimatedState.opacity.value).toBe(step.opacity);
      expect(vi.getTimerCount()).toBe(1);
    }
  });

  it("shares one timer and keeps pulsing until the last subscriber unmounts", () => {
    renderActivePulse(2);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      rendered?.update(
        <StatusPulse active key={0}>
          <></>
        </StatusPulse>,
      );
    });
    act(() => {
      vi.advanceTimersByTime(STATUS_PULSE_STEPS[0].delayMs);
    });

    expect(reanimatedState.opacity.value).toBe(STATUS_PULSE_STEPS[0].opacity);
    expect(vi.getTimerCount()).toBe(1);

    act(() => rendered?.unmount());
    rendered = undefined;
    expect(reanimatedState.opacity.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not subscribe when reduced motion is enabled", () => {
    reanimatedState.reduceMotion = true;
    renderActivePulse();

    expect(reanimatedState.opacity.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
