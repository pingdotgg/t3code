import { playSnapShotSound } from "../lib/snapShotSound";

/** Plays the short click that tells the user dictation is listening. */
export function playRecordingCue(): void {
  playSnapShotSound("camera-shutter");
}
