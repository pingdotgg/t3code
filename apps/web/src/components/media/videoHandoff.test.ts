// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { readVideoHandoff } from "./videoHandoff";

function video(state: {
  readyState: number;
  played: number;
  currentTime?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
}) {
  const element = document.createElement("video");
  Object.defineProperties(element, {
    readyState: { value: state.readyState },
    played: { value: { length: state.played } },
    currentTime: { value: state.currentTime ?? 0 },
    paused: { value: state.paused ?? true },
    ended: { value: false },
  });
  element.volume = state.volume ?? 1;
  element.muted = state.muted ?? false;
  return element;
}

describe("readVideoHandoff", () => {
  it("carries the playhead, play state and volume of a video that played", () => {
    expect(
      readVideoHandoff(
        video({
          readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
          played: 1,
          currentTime: 7.5,
          paused: false,
          volume: 0.25,
          muted: true,
        }),
      ),
    ).toEqual({ startAt: 7.5, playing: true, volume: 0.25, muted: true });
  });

  it("hands nothing over before metadata loads or for a video that never played", () => {
    expect(readVideoHandoff(video({ readyState: HTMLMediaElement.HAVE_NOTHING, played: 1 }))).toBe(
      null,
    );
    expect(
      readVideoHandoff(video({ readyState: HTMLMediaElement.HAVE_ENOUGH_DATA, played: 0 })),
    ).toBe(null);
  });
});
