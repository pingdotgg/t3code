import type { SpeechOutputDestination, SpeechPlaybackRate } from "@t3tools/contracts";

export function speechPlaybackSelection(
  preferences: readonly {
    destination: SpeechOutputDestination | null;
    playbackRate: SpeechPlaybackRate;
  }[],
) {
  const target = (destination: SpeechOutputDestination | null) =>
    destination ? `${destination.engine}:${destination.environmentId}` : "off";
  const full = (destination: SpeechOutputDestination | null) =>
    JSON.stringify([target(destination), destination?.voice ?? null]);
  const first = preferences[0];
  return {
    mixedDestination: preferences.some(
      (value) => full(value.destination) !== full(first?.destination ?? null),
    ),
    mixedTarget: preferences.some(
      (value) => target(value.destination) !== target(first?.destination ?? null),
    ),
    mixedRate: preferences.some((value) => value.playbackRate !== first?.playbackRate),
  };
}
