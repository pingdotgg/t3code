import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  __resetAudioContextForTests,
  playTurnCompletionSound,
  playTurnErrorSound,
} from "./turnChime";

describe("turnChime", () => {
  let createdOscillators: Array<{
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  beforeEach(() => {
    __resetAudioContextForTests();
    createdOscillators = [];
    const mockGainNode = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    class MockAudioContext {
      state = "running";
      currentTime = 10;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      createGain = vi.fn().mockReturnValue(mockGainNode);
      createOscillator = vi.fn().mockImplementation(() => {
        const osc = {
          type: "sine",
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        createdOscillators.push(osc);
        return osc;
      });
    }

    vi.stubGlobal("AudioContext", MockAudioContext);
  });

  it("plays a two-tone chime when called", () => {
    playTurnCompletionSound("chime");
    expect(createdOscillators.length).toBe(2);
    expect(createdOscillators[0]?.start).toHaveBeenCalledWith(10);
    expect(createdOscillators[1]?.start).toHaveBeenCalledWith(10.08);
  });

  it("plays bell sound preset", () => {
    playTurnCompletionSound("bell");
    expect(createdOscillators.length).toBe(1);
    expect(createdOscillators[0]?.start).toHaveBeenCalledWith(10);
  });

  it("plays marimba sound preset", () => {
    playTurnCompletionSound("marimba");
    expect(createdOscillators.length).toBe(3);
  });

  it("plays pop sound preset", () => {
    playTurnCompletionSound("pop");
    expect(createdOscillators.length).toBe(1);
  });

  it("plays descending error sound", () => {
    playTurnErrorSound("descending");
    expect(createdOscillators.length).toBe(2);
    expect(createdOscillators[0]?.start).toHaveBeenCalledWith(10);
    expect(createdOscillators[1]?.start).toHaveBeenCalledWith(10.09);
  });

  it("plays chord error sound preset", () => {
    playTurnErrorSound("chord");
    expect(createdOscillators.length).toBe(3);
  });

  it("plays subtle error sound preset", () => {
    playTurnErrorSound("subtle");
    expect(createdOscillators.length).toBe(1);
  });

  it("plays buzz error sound preset", () => {
    playTurnErrorSound("buzz");
    expect(createdOscillators.length).toBe(2);
  });
});
