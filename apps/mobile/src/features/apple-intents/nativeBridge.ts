import type {
  AppleIntentAuthCredential,
  AppleIntentIndexDelta,
  AppleIntentOnscreenContext,
  EnvironmentId,
} from "@t3tools/contracts";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface NativeT3AppleIntentsModule {
  isSupported(): boolean;
  syncIndex(json: string): Promise<void>;
  removeEnvironment(environmentId: string): Promise<void>;
  clearIndex(): Promise<void>;
  setOnscreenContext(json: string | null): void;
  syncAuthCredentials(json: string): Promise<void>;
}

let cachedModule: NativeT3AppleIntentsModule | null | undefined;

function getNativeModule(): NativeT3AppleIntentsModule | null {
  if (Platform.OS !== "ios") return null;
  if (cachedModule !== undefined) return cachedModule;
  cachedModule = requireOptionalNativeModule<NativeT3AppleIntentsModule>("T3AppleIntents");
  return cachedModule;
}

export function isAppleIntentsSupported(): boolean {
  const mod = getNativeModule();
  if (!mod) return false;
  try {
    return mod.isSupported();
  } catch {
    return false;
  }
}

export async function syncAppleIntentsIndex(delta: AppleIntentIndexDelta): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.syncIndex(JSON.stringify(delta));
}

export async function removeAppleIntentsEnvironment(environmentId: EnvironmentId): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.removeEnvironment(environmentId);
}

export async function clearAppleIntentsNativeIndex(): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.clearIndex();
}

export function setAppleIntentsOnscreenContext(context: AppleIntentOnscreenContext): void {
  const mod = getNativeModule();
  if (!mod) return;
  mod.setOnscreenContext(context === null ? null : JSON.stringify(context));
}

export async function syncAppleIntentsAuthCredentials(
  credentials: ReadonlyArray<AppleIntentAuthCredential>,
): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;
  await mod.syncAuthCredentials(JSON.stringify(credentials));
}
