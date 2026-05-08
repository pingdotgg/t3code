/**
 * Helpers for synthesizing "unavailable" `ServerProvider` snapshots.
 *
 * When `ServerSettings.providerInstances` (or persisted thread/session
 * state) references a driver this build does not ship — typical after a
 * downgrade from a fork or a feature-branch test session — the runtime
 * needs to surface the entry to the UI without crashing. This module
 * produces shadow snapshots that satisfy `ServerProvider`'s wire shape
 * while signalling unavailability.
 *
 * @module unavailableProviderSnapshot
 */
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { buildServerProvider } from "./providerSnapshot.ts";

export interface UnavailableProviderSnapshotInput {
  readonly driverKind: ProviderDriverKind | string;
  readonly instanceId: ProviderInstanceId;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly reason: string;
  /**
   * Optional override for `checkedAt`. Defaulted to the current Effect
   * `DateTime` so callers
   * (notably tests) don't have to pass it.
   */
  readonly checkedAt?: string;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Produce a `ServerProvider` snapshot representing a configured instance
 * whose driver the running build does not implement. The result is safe
 * to broadcast over the wire and is structured so the web UI can render
 * a "missing driver" affordance without special-casing.
 */
export function buildUnavailableProviderSnapshot(
  input: UnavailableProviderSnapshotInput,
): Effect.Effect<ServerProvider> {
  return Effect.gen(function* () {
    const checkedAt = input.checkedAt ?? (yield* nowIso);
    const displayName = input.displayName?.trim() || (input.driverKind as string);

    const base = buildServerProvider({
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
}
