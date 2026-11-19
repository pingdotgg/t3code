import type {
  EnvironmentId,
  NotificationJingleId,
  NotificationSoundEvent,
  NotificationSoundSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { msg } from "gt-react";

import { playJingle } from "./notificationJingles";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: msg("Off", { $context: "notification setting, no notifications or sound" }),
  notifications: msg("Notifications only"),
  sound: msg("Sound only"),
  "notifications-and-sound": msg("Notifications with sound"),
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

const TAG_HASH_OFFSET_BASIS = 0xcbf29ce484222325n;
const TAG_HASH_PRIME = 0x100000001b3n;
const TAG_HASH_MASK = 0xffffffffffffffffn;

/** Windows drops toast notifications with the 73-character environment/thread tag. */
export function threadNotificationTag(environmentId: EnvironmentId, threadId: ThreadId): string {
  const key = `${environmentId}:${threadId}`;
  let hash = TAG_HASH_OFFSET_BASIS;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index));
    hash = (hash * TAG_HASH_PRIME) & TAG_HASH_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
/** When each event's current jingle ends, on the audio context's clock. */
const playingUntil = new Map<NotificationSoundEvent, number>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

/** Do Not Disturb is on, and its end time (if any) has not passed. */
export function isDoNotDisturbActive(sound: NotificationSoundSettings, now = Date.now()): boolean {
  if (!sound.doNotDisturb) return false;
  if (sound.doNotDisturbUntil === null) return true;
  const until = Date.parse(sound.doNotDisturbUntil);
  return !Number.isFinite(until) || until > now;
}

export function notificationEventAudible(
  sound: NotificationSoundSettings,
  event: NotificationSoundEvent,
  now = Date.now(),
): boolean {
  return !sound.muted && sound.events[event].enabled && !isDoNotDisturbActive(sound, now);
}

/**
 * Plays the jingle chosen for `event`. Bursts of the same event (threads finishing together)
 * play once; different events keep separate slots so an input request is never swallowed.
 */
export async function playNotificationSound(
  event: NotificationSoundEvent,
  sound: NotificationSoundSettings,
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  if (!notificationEventAudible(sound, event)) return;
  const context = audioContext;
  // Yield once so alerts raised in the same tick coalesce before anything is scheduled.
  await Promise.resolve();
  if (!shouldPlay() || context.state !== "running") return;
  if (context.currentTime < (playingUntil.get(event) ?? 0)) return;
  playingUntil.set(event, playJingle(context, sound.events[event].jingle, sound.volume));
}

/** Settings preview: plays a jingle now, unlocking audio since this runs from a click. */
export function previewNotificationJingle(jingle: NotificationJingleId, volume: number) {
  unlockNotificationAudio();
  if (audioContext) playJingle(audioContext, jingle, volume);
}
