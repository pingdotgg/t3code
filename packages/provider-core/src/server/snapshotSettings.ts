import type { ServerSettings, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";

import * as ProviderHost from "./ProviderHost.ts";

export interface ProviderSnapshotSettings<Settings> {
  readonly provider: Settings;
  readonly enableProviderUpdateChecks: boolean;
}

function makeProviderSnapshotSettings<Settings>(
  provider: Settings,
  settings: ServerSettings,
): ProviderSnapshotSettings<Settings> {
  return {
    provider,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
  };
}

export function haveProviderSnapshotSettingsChanged<Settings>(
  previous: ProviderSnapshotSettings<Settings>,
  next: ProviderSnapshotSettings<Settings>,
): boolean {
  return !Equal.equals(previous, next);
}

/** The instance's settings paired with the host's server settings, as snapshots read them. */
export const makeProviderSnapshotSettingsSource = <Settings>(
  provider: Settings,
): Effect.Effect<
  {
    readonly getSettings: Effect.Effect<ProviderSnapshotSettings<Settings>, ServerSettingsError>;
    readonly streamSettings: Stream.Stream<ProviderSnapshotSettings<Settings>>;
  },
  never,
  ProviderHost.ProviderHost
> =>
  Effect.gen(function* () {
    const { settings } = yield* ProviderHost.ProviderHost;
    const mapSettings = (current: ServerSettings) =>
      makeProviderSnapshotSettings(provider, current);
    return {
      getSettings: settings.get.pipe(Effect.map(mapSettings)),
      streamSettings: settings.changes.pipe(Stream.map(mapSettings)),
    };
  });
