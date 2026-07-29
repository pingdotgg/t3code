import { describe, expect, it, vi } from "vite-plus/test";

import { replayInteractionSound } from "./interactionSoundPlayback";

describe("mobile interaction sounds", () => {
  it("starts a fresh player without seeking", async () => {
    const player = {
      currentTime: 0,
      play: vi.fn(),
      seekTo: vi.fn(() => Promise.resolve()),
    };

    await replayInteractionSound(player);

    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it("rewinds a previously played cue before replaying it", async () => {
    const calls: string[] = [];
    const player = {
      currentTime: 0.4,
      play: vi.fn(() => {
        calls.push("play");
      }),
      seekTo: vi.fn(async () => {
        calls.push("seek");
      }),
    };

    await replayInteractionSound(player);

    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(calls).toEqual(["seek", "play"]);
  });
});
