import { requireOptionalNativeModule } from "expo";

export const SHOWCASE_SCENES = ["threads", "thread", "terminal", "review", "environments"] as const;
export type ShowcaseScene = (typeof SHOWCASE_SCENES)[number];

interface NativeShowcaseControls {
  readonly getShowcasePairingUrl?: () => string | null;
  readonly getShowcaseScene?: () => string | null;
  readonly prepareShowcaseCapture?: () => void;
  readonly markShowcaseReady?: (scene: ShowcaseScene) => void;
}

function nativeShowcaseControls(): NativeShowcaseControls | null {
  return requireOptionalNativeModule<NativeShowcaseControls>("T3NativeControls");
}

export function getNativeShowcasePairingUrls(): ReadonlyArray<string> {
  try {
    let raw = nativeShowcaseControls()?.getShowcasePairingUrl?.()?.trim();
    if (!raw) return [];
    if (raw.startsWith("json-uri:")) {
      try {
        raw = decodeURIComponent(raw.slice("json-uri:".length));
      } catch {
        return [];
      }
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        );
      }
    } catch {
      // Older runners pass a single URL rather than a JSON array.
    }
    return [raw];
  } catch {
    return [];
  }
}

export function getNativeShowcaseScene(): ShowcaseScene | null {
  try {
    const scene = nativeShowcaseControls()?.getShowcaseScene?.()?.trim();
    return SHOWCASE_SCENES.find((candidate) => candidate === scene) ?? null;
  } catch {
    return null;
  }
}

export function prepareNativeShowcaseCapture(): void {
  try {
    nativeShowcaseControls()?.prepareShowcaseCapture?.();
  } catch {
    // The harness still works when a development build predates this helper.
  }
}

export function markNativeShowcaseReady(scene: ShowcaseScene): void {
  try {
    nativeShowcaseControls()?.markShowcaseReady?.(scene);
  } catch {
    // The readiness marker is capture-runner metadata, never app functionality.
  }
}
