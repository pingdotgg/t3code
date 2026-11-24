import { DEFAULT_READ_ALOUD_SETTINGS, type ReadAloudSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

const playback = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  prepared: Promise.withResolvers<void>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { readAloud: ReadAloudSettings }) => unknown) =>
    select({ readAloud: { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "system" } }),
}));
vi.mock(import("../../speech/readAloud"), async () => {
  const { createReadAloudController } = await import("@t3tools/client-runtime/read-aloud");
  return {
    warmReadAloud: () => {},
    readAloudController: createReadAloudController(async () => {
      await playback.prepared.promise;
      const finished = Promise.withResolvers<void>();
      return {
        play: playback.play,
        pause: playback.pause,
        stop: () => finished.resolve(),
        finished: finished.promise,
      };
    }),
  };
});

import { readAloudController } from "../../speech/readAloud";
import { ReadAloudButton } from "./ReadAloudButton";

/** Gives a test fresh playback spies, and stops what it reads when it ends. */
function readAloudSession(): Disposable {
  playback.prepared = Promise.withResolvers<void>();
  playback.play.mockClear();
  playback.pause.mockClear();
  return { [Symbol.dispose]: () => readAloudController.stop() };
}

it("cancels while speech is made, then pauses, resumes and stops from a separate button", async () => {
  using _session = readAloudSession();
  await using screen = await render(<ReadAloudButton id="reply" text="Hello there." />);
  const stop = screen.getByRole("button", { name: "Stop reading" });

  await screen.getByRole("button", { name: "Read aloud" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Cancel speech generation" }))
    .toBeVisible();
  await expect.element(stop).not.toBeInTheDocument();

  playback.prepared.resolve();
  await screen.getByRole("button", { name: "Pause reading" }).click();
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(readAloudController.getSnapshot().status).toBe("paused");
  await expect.element(stop).toBeVisible();

  await screen.getByRole("button", { name: "Resume reading" }).click();
  await expect.element(screen.getByRole("button", { name: "Pause reading" })).toBeVisible();
  expect(playback.play).toHaveBeenCalledTimes(2);

  await stop.click();
  await expect.element(screen.getByRole("button", { name: "Read aloud" })).toBeVisible();
  await expect.element(stop).not.toBeInTheDocument();
  expect(readAloudController.getSnapshot().status).toBe("idle");
});

it("cancels the first speech generation without offering a separate Stop", async () => {
  using _session = readAloudSession();
  await using screen = await render(<ReadAloudButton id="reply" text="Hello there." />);
  await screen.getByRole("button", { name: "Read aloud" }).click();
  await screen.getByRole("button", { name: "Cancel speech generation" }).click();
  await expect.element(screen.getByRole("button", { name: "Read aloud" })).toBeVisible();
  expect(playback.play).not.toHaveBeenCalled();
});
