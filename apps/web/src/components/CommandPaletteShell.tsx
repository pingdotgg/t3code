import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { onOpenCommandPalette } from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { CommandDialog } from "./ui/command";

const CommandPaletteDialog = lazy(() =>
  import("./CommandPalette").then((module) => ({
    default: module.CommandPaletteDialog,
  })),
);

interface CommandPaletteOpenIntent {
  readonly kind: "add-project" | "new-thread-in";
}

interface CommandPaletteState {
  readonly open: boolean;
  readonly openIntent: CommandPaletteOpenIntent | null;
}

/**
 * Keeps the command-palette keyboard/event bridge in the startup graph while
 * deferring its filesystem, source-control, and dialog implementation until
 * the palette is opened.
 */
export function CommandPaletteShell({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<CommandPaletteState>({
    open: false,
    openIntent: null,
  });
  const setOpen = useCallback(
    (open: boolean) =>
      setState((current) => ({
        open,
        openIntent: open ? current.openIntent : null,
      })),
    [],
  );
  const toggleOpen = useCallback(
    () => setState((current) => ({ open: !current.open, openIntent: null })),
    [],
  );
  const clearOpenIntent = useCallback(
    () => setState((current) => ({ ...current, openIntent: null })),
    [],
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((value) =>
    routeThreadRef
      ? selectThreadTerminalUiState(value.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (!detail.open) {
          setOpen(true);
          return;
        }

        setState({ open: true, openIntent: { kind: detail.open } });
      }),
    [setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog open={state.open} onOpenChange={setOpen}>
        {children}
        {state.open ? (
          <Suspense fallback={null}>
            <CommandPaletteDialog
              openIntent={state.openIntent}
              setOpen={setOpen}
              clearOpenIntent={clearOpenIntent}
            />
          </Suspense>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
