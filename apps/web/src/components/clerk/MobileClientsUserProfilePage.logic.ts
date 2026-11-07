import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import type { MessageKey, TranslateFn } from "@t3tools/client-runtime/i18n";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "misc.clerk.mobile.pref.approvals"],
  ["notifyOnInput", "misc.clerk.mobile.pref.input"],
  ["notifyOnCompletion", "misc.clerk.mobile.pref.completions"],
  ["notifyOnFailure", "misc.clerk.mobile.pref.failures"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], MessageKey]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  const platform =
    device.platform === "android"
      ? "Android"
      : device.iosMajorVersion === null
        ? "iOS"
        : `iOS ${device.iosMajorVersion}`;
  return `${platform}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(
  device: RelayClientDeviceRecord,
  t: TranslateFn,
): string {
  if (!device.notifications.enabled) {
    return t("misc.clerk.mobile.pushDisabled");
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [t(label)] : [],
  );
  return enabledPreferences.length > 0
    ? t("misc.clerk.mobile.alertsEnabled", { types: enabledPreferences.join(", ") })
    : t("misc.clerk.mobile.noAlertTypes");
}

export function mobileClientUpdatedAtLabel(updatedAt: string, t: TranslateFn): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? t("misc.clerk.mobile.updateUnavailable")
    : t("misc.clerk.mobile.updated", { time: mobileClientUpdatedAtFormatter.format(date) });
}
