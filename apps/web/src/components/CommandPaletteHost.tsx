import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  COMMAND_PALETTE_ELEMENT_ID,
  onOpenCommandPalette,
  setCommandPaletteRequested,
} from "../commandPaletteBus";
import { ComposerHandleContext } from "../composerHandleContext";
import { useTheme } from "../hooks/useTheme";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { reduceCommandPaletteUiState, type SearchOverlayMode } from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { CommandDialog } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";

// The palette's views pull in project browsing, search, and syntax highlighting.
// Only the shortcut handling stays in the startup graph; the dialog loads on first
// open, or once the app is idle after boot.
const loadCommandPalette = () => import("./CommandPalette");
const lazyCommandPaletteDialog = () =>
  lazy(() => loadCommandPalette().then((module) => ({ default: module.CommandPaletteDialog })));
const COMMAND_PALETTE_PRELOAD_DELAY_MS = 3_000;

// A failed load closes the palette instead of replacing the app with the route
// error view. A stale deploy gets its `vite:preloadError` reload first; otherwise
// the next open requests the chunk again.
function CommandPaletteUnavailable({ onUnavailable }: { onUnavailable: () => void }) {
  useEffect(() => onUnavailable(), [onUnavailable]);
  return null;
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

export function CommandPaletteHost({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  // Stays mounted after the first open so closing still animates out.
  const [CommandPaletteDialog, setCommandPaletteDialog] = useState<ReturnType<
    typeof lazyCommandPaletteDialog
  > | null>(null);
  if (state.open && CommandPaletteDialog === null) {
    setCommandPaletteDialog(() => lazyCommandPaletteDialog());
  }
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const closeUnavailablePalette = useCallback(() => {
    setCommandPaletteDialog(null);
    setOpen(false);
  }, [setOpen]);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  // Keyboard handlers outside the palette ignore keys from the moment it is
  // requested, including while its chunk loads.
  useLayoutEffect(() => {
    setCommandPaletteRequested(state.open);
    return () => setCommandPaletteRequested(false);
  }, [state.open]);

  useEffect(() => {
    let idleCallback: number | null = null;
    const timeout = window.setTimeout(() => {
      const preload = () => void loadCommandPalette().catch(() => undefined);
      if (typeof window.requestIdleCallback === "function") {
        idleCallback = window.requestIdleCallback(preload);
      } else {
        preload();
      }
    }, COMMAND_PALETTE_PRELOAD_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      if (idleCallback !== null) window.cancelIdleCallback(idleCallback);
    };
  }, []);

  // While the chunk loads, the app behind the palette is inert and nothing has
  // focus. Text typed then becomes the palette's query, and Escape closes it.
  const loadingQuery =
    state.openIntent === null
      ? ""
      : state.openIntent.kind === "search"
        ? state.openIntent.query
        : null;
  useLayoutEffect(() => {
    if (!state.open || state.mode !== "command" || loadingQuery === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (document.getElementById(COMMAND_PALETTE_ELEMENT_ID) !== null) return;
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "Escape" && event.key !== "Backspace" && event.key.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      const query =
        event.key === "Backspace" ? loadingQuery.slice(0, -1) : loadingQuery + event.key;
      dispatch({ _tag: "OpenSearch", query });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [loadingQuery, setOpen, state.mode, state.open]);

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {/* Block background focus calls for the entire time the palette is open. */}
        <div className="contents" inert={state.open}>
          {children}
        </div>
        {CommandPaletteDialog ? (
          <RenderErrorBoundary
            fallback={<CommandPaletteUnavailable onUnavailable={closeUnavailablePalette} />}
          >
            <Suspense fallback={null}>
              <CommandPaletteDialog
                mode={state.mode}
                openIntent={state.openIntent}
                setOpen={setOpen}
                openOverlayMode={toggleMode}
                clearOpenIntent={clearOpenIntent}
              />
            </Suspense>
          </RenderErrorBoundary>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
