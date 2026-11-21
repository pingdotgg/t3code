import { BUILTIN_PLUGIN_MANIFESTS } from "@t3tools/contracts";

import { declareNativeBuiltinFeatures, nativeBuiltinRenderer } from "../features";
import type { NativePluginDefinition } from "../sdk";

/** Compiled native modules own registration; Metro supplies the original platform renderer. */
export function defineNativeBuiltinPlugin(
  id: string,
  slots: readonly string[],
): NativePluginDefinition {
  const manifest = BUILTIN_PLUGIN_MANIFESTS.find((candidate) => candidate.id === id);
  if (!manifest || slots.length === 0) throw new Error(`Invalid native builtin '${id}'.`);
  declareNativeBuiltinFeatures(id, slots);
  return {
    manifest,
    activate(host) {
      for (const slot of slots) {
        host.register(slot, nativeBuiltinRenderer(slot), { id: "default", order: -1000 });
      }
    },
  };
}
