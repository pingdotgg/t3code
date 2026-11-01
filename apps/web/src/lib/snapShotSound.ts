import type { SnapShotSound } from "@t3tools/contracts";

import snapShotClickUrl from "../assets/snap-shot-click.mp3?url";
import snapShotWhooshUrl from "../assets/snap-shot-whoosh.mp3?url";

export function playSnapShotSound(sound: SnapShotSound): void {
  const audio = new Audio(sound === "soft-pop" ? snapShotWhooshUrl : snapShotClickUrl);
  audio.preload = "auto";
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}
