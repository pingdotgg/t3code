import { useState, type MouseEvent } from "react";

interface ArmedAction {
  readonly scopeKey: string;
  readonly action: string;
  readonly element: HTMLElement;
  // Stable per arming, so React attaches it once. Detaching it (disarm, scope change, or the
  // armed element unmounting) removes the listeners and disarms.
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
}

export function useInlineActionConfirm(scopeKey: string) {
  const [armed, setArmed] = useState<ArmedAction | null>(null);
  if (armed !== null && armed.scopeKey !== scopeKey) setArmed(null);
  const active = armed?.scopeKey === scopeKey ? armed : null;

  const arm = (action: string, element: HTMLElement) => {
    const entry: ArmedAction = {
      scopeKey,
      action,
      element,
      ref: (node) => {
        if (node === null) return undefined;
        const controller = new AbortController();
        const { signal } = controller;
        const release = () => setArmed((current) => (current === entry ? null : current));
        document.addEventListener(
          "pointerdown",
          (event) => {
            if (event.target instanceof Node && !node.contains(event.target)) release();
          },
          { capture: true, signal },
        );
        window.addEventListener(
          "keydown",
          (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            release();
          },
          { capture: true, signal },
        );
        window.addEventListener("blur", release, { signal });
        const timeout = window.setTimeout(release, 3000);
        return () => {
          controller.abort();
          window.clearTimeout(timeout);
          release();
        };
      },
    };
    setArmed(entry);
  };

  return {
    isArmed: (action: string) => active?.action === action,
    props: (action: string, onConfirm: () => void) => ({
      ref: active?.action === action ? active.ref : undefined,
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (active?.action === action && active.element === event.currentTarget) {
          setArmed(null);
          onConfirm();
        } else {
          arm(action, event.currentTarget);
        }
      },
      onBlur: () => setArmed(null),
    }),
  };
}
