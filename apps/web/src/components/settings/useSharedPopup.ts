import { useState, type RefObject } from "react";

interface SharedPopupActions {
  close: () => void;
  unmount: () => void;
}

export interface SharedPopup {
  actionsRef: RefObject<SharedPopupActions | null>;
  onOpenChange: (open: boolean, details: { trigger?: Element | undefined }) => void;
  triggerRef: (trigger: HTMLElement | null) => (() => void) | undefined;
}

function createSharedPopup(): SharedPopup {
  let activeTriggerId: string | null = null;
  const actionsRef: SharedPopup["actionsRef"] = { current: null };
  return {
    actionsRef,
    onOpenChange: (open, details) => {
      activeTriggerId = open ? (details.trigger?.id ?? null) : null;
    },
    triggerRef: (trigger) => {
      if (!trigger) return;
      return () => {
        queueMicrotask(() => {
          if (activeTriggerId === trigger.id && !trigger.isConnected) {
            actionsRef.current?.close();
          }
        });
      };
    },
  };
}

export function useSharedPopup(): SharedPopup {
  const [popup] = useState(createSharedPopup);
  return popup;
}
