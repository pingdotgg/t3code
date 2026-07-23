import type { ServerSettings, ServerSettingsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";

import type * as ServerSettingsModule from "../serverSettings.ts";

export interface ProviderSnapshotSettings<Settings> {
  readonly provider: Settings;
  readonly enableProviderUpdateChecks: boolean;
}

export function makeProviderSnapshotSettings<Settings>(
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

export function makeProviderSnapshotSettingsSource<Settings>(
  provider: Settings,
  serverSettings: ServerSettingsModule.ServerSettingsService["Service"],
): {
  readonly getSettings: Effect.Effect<ProviderSnapshotSettings<Settings>, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<ProviderSnapshotSettings<Settings>>;
} {
  const mapSettings = (settings: ServerSettings) =>
    makeProviderSnapshotSettings(provider, settings);
  return {
    getSettings: serverSettings.getSettings.pipe(Effect.map(mapSettings)),
    streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSettings)),
  };
}
