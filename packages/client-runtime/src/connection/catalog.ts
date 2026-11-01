import { DesktopSshEnvironmentTargetSchema, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
    learned: Schema.optionalKey(Schema.Literal(true)),
    /**
     * "t3-connect" uses a T3 Connect session. "tailnet" signs in through
     * Tailscale at the direct tailnet address its credential pins.
     */
    authorization: Schema.optionalKey(Schema.Literals(["t3-connect", "tailnet"])),
    /**
     * "tailscale" on a learned route the server found on its Tailscale
     * interface. A bare 100.64.0.0/10 address could belong to any VPN.
     */
    network: Schema.optionalKey(Schema.Literal("tailscale")),
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly alternateRoutes?: ReadonlyArray<ConnectionRoute>;
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
  readonly serverUpdateRequired?: boolean;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

/**
 * A Tailscale sign-in session. Renewal signs in again at `signInBaseUrl`, the
 * direct tailnet address: Serve and LAN routes hide who the device is.
 */
export class TailnetConnectionCredential extends Schema.TaggedClass<TailnetConnectionCredential>()(
  "TailnetConnectionCredential",
  {
    signInBaseUrl: Schema.String,
    accessToken: Schema.String,
    expiresAtEpochMs: Schema.Number,
    dpopThumbprint: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([
  BearerConnectionCredential,
  TailnetConnectionCredential,
]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class TailnetConnectionRegistration extends Schema.TaggedClass<TailnetConnectionRegistration>()(
  "TailnetConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: TailnetConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
    /** The token from pairing over SSH, which later connects reuse. */
    credential: BearerConnectionCredential,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  TailnetConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * The primary stays on same-origin cookie auth
 * (`PrimaryConnectionRegistration`); secondary local backends live on a
 * separate loopback origin and authenticate with a bearer token minted from
 * their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "TailnetConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}
