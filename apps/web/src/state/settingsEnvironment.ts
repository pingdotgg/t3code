/**
 * Environment targeted by the global settings UI.
 *
 * @module state/settingsEnvironment
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

/**
 * Environment whose server settings the global settings panels read and write.
 *
 * Prefers the primary device, but falls back to the first catalog entry when
 * no `PrimaryConnectionTarget` exists. The hosted app is exactly that case —
 * every device is paired remotely — and a primary-only lookup degrades badly
 * there: server-backed rows render against schema defaults, provider-driven
 * controls like the text generation model picker have no instances to offer
 * ("No models found"), and every write is dropped on the floor because
 * `useUpdateSettingsTarget` no-ops on a null environment id.
 *
 * Only the zero-primary case changes; a session with a primary device still
 * resolves to it. When several remote devices are connected this picks one
 * arbitrarily, matching how `resolveSelectedProviderEnvironmentId` seeds the
 * Providers panel's device selector.
 */
export function resolveSettingsEnvironmentId(
  primaryEnvironmentId: EnvironmentId | null,
  catalogEnvironmentIds: Iterable<EnvironmentId>,
): EnvironmentId | null {
  if (primaryEnvironmentId !== null) {
    return primaryEnvironmentId;
  }
  for (const environmentId of catalogEnvironmentIds) {
    return environmentId;
  }
  return null;
}

export const settingsEnvironmentIdAtom = Atom.make((get): EnvironmentId | null =>
  resolveSettingsEnvironmentId(
    get(primaryEnvironmentIdAtom),
    get(environmentCatalog.catalogValueAtom).entries.keys(),
  ),
).pipe(Atom.withLabel("web-settings-environment-id"));

export function useSettingsEnvironmentId(): EnvironmentId | null {
  return useAtomValue(settingsEnvironmentIdAtom);
}
