import {
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
  PortSchema,
  TailcatAddress,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  TailcatConnectionTarget,
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
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export class TailcatConnectionProfile extends Schema.TaggedClass<TailcatConnectionProfile>()(
  "TailcatConnectionProfile",
  {
    ...ConnectionProfileBase,
    address: TailcatAddress,
    remotePort: PortSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([
  BearerConnectionProfile,
  SshConnectionProfile,
  TailcatConnectionProfile,
]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
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

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  },
) {}

export class TailcatConnectionRegistration extends Schema.TaggedClass<TailcatConnectionRegistration>()(
  "TailcatConnectionRegistration",
  {
    target: TailcatConnectionTarget,
    profile: TailcatConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
  TailcatConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * Platform-managed registrations are reconciled from the host (the desktop
 * bootstrap IPC) rather than persisted by the user. They cover the primary
 * local environment plus any additional desktop-local backends running
 * alongside it (e.g. a parallel WSL backend). The primary stays on same-origin
 * cookie auth (`PrimaryConnectionRegistration`); secondary local backends live
 * on a separate loopback origin and authenticate with a bearer token minted
 * from their bootstrap credential (`BearerConnectionRegistration`).
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
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
    case "TailcatConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
      };
  }
}

/** Targets whose profile and credential live under a connection id. */
export function connectionTargetConnectionId(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
    case "TailcatConnectionTarget":
      return target.connectionId;
  }
}
