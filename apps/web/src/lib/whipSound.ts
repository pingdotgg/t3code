import whipCrackUrl from "../assets/whip-crack.mp3?url";

/**
 * The whip crack: a CC0 sample (see third-party-licenses.config.json),
 * normalized at build time so a plain <audio> element hits hard enough. One
 * element, restarted on each crack; a new crack cuts the previous one.
 */
let crack: HTMLAudioElement | undefined;

export function playWhipCrack(): void {
  if (typeof Audio === "undefined") return;
  crack ??= new Audio(whipCrackUrl);
  crack.currentTime = 0;
  void crack.play().catch(() => undefined);
}
