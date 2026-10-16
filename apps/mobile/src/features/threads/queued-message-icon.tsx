import { SymbolView } from "../../components/ui/AppSymbol";

/** Outbox state is independent of the agent's status, so both stay visible. */
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
