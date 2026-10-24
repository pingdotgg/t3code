/** Keeps the composer mounted and reserves its inline space while editing across the app. */
import { createContext, use, useLayoutEffect, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { ComposerSurface } from "./ComposerSurface";

const COMPOSITION_KEY_CODE = 229;

const ComposerViewportContext = createContext({
  maximized: false,
  setMaximized: (_maximized: boolean) => {},
  restoreOnEscape: (_event: KeyboardEvent): boolean => false,
});

export function useComposerViewport() {
  return use(ComposerViewportContext);
}

export function ComposerViewport({
  targetKey,
  contextStrip,
  children,
}: {
  targetKey: string;
  contextStrip: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState({ targetKey, maximized: false });
  const titlebarHeight = useNativeTitlebarHeight();
  if (state.targetKey !== targetKey) {
    setState({ targetKey, maximized: false });
  }
  const maximized = state.targetKey === targetKey && state.maximized;
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const setMaximized = useStableCallback((next: boolean) => {
    if (maximized === next) return;
    setState({ targetKey, maximized: next });
    shell
      ?.querySelector<HTMLElement>('[data-testid="composer-editor"]')
      ?.focus({ preventScroll: true });
  });
  const [inlineHeight, setInlineHeight] = useState<number | null>(null);
  const restoreOnEscape = useStableCallback((event: KeyboardEvent) => {
    if (
      !maximized ||
      event.key !== "Escape" ||
      event.isComposing ||
      event.keyCode === COMPOSITION_KEY_CODE
    ) {
      return false;
    }
    setMaximized(false);
    return true;
  });

  useLayoutEffect(() => {
    if (!shell || maximized) return;
    const measure = () => setInlineHeight(shell.getBoundingClientRect().height);
    measure();
    return observeResize(shell, measure);
  }, [shell, maximized]);

  return (
    <ComposerViewportContext value={{ maximized, setMaximized, restoreOnEscape }}>
      <div
        style={maximized && inlineHeight !== null ? { height: inlineHeight } : undefined}
        onKeyDown={(event) => {
          if (event.defaultPrevented || !restoreOnEscape(event.nativeEvent)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <ComposerSurface.Shell
          ref={setShell}
          contextStrip={contextStrip}
          maximized={maximized}
          style={maximized ? { top: titlebarHeight } : undefined}
        >
          {children}
        </ComposerSurface.Shell>
      </div>
    </ComposerViewportContext>
  );
}
