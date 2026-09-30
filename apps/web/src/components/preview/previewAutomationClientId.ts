import type {
  DesktopPreviewAutomationHostMetadata,
  PreviewAutomationHostLabel,
  PreviewAutomationHostPlatform,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const PREVIEW_AUTOMATION_HOST_ID_STORAGE_KEY = "t3.previewAutomationHostId.v1";

let fallbackPreviewAutomationHostId: string | undefined;

export function createPreviewAutomationClientId(crypto: Crypto = globalThis.crypto): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `preview-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function getOrCreatePreviewAutomationHostId(
  storage: Pick<Storage, "getItem" | "setItem"> = globalThis.localStorage,
  crypto: Crypto = globalThis.crypto,
): string {
  if (fallbackPreviewAutomationHostId !== undefined) return fallbackPreviewAutomationHostId;

  let created: string | undefined;
  try {
    const existing = storage.getItem(PREVIEW_AUTOMATION_HOST_ID_STORAGE_KEY);
    if (existing && /^preview-[a-f0-9]{32}$/u.test(existing)) return existing;
    created = createPreviewAutomationClientId(crypto);
    storage.setItem(PREVIEW_AUTOMATION_HOST_ID_STORAGE_KEY, created);
    return created;
  } catch {
    fallbackPreviewAutomationHostId ??= created ?? createPreviewAutomationClientId(crypto);
    return fallbackPreviewAutomationHostId;
  }
}

export function resolvePreviewAutomationHostPlatform(
  navigatorPlatform: string,
): PreviewAutomationHostPlatform {
  const platform = navigatorPlatform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

export function resolvePreviewAutomationHostMetadata(
  nativeMetadata: DesktopPreviewAutomationHostMetadata | null | undefined,
  navigatorPlatform: string,
  clientId: string,
): {
  readonly label: PreviewAutomationHostLabel;
  readonly platform: PreviewAutomationHostPlatform;
} {
  const nativeLabel = Predicate.isString(nativeMetadata?.label) ? nativeMetadata.label.trim() : "";
  const nativePlatform = nativeMetadata?.platform;
  const platform =
    nativePlatform === "macos" ||
    nativePlatform === "windows" ||
    nativePlatform === "linux" ||
    nativePlatform === "unknown"
      ? nativePlatform
      : resolvePreviewAutomationHostPlatform(navigatorPlatform);
  if (nativeLabel) {
    return {
      label: nativeLabel.slice(0, 128) as PreviewAutomationHostLabel,
      platform,
    };
  }
  const platformLabel =
    platform === "macos"
      ? "macOS"
      : platform === "windows"
        ? "Windows"
        : platform === "linux"
          ? "Linux"
          : "Desktop";
  return {
    label: `${platformLabel} (${clientId.slice(-8)})` as PreviewAutomationHostLabel,
    platform,
  };
}
