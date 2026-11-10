import { useEffect } from "react";

import { toastManager } from "~/components/ui/toast";
import { createSelectionCopier, observeCopyOnSelect } from "~/lib/copyOnSelect";
import { getClientSettings, useClientSettings } from "./useSettings";

const copySelection = createSelectionCopier(() => {
  if (getClientSettings().copyOnSelectToast) {
    toastManager.add({ type: "success", title: "Copied to clipboard" });
  }
});

/** Copies a finished mouse selection when Copy on select is on. Shared by chat and the terminal. */
export function copySelectionIfEnabled(text: string): void {
  if (getClientSettings().copyOnSelect) void copySelection(text);
}

export function useCopyOnSelect(container: HTMLElement | null): void {
  const enabled = useClientSettings((settings) => settings.copyOnSelect);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window mouse events for the container
  useEffect(() => {
    if (!container || !enabled) return;
    return observeCopyOnSelect(container, copySelectionIfEnabled);
  }, [container, enabled]);
}
