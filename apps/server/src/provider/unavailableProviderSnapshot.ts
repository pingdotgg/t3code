import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";

export interface UnavailableProviderSnapshotInput {
  readonly driverKind: ProviderDriverKind | string;
  readonly instanceId: ProviderInstanceId;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly reason: string;
  readonly checkedAt?: string;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const buildUnavailableProviderSnapshot = Effect.fn(
  "unavailableProviderSnapshot.buildUnavailableProviderSnapshot",
)(function* (input: UnavailableProviderSnapshotInput): Effect.fn.Return<ServerProvider> {
  const checkedAt = input.checkedAt ?? (yield* nowIso);
  const displayName = input.displayName?.trim() || (input.driverKind as string);

  // No driver ran, so its setup capabilities are still unknown.
  const { setup: _setup, ...base } = buildServerProvider({
    presentation: { displayName },
    enabled: false,
    checkedAt,
    models: [],
    skills: [],
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: input.reason,
    },
  });

  return {
    ...base,
    instanceId: input.instanceId,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    driver:
      typeof input.driverKind === "string"
        ? ProviderDriverKind.make(input.driverKind)
        : input.driverKind,
    availability: "unavailable",
    unavailableReason: input.reason,
  };
});
