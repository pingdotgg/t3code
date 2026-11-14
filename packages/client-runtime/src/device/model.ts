import type { DevicePlatform } from "@t3tools/contracts";

const MODEL_NAMES = {
  "iphone-duo": ["iPhone Duo"],
  "iphone-18-pro": ["iPhone 18 Pro"],
  "iphone-18-pro-max": ["iPhone 18 Pro Max"],
  "iphone-17-pro": ["iPhone 17 Pro"],
  "iphone-17-pro-max": ["iPhone 17 Pro Max"],
  "iphone-17": ["iPhone 17"],
  "iphone-air": ["iPhone Air"],
  // The 16e shares the 17e's body and display.
  "iphone-17e": ["iPhone 17e", "iPhone 16e"],
  // The 14 Pro and 15 Pro share the 16 Pro's square triple-camera back and display aspect.
  "iphone-16-pro": ["iPhone 16 Pro", "iPhone 15 Pro", "iPhone 14 Pro"],
  "iphone-16-pro-max": ["iPhone 16 Pro Max", "iPhone 15 Pro Max", "iPhone 14 Pro Max"],
  "iphone-16": ["iPhone 16"],
  "iphone-16-plus": ["iPhone 16 Plus"],
  "iphone-15": ["iPhone 15"],
  "iphone-15-plus": ["iPhone 15 Plus"],
  "iphone-14": ["iPhone 14"],
  "iphone-14-plus": ["iPhone 14 Plus"],
  "ipad-pro-13-m5": ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)"],
} as const;

export type DeviceModelId = keyof typeof MODEL_NAMES;

export interface DeviceModelSource {
  readonly id: DeviceModelId;
  readonly url: string;
}

export interface DeviceAccessorySource {
  readonly id: "ipad-pro-13-m5-magic-keyboard";
  readonly modelId: "ipad-pro-13-m5";
  readonly url: string;
}

export type DeviceAssetSource = DeviceModelSource | DeviceAccessorySource;

const modelByName = new Map<string, DeviceModelId>(
  Object.entries(MODEL_NAMES).flatMap(([id, names]) =>
    names.map((name) => [name.toLowerCase(), id as DeviceModelId] as const),
  ),
);

/** Matches a hardware name; simulator types can add a memory suffix such as " (16GB)". */
export function resolveDeviceModelId(platform: DevicePlatform, name: string): DeviceModelId | null {
  if (platform !== "ios") return null;
  return modelByName.get(name.replace(/ \(\d+GB\)$/i, "").toLowerCase()) ?? null;
}

/** Each request owns its result. A cancelled or superseded parse must still release its resources. */
export function createDeviceModelSlot<
  T extends { dispose: () => void },
  Source extends DeviceAssetSource = DeviceModelSource,
>(options: {
  load: (source: Source, signal: AbortSignal) => Promise<T>;
  install: (model: T | null) => void;
  onError?: ((cause: unknown) => void) | undefined;
}) {
  let request: { source: Source; controller: AbortController } | null = null;
  let current: T | null = null;
  let disposed = false;
  const clear = () => {
    if (current) options.install(null);
    current?.dispose();
    current = null;
  };
  return {
    set(source: Source | null) {
      if (disposed) return;
      if (source?.id === request?.source.id && source?.url === request?.source.url) return;
      request?.controller.abort();
      request = null;
      clear();
      if (!source) return;
      const next = { source, controller: new AbortController() };
      request = next;
      void options.load(source, next.controller.signal).then(
        (model) => {
          if (disposed || request !== next) {
            model.dispose();
            return;
          }
          try {
            options.install(model);
            current = model;
          } catch (cause) {
            options.install(null);
            model.dispose();
            request = null;
            options.onError?.(cause);
          }
        },
        (cause: unknown) => {
          if (!disposed && request === next) {
            request = null;
            options.onError?.(cause);
          }
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.controller.abort();
      request = null;
      clear();
    },
  };
}
