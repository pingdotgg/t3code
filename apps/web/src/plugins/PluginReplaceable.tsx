import { useAtomValue } from "@effect/atom-react";

import { PluginRenderBoundary } from "./PluginRenderBoundary";
import {
  pluginReplacementAtoms,
  type PluginPartName,
  type PluginPartProps,
} from "./pluginRegistry";

const PART_NAMES: { readonly [Part in PluginPartName]: string } = {
  "composer.controls": "the composer's controls",
  "app.pageFrame": "Settings and Usage",
  "app.sidebar": "the sidebar",
};

/**
 * Draws a plugin's version of `part` when one is registered, and T3's `pieces.original`
 * otherwise or where the plugin's throws. Unused pieces are elements that never render.
 */
export function PluginReplaceable<Part extends PluginPartName>(props: {
  readonly part: Part;
  readonly pieces: PluginPartProps<Part>;
}) {
  const replacement = useAtomValue(pluginReplacementAtoms[props.part]);
  if (replacement === undefined) return props.pieces.original;
  const Replacement = replacement.component;
  return (
    <PluginRenderBoundary
      owner={replacement.owner}
      what={`Its version of ${PART_NAMES[props.part]} (${props.part})`}
      resetKeys={[replacement]}
      fallback={props.pieces.original}
    >
      <Replacement {...props.pieces} />
    </PluginRenderBoundary>
  );
}
