import { requireOptionalNativeModule } from "expo";

import type {
  MobileVoiceAudioSession,
  MobileVoiceAudioSessionEvent,
  MobileVoiceAudioSessionLease,
} from "./realtimeSessionCore";

const VOICE_AUDIO_SESSION_EVENTS = [
  "interruption",
  "route_lost",
  "media_services_reset",
] as const satisfies ReadonlyArray<MobileVoiceAudioSessionEvent>;

const MAX_NATIVE_AUDIO_SESSION_TOKEN = 2_147_483_647;

interface NativeSubscription {
  readonly remove: () => void;
}

interface NativeVoiceAudioSessionModule {
  readonly start: () => number;
  readonly stop: (activationToken: number) => void;
  readonly addListener: (
    eventName: "onVoiceAudioSessionEvent",
    listener: (event: unknown) => void,
  ) => NativeSubscription;
}

interface NativeVoiceAudioSessionEvent {
  readonly kind: MobileVoiceAudioSessionEvent;
  readonly activationToken: number;
}

export type NativeVoiceAudioSessionResolver = () => NativeVoiceAudioSessionModule | null;

function resolveNativeVoiceAudioSession(): NativeVoiceAudioSessionModule | null {
  return requireOptionalNativeModule<NativeVoiceAudioSessionModule>("T3VoiceAudioSession");
}

function readOwnDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    return undefined;
  }
  return descriptor.value;
}

function isActivationToken(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_NATIVE_AUDIO_SESSION_TOKEN
  );
}

function decodeVoiceAudioSessionEvent(value: unknown): NativeVoiceAudioSessionEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const kindValue = readOwnDataProperty(value, "kind");
  const activationToken = readOwnDataProperty(value, "activationToken");
  const kind = VOICE_AUDIO_SESSION_EVENTS.find((event) => event === kindValue);
  if (kind === undefined || !isActivationToken(activationToken)) return null;
  return { kind, activationToken };
}

function removeSubscription(subscription: NativeSubscription): void {
  try {
    subscription.remove();
  } catch {
    // Expo may already have destroyed the native event emitter during shutdown.
  }
}

function stopNativeLease(module: NativeVoiceAudioSessionModule, activationToken: number): void {
  try {
    module.stop(activationToken);
  } catch {
    // Native module destruction also invalidates the token and releases ownership.
  }
}

export function createNativeVoiceAudioSession(
  resolveModule: NativeVoiceAudioSessionResolver = resolveNativeVoiceAudioSession,
): MobileVoiceAudioSession {
  return {
    start: (listener): MobileVoiceAudioSessionLease => {
      const module = resolveModule();
      if (module === null) throw new Error("Voice audio session native module unavailable.");

      let activationToken: number | undefined;
      const subscription = module.addListener("onVoiceAudioSessionEvent", (value) => {
        const event = decodeVoiceAudioSessionEvent(value);
        if (event !== null && event.activationToken === activationToken) listener(event.kind);
      });

      try {
        const token = module.start();
        if (!isActivationToken(token)) {
          if (typeof token === "number" && Number.isSafeInteger(token)) {
            stopNativeLease(module, token);
          }
          throw new Error("Voice audio session returned an invalid activation token.");
        }
        activationToken = token;
      } catch (error) {
        removeSubscription(subscription);
        throw error;
      }

      let stopped = false;
      return Object.freeze({
        stop: () => {
          if (stopped) return;
          stopped = true;
          const token = activationToken;
          activationToken = undefined;
          removeSubscription(subscription);
          if (token !== undefined) stopNativeLease(module, token);
        },
      });
    },
  };
}
