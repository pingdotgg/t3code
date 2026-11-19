import type { DeviceServiceState, ThreadId } from "@t3tools/contracts";

/** Mirrors expo-device-hub's `physicalDeviceName` and `androidVersion`; recheck when bumping the hub. */
export function thisAndroidPhone(phone: {
  readonly platform: string;
  readonly isDevice: boolean;
  readonly manufacturer: string | null;
  readonly modelName: string | null;
  readonly osVersion: string | null;
}) {
  if (phone.platform !== "android" || !phone.isDevice || !phone.modelName) return null;
  const release = phone.osVersion ?? "";
  return {
    name: phone.manufacturer ? `${phone.manufacturer} ${phone.modelName}` : phone.modelName,
    version: `Android ${/^\d+$/.test(release) ? `${release}.0` : release}`,
  };
}

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(
  state: DeviceServiceState | null,
  threadId: ThreadId,
  thisPhone: ReturnType<typeof thisAndroidPhone>,
) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      return {
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.version, host?.label].filter(Boolean).join(" · "),
        serveSimOnly: host?.kind === "simlock",
        isThisPhone:
          thisPhone !== null &&
          session.platform === "android" &&
          device?.physical === true &&
          device.name === thisPhone.name &&
          device.version === thisPhone.version,
        // Local and SSH hosts keep sessions across a listing that misses their device.
        identityPending:
          thisPhone !== null &&
          session.platform === "android" &&
          device === undefined &&
          (host?.kind === "local" || host?.kind === "ssh"),
      };
    });
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
