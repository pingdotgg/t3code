import {
  DEFAULT_NOTIFICATION_SOUND_SETTINGS,
  type NotificationSoundSettings,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const audio = { currentTime: 0, oscillators: 0 };

class FakeParam {
  value = 0;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = "";
  connect(node: FakeNode) {
    return node;
  }
  start() {}
  stop() {}
}

class FakeAudioContext {
  state = "running";
  destination = new FakeNode();
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return new FakeNode();
  }
  createBiquadFilter() {
    return new FakeNode();
  }
  createOscillator() {
    audio.oscillators += 1;
    return new FakeNode();
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

const sound = (patch: Partial<NotificationSoundSettings> = {}): NotificationSoundSettings => ({
  ...DEFAULT_NOTIFICATION_SOUND_SETTINGS,
  ...patch,
});

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.oscillators = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("plays one jingle for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", sound(), () => true)),
    );
    const once = audio.oscillators;
    expect(once).toBeGreaterThan(0);

    audio.currentTime = 10;
    await playNotificationSound("completion", sound(), () => true);
    expect(audio.oscillators).toBe(once * 2);
  });

  it("still plays an input alert over a completion jingle", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", sound(), () => true);
    const afterCompletion = audio.oscillators;

    await playNotificationSound("input", sound(), () => true);

    expect(audio.oscillators).toBeGreaterThan(afterCompletion);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", sound(), () => false);
    expect(audio.oscillators).toBe(0);

    await playNotificationSound("completion", sound(), () => true);

    expect(audio.oscillators).toBeGreaterThan(0);
  });

  it.each([
    ["muted", sound({ muted: true })],
    ["do not disturb", sound({ doNotDisturb: true })],
    [
      "a disabled event",
      sound({
        events: {
          ...DEFAULT_NOTIFICATION_SOUND_SETTINGS.events,
          completion: { enabled: false, jingle: "soft-chime" },
        },
      }),
    ],
  ])("stays silent when %s", async (_name, settings) => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", settings, () => true);
    expect(audio.oscillators).toBe(0);
  });
});

describe("isDoNotDisturbActive", () => {
  it("ends at its scheduled time", async () => {
    const { isDoNotDisturbActive } = await import("./threadNotifications");
    const until = sound({ doNotDisturb: true, doNotDisturbUntil: "2026-01-01T10:00:00.000Z" });
    expect(isDoNotDisturbActive(until, Date.parse("2026-01-01T09:59:00.000Z"))).toBe(true);
    expect(isDoNotDisturbActive(until, Date.parse("2026-01-01T10:00:01.000Z"))).toBe(false);
    expect(isDoNotDisturbActive(sound({ doNotDisturb: true }))).toBe(true);
    expect(isDoNotDisturbActive(sound())).toBe(false);
  });
});
