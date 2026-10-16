import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

interface DroppedSettingKeys {
  readonly serverVersion: string;
  readonly keys: ReadonlySet<string>;
}

/**
 * Setting keys each environment dropped on a save this session, for servers
 * too old to list the keys they store. Tagged with the server version, so an
 * update clears them.
 */
export const droppedSettingKeysAtom = Atom.make<ReadonlyMap<EnvironmentId, DroppedSettingKeys>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("settings:dropped-setting-keys"));

export function recordDroppedSettingKeys(
  environmentId: EnvironmentId,
  serverVersion: string,
  keys: readonly string[],
) {
  if (keys.length === 0) return;
  appAtomRegistry.update(droppedSettingKeysAtom, (current) => {
    const existing = current.get(environmentId);
    const next = new Map(current);
    next.set(environmentId, {
      serverVersion,
      keys: new Set([...(existing?.serverVersion === serverVersion ? existing.keys : []), ...keys]),
    });
    return next;
  });
}

/** The keys an environment dropped, if it still runs the version that dropped them. */
export function droppedSettingKeysFor(
  dropped: ReadonlyMap<EnvironmentId, DroppedSettingKeys>,
  environmentId: EnvironmentId,
  serverVersion: string | undefined,
): ReadonlySet<string> | undefined {
  const entry = dropped.get(environmentId);
  return entry && entry.serverVersion === serverVersion ? entry.keys : undefined;
}
