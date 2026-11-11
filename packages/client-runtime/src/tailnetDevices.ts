/**
 * The rows the Network section shows: the machines in your network, machines found on your
 * tailnet that are not in it, and links made with a pairing code, one row per environmentId.
 */
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
  type TailnetDevice,
  type TailnetDeviceAccess,
  type TailnetDevicesSnapshot,
} from "@t3tools/contracts";

export interface LinkedDeviceRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Present when the environment reports it among your devices. */
  readonly device: TailnetDevice | null;
  /** This environment's link to it, from the links list. */
  readonly link: PeerLinkSummary | null;
  /** This app already has it saved, so Open has nothing to add. */
  readonly savedInApp: boolean;
}

export interface NetworkRows {
  /** Machines in the network, revoked ones included. */
  readonly members: ReadonlyArray<LinkedDeviceRow & { readonly device: TailnetDevice }>;
  /** Your machines on the tailnet that are not in the network; adding one is explicit. */
  readonly found: ReadonlyArray<TailnetDevice>;
  /** Machines linked with a pairing code, outside the network. */
  readonly paired: ReadonlyArray<LinkedDeviceRow>;
}

/** Splits what an environment lists into members, found machines and paired links. */
export function networkRows(input: {
  readonly devices: ReadonlyArray<TailnetDevice>;
  readonly links: ReadonlyArray<PeerLinkSummary>;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): NetworkRows {
  const links = new Map(input.links.map((link) => [link.environmentId, link] as const));
  const deviceIds = new Set(input.devices.map((device) => device.environmentId));
  const row = (device: TailnetDevice) => ({
    environmentId: device.environmentId,
    label: device.label,
    device,
    link: links.get(device.environmentId) ?? null,
    savedInApp: input.savedEnvironmentIds.has(device.environmentId),
  });
  return {
    members: input.devices.filter((device) => device.member !== null).map(row),
    // Only a machine with an address can be proven and added.
    found: input.devices.filter(
      (device) => device.member === null && device.access === null && device.urls.length > 0,
    ),
    paired: [
      ...input.devices
        .filter((device) => device.member === null && device.access !== null)
        .map(row),
      ...input.links
        .filter((link) => !deviceIds.has(link.environmentId))
        .map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          device: null,
          link,
          savedInApp: input.savedEnvironmentIds.has(link.environmentId),
        })),
    ],
  };
}

/**
 * Whether this machine may add, narrow, revoke or restore: it is a full-access member, or no
 * network exists yet, so adding a machine starts one with this machine at full access.
 */
export function canManageNetwork(
  snapshot: Pick<TailnetDevicesSnapshot, "selfMember" | "devices">,
): boolean {
  if (snapshot.selfMember !== null) return snapshot.selfMember.access === "full-access";
  return snapshot.devices.every((device) => device.member === null);
}

const ACCESS_RANK: ReadonlyArray<TailnetDeviceAccess> = [
  "revoked",
  ...AuthMcpClientAccess.literals,
];

/** `to` gives less than `from`, so an app moved there is signed out everywhere and pairs again. */
export const narrowsAccess = (from: TailnetDeviceAccess, to: TailnetDeviceAccess): boolean =>
  ACCESS_RANK.indexOf(to) < ACCESS_RANK.indexOf(from);

/**
 * Whether listing failed because this session may not see devices, which hides
 * the rows, rather than because the server cannot list them yet (older or not
 * yet updated servers), which the UI reports as unavailable.
 */
export function isTailnetDevicesForbidden(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return false;
  return (
    failure._tag === "EnvironmentAuthorizationError" ||
    (failure._tag === "TailnetDevicesError" &&
      "reason" in failure &&
      failure.reason === "forbidden")
  );
}
