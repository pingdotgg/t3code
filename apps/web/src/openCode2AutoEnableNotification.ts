import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const OPENCODE2_AUTO_ENABLE_NOTIFICATION_STORAGE_KEY =
  "t3code:opencode2-auto-enable-notification:v1";

export const OpenCode2AutoEnableNotificationStateSchema = Schema.Struct({
  detectedKeys: Schema.Array(Schema.String),
  dismissedKeys: Schema.Array(Schema.String),
});

export type OpenCode2AutoEnableNotificationState =
  typeof OpenCode2AutoEnableNotificationStateSchema.Type;

export const EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE: OpenCode2AutoEnableNotificationState =
  {
    detectedKeys: [],
    dismissedKeys: [],
  };

const OPENCODE2_DRIVER = ProviderDriverKind.make("opencode");
const OPENCODE2_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OPENCODE2_DRIVER);

export function openCode2AutoEnableNotificationKey(environmentId: EnvironmentId): string {
  return `${environmentId}:opencode2:auto-enabled:v1`;
}

export function resolveOpenCode2AutoEnableDetectionKey(
  environmentId: EnvironmentId | null,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  if (environmentId === null) return null;

  const wasAutoEnabled = providers.some(
    (provider) =>
      provider.driver === OPENCODE2_DRIVER &&
      provider.instanceId === OPENCODE2_DEFAULT_INSTANCE_ID &&
      provider.enabled &&
      provider.installed,
  );

  return wasAutoEnabled ? openCode2AutoEnableNotificationKey(environmentId) : null;
}

export function recordOpenCode2AutoEnableDetection(
  state: OpenCode2AutoEnableNotificationState,
  key: string,
): OpenCode2AutoEnableNotificationState {
  if (state.detectedKeys.includes(key)) return state;
  return { ...state, detectedKeys: [...state.detectedKeys, key] };
}

export function dismissOpenCode2AutoEnableNotification(
  state: OpenCode2AutoEnableNotificationState,
  key: string,
): OpenCode2AutoEnableNotificationState {
  if (state.dismissedKeys.includes(key)) return state;
  return { ...state, dismissedKeys: [...state.dismissedKeys, key] };
}

export function isOpenCode2AutoEnableNotificationPending(
  state: OpenCode2AutoEnableNotificationState,
  key: string,
): boolean {
  return state.detectedKeys.includes(key) && !state.dismissedKeys.includes(key);
}

export function readOpenCode2AutoEnableNotificationState(): OpenCode2AutoEnableNotificationState {
  try {
    return (
      getLocalStorageItem(
        OPENCODE2_AUTO_ENABLE_NOTIFICATION_STORAGE_KEY,
        OpenCode2AutoEnableNotificationStateSchema,
      ) ?? EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE
    );
  } catch (error) {
    console.error("Could not read OpenCode 2 auto-enable notification state.", error);
    return EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE;
  }
}

export function writeOpenCode2AutoEnableNotificationState(
  state: OpenCode2AutoEnableNotificationState,
): void {
  try {
    setLocalStorageItem(
      OPENCODE2_AUTO_ENABLE_NOTIFICATION_STORAGE_KEY,
      state,
      OpenCode2AutoEnableNotificationStateSchema,
    );
  } catch (error) {
    console.error("Could not persist OpenCode 2 auto-enable notification state.", error);
  }
}
