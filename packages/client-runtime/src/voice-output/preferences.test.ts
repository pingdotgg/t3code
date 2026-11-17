import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { speechPlaybackSelection } from "./preferences.ts";

it("distinguishes mixed voices from different synthesis targets without treating inherited voices as different", () => {
  const destination = { environmentId: EnvironmentId.make("speech-a"), engine: "piper" as const };
  const first = { destination, playbackRate: 1 as const };
  expect(
    speechPlaybackSelection([first, { ...first, destination: { ...destination, voice: null } }]),
  ).toEqual({ mixedDestination: false, mixedTarget: false, mixedRate: false });
  expect(
    speechPlaybackSelection([
      first,
      { ...first, destination: { ...destination, voice: "voice-b" } },
    ]),
  ).toEqual({ mixedDestination: true, mixedTarget: false, mixedRate: false });
  expect(
    speechPlaybackSelection([
      first,
      {
        ...first,
        destination: { ...destination, environmentId: EnvironmentId.make("speech-b") },
        playbackRate: 1.5,
      },
    ]),
  ).toEqual({ mixedDestination: true, mixedTarget: true, mixedRate: true });
  expect(
    speechPlaybackSelection([
      { ...first, destination: null },
      { ...first, destination: { engine: "system", environmentId: null } },
    ]).mixedTarget,
  ).toBe(true);
});
