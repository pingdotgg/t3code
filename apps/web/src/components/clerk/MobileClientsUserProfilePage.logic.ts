import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import type { Translate } from "../../i18n";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "approvals"],
  ["notifyOnInput", "input requests"],
  ["notifyOnCompletion", "completions"],
  ["notifyOnFailure", "failures"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  return `iOS ${device.iosMajorVersion}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(
  device: RelayClientDeviceRecord,
  t?: Translate,
): string {
  if (!device.notifications.enabled) {
    return t?.("auth.pushDisabled") ?? "Push notifications are disabled on this device.";
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, fallback]) =>
    device.notifications[preference]
      ? [
          t?.(
            preference === "notifyOnApproval"
              ? "auth.alertType.approvals"
              : preference === "notifyOnInput"
                ? "auth.alertType.inputRequests"
                : preference === "notifyOnCompletion"
                  ? "auth.alertType.completions"
                  : "auth.alertType.failures",
          ) ?? fallback,
        ]
      : [],
  );
  return enabledPreferences.length > 0
    ? (t?.("auth.alertsEnabled", { types: enabledPreferences.join(", ") }) ??
        `Alerts enabled for ${enabledPreferences.join(", ")}.`)
    : (t?.("auth.pushNoAlertTypes") ??
        "Push notifications are enabled, but no alert types are selected.");
}

export function mobileClientUpdatedAtLabel(updatedAt: string, t?: Translate): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? (t?.("auth.updateTimeUnavailable") ?? "Update time unavailable")
    : (t?.("auth.updatedAt", { date: mobileClientUpdatedAtFormatter.format(date) }) ??
        `Updated ${mobileClientUpdatedAtFormatter.format(date)}`);
}
