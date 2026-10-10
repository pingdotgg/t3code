import { useEffect, useState, type MouseEvent } from "react";

/** Arms one control at a time, including controls rendered in a menu portal. */
export function useInlineActionConfirm(scopeKey: string) {
  const [armed, setArmed] = useState<{
    scopeKey: string;
    action: string;
    element: HTMLElement;
  } | null>(null);
  const active = armed?.scopeKey === scopeKey ? armed : null;

  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmed(null);
    if (armed.scopeKey !== scopeKey) {
      disarm();
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !armed.element.contains(event.target)) disarm();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        disarm();
      }
    };
    const timeout = window.setTimeout(disarm, 3000);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
    };
  }, [armed, scopeKey]);

  return {
    isArmed: (action: string) => active?.action === action,
    props: (action: string, onConfirm: () => void) => ({
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (active?.action === action && active.element === event.currentTarget) {
          setArmed(null);
          onConfirm();
        } else {
          setArmed({ scopeKey, action, element: event.currentTarget });
        }
      },
      onBlur: () => setArmed(null),
    }),
  };
}
