import { useEffect } from "react";

export type RightPanelKind = "diff" | "file" | "plan";

interface RightPanelRegistration {
  readonly close?: () => void;
  readonly open: () => void;
}

const registeredPanels = new Map<RightPanelKind, RightPanelRegistration>();
let lastUsedRightPanel: RightPanelKind = "diff";

export function markRightPanelUsed(kind: RightPanelKind): void {
  lastUsedRightPanel = kind;
}

export function openRightPanel(kind: RightPanelKind): boolean {
  const registration = registeredPanels.get(kind);
  if (!registration) {
    return false;
  }

  markRightPanelUsed(kind);
  for (const [registeredKind, registeredPanel] of registeredPanels) {
    if (registeredKind !== kind) {
      registeredPanel.close?.();
    }
  }
  registration.open();
  return true;
}

export function openLastUsedRightPanel(): boolean {
  if (openRightPanel(lastUsedRightPanel)) {
    return true;
  }

  return openRightPanel("file") || openRightPanel("diff") || openRightPanel("plan");
}

export function useRegisterRightPanel({
  close,
  enabled = true,
  kind,
  open,
}: {
  readonly close?: () => void;
  readonly enabled?: boolean;
  readonly kind: RightPanelKind;
  readonly open: () => void;
}) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    registeredPanels.set(kind, close ? { close, open } : { open });
    return () => {
      const registration = registeredPanels.get(kind);
      if (registration?.open === open) {
        registeredPanels.delete(kind);
      }
    };
  }, [close, enabled, kind, open]);
}
