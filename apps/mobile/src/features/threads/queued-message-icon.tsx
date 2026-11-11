import { SymbolView } from "../../components/ui/AppSymbol";

export function QueuedMessageIcon({ selected = false }: { readonly selected?: boolean }) {
  return (
    <SymbolView
      name="tray.and.arrow.up"
      size={12}
      tintColorClassName={
        selected ? "accent-user-bubble-foreground-muted" : "accent-foreground-muted"
      }
      type="monochrome"
    />
  );
}
