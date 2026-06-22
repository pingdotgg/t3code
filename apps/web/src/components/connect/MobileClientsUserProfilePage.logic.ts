import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

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

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return "Push notifications are disabled on this device.";
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? `Alerts enabled for ${enabledPreferences.join(", ")}.`
    : "Push notifications are enabled, but no alert types are selected.";
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? "Update time unavailable"
    : `Updated ${mobileClientUpdatedAtFormatter.format(date)}`;
}
