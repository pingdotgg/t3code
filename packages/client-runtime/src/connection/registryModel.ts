import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type ConnectionCatalogEntry, SshConnectionProfile } from "./catalog.ts";

export const isSshConnectionProfile = Schema.is(SshConnectionProfile);

export function unsupportedState(
  entry: ConnectionCatalogEntry,
): Pick<ConnectionCatalogEntry, "unsupportedReason" | "serverUpdateRequired"> {
  return {
    ...(entry.unsupportedReason === undefined
      ? {}
      : { unsupportedReason: entry.unsupportedReason }),
    ...(entry.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
  };
}

export class EnvironmentNotRegisteredError extends Schema.TaggedError<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class PlatformEnvironmentRemovalError extends Schema.TaggedError<PlatformEnvironmentRemovalError>()(
  "PlatformEnvironmentRemovalError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Platform-managed environment ${this.environmentId} cannot be removed.`;
  }
}
