import { useAtomValue } from "@effect/atom-react";
import type { WebPluginParts } from "@t3tools/plugin-sdk/web";

import { pluginPartReplacedAtom, pluginUiAtom } from "./pluginUi";

/**
 * One of T3's parts a plugin can draw its own way. Draws `pieces.original` until a loaded plugin
 * replaces the part, so the tree under it stays the same while none does.
 */
export function PluginPart<Part extends keyof WebPluginParts>(props: {
  readonly part: Part;
  readonly pieces: WebPluginParts[Part];
}) {
  const pluginUi = useAtomValue(pluginUiAtom);
  const replaced = useAtomValue(pluginPartReplacedAtom(props.part));
  if (pluginUi === null || !replaced) return props.pieces.original;
  return <pluginUi.PluginReplaceable part={props.part} pieces={props.pieces} />;
}
