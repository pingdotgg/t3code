import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { MicrophoneTestPlayback } from "./MicrophoneTestPlayback";

it("plays, seeks, pauses, and reports playback failures", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
  try {
    await act(async () =>
      root.render(
        <MicrophoneTestPlayback src="" duration={10} onRetry={vi.fn()} onDone={vi.fn()} />,
      ),
    );
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    await userEvent.click(button("Play recording"));
    expect(play).toHaveBeenCalledTimes(1);
    const audio = container.querySelector("audio")!;
    const slider = container.querySelector("input")!;
    await userEvent.click(slider);
    await userEvent.keyboard("{Home}{ArrowRight}");
    expect(audio.currentTime).toBeGreaterThan(0);
    expect(button("Pause recording")).not.toBeNull();
    await userEvent.click(button("Pause recording"));
    expect(pause).toHaveBeenCalledTimes(1);
    play.mockRejectedValueOnce(new Error("Playback failed"));
    await userEvent.click(button("Play recording"));
    await expect
      .poll(() => container.querySelector('[role="alert"]')?.textContent)
      .toContain("Could not play");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
