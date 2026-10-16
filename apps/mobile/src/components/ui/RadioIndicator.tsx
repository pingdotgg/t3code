import { SymbolView } from "./AppSymbol";

/** The enclosing radio row owns selection, touch and accessibility. */
export function RadioIndicator({ selected }: { readonly selected: boolean }) {
  return selected ? (
    <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
  ) : null;
}
