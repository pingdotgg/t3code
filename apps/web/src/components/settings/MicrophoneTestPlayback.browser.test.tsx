import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { MicrophoneTestPlayback } from "./MicrophoneTestPlayback";

it("plays, seeks, pauses, and reports playback failures", async () => {
  await using screen = await render(
    <MicrophoneTestPlayback src="" duration={10} onRetry={vi.fn()} onDone={vi.fn()} />,
  );
  const { container } = screen;
  using play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
  });
  using pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
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
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not play this recording. Try recording again.");
});
