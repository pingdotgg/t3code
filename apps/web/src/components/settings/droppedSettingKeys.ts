import { ProjectSettingsOverrides, ServerSettings, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

interface DroppedSettingKeys {
  readonly serverVersion: string;
  readonly keys: ReadonlySet<string>;
}

// Learning lasts for this session and server version so an update retries support.
export const droppedSettingKeysAtom = Atom.make<ReadonlyMap<EnvironmentId, DroppedSettingKeys>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("settings:dropped-setting-keys"));

export function recordDroppedSettingKeys(
  environmentId: EnvironmentId,
  serverVersion: string,
  keys: readonly string[],
) {
  const knownKeys = keys.filter(
    (key) =>
      Object.hasOwn(ServerSettings.fields, key) ||
      (key.startsWith("projectSettingsOverrides.") &&
        Object.hasOwn(
          ProjectSettingsOverrides.fields,
          key.slice("projectSettingsOverrides.".length),
        )),
  );
  if (knownKeys.length === 0) return;
  appAtomRegistry.update(droppedSettingKeysAtom, (current) => {
    const existing = current.get(environmentId);
    const next = new Map(current);
    next.set(environmentId, {
      serverVersion,
      keys: new Set([
        ...(existing?.serverVersion === serverVersion ? existing.keys : []),
        ...knownKeys,
      ]),
    });
    return next;
  });
}

export function droppedSettingKeysFor(
  dropped: ReadonlyMap<EnvironmentId, DroppedSettingKeys>,
  environmentId: EnvironmentId,
  serverVersion: string | undefined,
): ReadonlySet<string> | undefined {
  const entry = dropped.get(environmentId);
  return entry && entry.serverVersion === serverVersion ? entry.keys : undefined;
}
