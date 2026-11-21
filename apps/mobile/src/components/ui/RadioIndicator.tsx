import { SymbolView } from "./AppSymbol";
import { defineNativePluginFeature } from "../../plugins/features";

export const RadioIndicator = defineNativePluginFeature(
  "native.components.ui.radio-indicator",
  BuiltinRadioIndicator,
);

/** The enclosing radio row owns selection, touch and accessibility. */
function BuiltinRadioIndicator({ selected }: { readonly selected: boolean }) {
  return selected ? (
    <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
  ) : null;
}
