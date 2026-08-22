import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";
import {
  dismissOpenCode2AutoEnableNotification,
  EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE,
  isOpenCode2AutoEnableNotificationPending,
  openCode2AutoEnableNotificationKey,
  OPENCODE2_AUTO_ENABLE_NOTIFICATION_STORAGE_KEY,
  readOpenCode2AutoEnableNotificationState,
  recordOpenCode2AutoEnableDetection,
  resolveOpenCode2AutoEnableDetectionKey,
  writeOpenCode2AutoEnableNotificationState,
} from "./openCode2AutoEnableNotification";

const environmentId = EnvironmentId.make("local");

function provider(
  input: Partial<Pick<ServerProvider, "driver" | "instanceId" | "enabled" | "installed">> = {},
): ServerProvider {
  return {
    instanceId: input.instanceId ?? ProviderInstanceId.make("opencode"),
    driver: input.driver ?? ProviderDriverKind.make("opencode"),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "2.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("OpenCode 2 auto-enable notification", () => {
  beforeEach(() => {
    removeLocalStorageItem(OPENCODE2_AUTO_ENABLE_NOTIFICATION_STORAGE_KEY);
  });

  it("detects only the enabled, installed default OpenCode 2 instance", () => {
    const expectedKey = openCode2AutoEnableNotificationKey(environmentId);
    expect(resolveOpenCode2AutoEnableDetectionKey(environmentId, [provider()])).toBe(expectedKey);
    expect(
      resolveOpenCode2AutoEnableDetectionKey(environmentId, [provider({ enabled: false })]),
    ).toBeNull();
    expect(
      resolveOpenCode2AutoEnableDetectionKey(environmentId, [provider({ installed: false })]),
    ).toBeNull();
    expect(
      resolveOpenCode2AutoEnableDetectionKey(environmentId, [
        provider({ driver: ProviderDriverKind.make("codex") }),
      ]),
    ).toBeNull();
    expect(
      resolveOpenCode2AutoEnableDetectionKey(environmentId, [
        provider({ instanceId: ProviderInstanceId.make("opencode-custom") }),
      ]),
    ).toBeNull();
  });

  it("stays pending across reloads until explicitly dismissed", () => {
    const key = openCode2AutoEnableNotificationKey(environmentId);
    const detected = recordOpenCode2AutoEnableDetection(
      EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE,
      key,
    );
    writeOpenCode2AutoEnableNotificationState(detected);

    const reloaded = readOpenCode2AutoEnableNotificationState();
    expect(isOpenCode2AutoEnableNotificationPending(reloaded, key)).toBe(true);

    const dismissed = dismissOpenCode2AutoEnableNotification(reloaded, key);
    writeOpenCode2AutoEnableNotificationState(dismissed);
    const reloadedAfterDismissal = readOpenCode2AutoEnableNotificationState();
    expect(isOpenCode2AutoEnableNotificationPending(reloadedAfterDismissal, key)).toBe(false);
    expect(recordOpenCode2AutoEnableDetection(reloadedAfterDismissal, key).dismissedKeys).toContain(
      key,
    );
  });

  it("scopes dismissal state to each environment", () => {
    const firstKey = openCode2AutoEnableNotificationKey(environmentId);
    const secondKey = openCode2AutoEnableNotificationKey(EnvironmentId.make("remote"));
    const detected = recordOpenCode2AutoEnableDetection(
      recordOpenCode2AutoEnableDetection(EMPTY_OPENCODE2_AUTO_ENABLE_NOTIFICATION_STATE, firstKey),
      secondKey,
    );
    const dismissed = dismissOpenCode2AutoEnableNotification(detected, firstKey);

    expect(isOpenCode2AutoEnableNotificationPending(dismissed, firstKey)).toBe(false);
    expect(isOpenCode2AutoEnableNotificationPending(dismissed, secondKey)).toBe(true);
  });
});
