import { SymbolView } from "../../components/ui/AppSymbol";
import { defineNativePluginFeature } from "../../plugins/features";

export const QueuedMessageIcon = defineNativePluginFeature(
  "native.features.threads.queued-message-icon",
  BuiltinQueuedMessageIcon,
);

function BuiltinQueuedMessageIcon({ selected = false }: { readonly selected?: boolean }) {
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
