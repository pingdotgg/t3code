import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputCursor,
  type TerminalOutputUpdate,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  AuthPreviewOperateScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type ContextMenuItem,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readTextFromClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";
import { type GhosttyColor, type GhosttyTheme } from "~/terminal/ghostty/core";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isTerminalUrl } from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readLocalApi } from "~/localApi";
import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { useClientSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { attachedTerminalSessionAtom } from "../state/terminalSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useEnvironmentScope } from "../state/session";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { useAtomCommand } from "../state/use-atom-command";
import { preventTerminalCloseShortcut } from "../lib/terminalCloseShortcut";
import { observeResize } from "../lib/observeResize";
import {
  consumePendingTerminalFocus,
  focusTerminal,
  focusTerminalViewport,
  registerTerminalFocusTarget,
} from "../lib/terminalFocus";
import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";
import type { TerminalContextMenuAction, TerminalViewportProps } from "./ThreadTerminalDrawer";
import { shouldClearTerminalSelectionAction, shouldHandleTerminalExit, synchronizeTerminalSession, terminalContextMenuItems, terminalFontOptions, terminalSelectionLineRange, terminalSelectionMenuItems, terminalThemeFromApp, withLiveVisibility, writableSessionGeneration, writeSystemMessage, writeTerminalOutputUpdate } from "./ThreadTerminalDrawer";

export function TerminalSessionViewport({
  advancedTypography,
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  providerInstanceId,
  onSessionExited,
  onAddTerminalContext,
  autoFocus = false,
  visible,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoFocusedRef = useRef(false);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const visibleRef = useRef(visible);
  const environmentId = threadRef.environmentId;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = useEffectEvent(() =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope),
  );
  const canOpenHostEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canActivateTerminalLink = useEffectEvent(
    (text: string) =>
      isTerminalUrl(text) || readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  });
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  });
  const hasHandledExitRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const openSelectionMenuRequestIdRef = useRef<number | null>(null);
  const readKeybindings = useEffectEvent(() => keybindings);
  const handleSessionExited = useEffectEvent(() => {
    if (hasTerminalWriteAccess()) onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext?.(selection);
  });
  const canAddSelectionToChat = useEffectEvent(() => onAddTerminalContext !== undefined);
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const terminalFontFamily = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: advancedTypography,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const terminalFontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const terminalFontRef = useRef({ family: terminalFontFamily, size: terminalFontSize });
  // Keyed by the launch (see TerminalViewport), so the atom is fixed for this surface.
  const terminalSessionAtom = attachedTerminalSessionAtom(environmentId, {
    threadId,
    terminalId,
    cwd,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(runtimeEnv ? { env: runtimeEnv } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
  });
  // Attaching starts with the viewport, while the WASM surface is still loading;
  // the surface reads the session itself, so output chunks never re-render here.
  useAtomMount(terminalSessionAtom);
  const readTerminalSession = useEffectEvent(() => appAtomRegistry.get(terminalSessionAtom));
  const subscribeTerminalSession = useEffectEvent(
    (listener: (session: TerminalSessionState) => void) =>
      appAtomRegistry.subscribe(terminalSessionAtom, listener),
  );
  const writeTerminal = useEffectEvent((data: string) =>
    runTerminalWrite({
      environmentId,
      input: { threadId, terminalId, data },
    }),
  );
  const resizeTerminal = useEffectEvent((cols: number, rows: number) => {
    if (writableSessionGeneration(readTerminalSession(), hasTerminalWriteAccess()) === null) {
      return;
    }
    return runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows },
    });
  });
  const outputCursorRef = useRef<TerminalOutputCursor>(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const synchronizedStatusRef = useRef<TerminalSessionState["status"]>("closed");
  const synchronizeTerminalStatus = useEffectEvent(
    (terminal: GhosttyTerminalSurface, status: TerminalSessionState["status"], version: number) => {
      const synchronized = synchronizedStatusRef.current;
      if (version > 0 && status === "running") {
        hasHandledExitRef.current = false;
      } else if (
        shouldHandleTerminalExit(status, synchronized, hasHandledExitRef.current, version)
      ) {
        hasHandledExitRef.current = true;
        writeSystemMessage(terminal, status === "closed" ? "Terminal closed" : "Process exited");
        window.setTimeout(() => {
          if (hasHandledExitRef.current) {
            handleSessionExited();
          }
        }, 0);
      }
      if (version > 0) synchronizedStatusRef.current = status;
    },
  );
  const openLinkInPreview = useEffectEvent(
    (url: string, forceBrowser: boolean, fallbackToBrowser: () => void) =>
      openTerminalLinkInPreview({ url, threadRef, openPreview, fallbackToBrowser, forceBrowser }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets the terminal input's readOnly from the operate grant and consumes a pending focus request
  useLayoutEffect(() => {
    if (terminalRef.current) terminalRef.current.input.readOnly = !canOperateTerminal;
    if (canOperateTerminal && visibleRef.current)
      consumePendingTerminalFocus(threadRef, terminalId);
  }, [canOperateTerminal, terminalId, threadRef]);

  // Links re-read the grant on activation; only the hovered link's styling needs a nudge.
  const linkActivationScopeRef = useRef(canOpenHostEditor);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes link activation styling on the imperative terminal surface when the editor grant changes
  useEffect(() => {
    if (linkActivationScopeRef.current === canOpenHostEditor) return;
    linkActivationScopeRef.current = canOpenHostEditor;
    terminalRef.current?.refreshLinkActivation();
  }, [canOpenHostEditor]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility into the terminal surface before paint and consumes focus requests made while hidden
  useLayoutEffect(() => {
    visibleRef.current = visible;
    terminalRef.current?.setVisible(visible);
    // A request made while this viewport was hidden could not focus it.
    if (visible) consumePendingTerminalFocus(threadRef, terminalId);
  }, [terminalId, threadRef, visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies font family and size changes to the live Ghostty terminal surface
  useEffect(() => {
    const current = terminalFontRef.current;
    if (current.family === terminalFontFamily && current.size === terminalFontSize) return;
    terminalFontRef.current = { family: terminalFontFamily, size: terminalFontSize };
    void terminalRef.current?.setFont(terminalFontOptions(terminalFontFamily, terminalFontSize));
  }, [terminalFontFamily, terminalFontSize]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the Ghostty terminal in the mount node and subscribes it to the terminal session
  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const localApi = readLocalApi();
    let cancelled = false;
    let teardown: (() => void) | null = null;
    let setupTerminal: GhosttyTerminalSurface | null = null;
    let setupCleanups: Array<() => void> = [];
    let selectionActions: ReturnType<typeof observeSelectionActions> | null = null;

    const setup = async (): Promise<(() => void) | null> => {
      const setupFont = terminalFontRef.current;
      const terminalOptions = withLiveVisibility(visibleRef, {
        theme: terminalThemeFromApp(mount),
        font: terminalFontOptions(setupFont.family, setupFont.size),
        onData: (data) => handleData(data),
        onResize: (cols, rows) => void resizeTerminal(cols, rows),
        onSelectionChange: () => handleSelectionChange(),
        beforeKey: (event) => handleBeforeKey(event),
        onLinkActivate: (text, event) => handleLinkActivate(text, event),
        canActivateLink: (text) => canActivateTerminalLink(text),
        // Surface listeners start before WASM loading finishes and the terminal handler exists.
        onContextMenu: (event) => {
          if (terminalRef.current) void showTerminalContextMenu(event);
        },
      });
      const terminal = await GhosttyTerminalSurface.create(mount, terminalOptions);
      if (cancelled) {
        terminal.dispose();
        return null;
      }
      terminal.setVisible(visibleRef.current);
      // Re-read theme changes during WASM loading, before the observer was installed.
      terminal.setTheme(terminalThemeFromApp(mount));
      setupTerminal = terminal;
      terminalRef.current = terminal;
      terminal.input.setAttribute("data-workspace-focus-default", "");
      terminal.input.readOnly = !hasTerminalWriteAccess();
      // Reapply font settings hydrated during loading, when terminalRef was null.
      const currentFont = terminalFontRef.current;
      if (currentFont.family !== setupFont.family || currentFont.size !== setupFont.size) {
        void terminal.setFont(terminalFontOptions(currentFont.family, currentFont.size));
      }
      const latestSession = readTerminalSession();
      terminal.setSharedGrid(latestSession.grid);
      const initialOutput = readTerminalOutputUpdate(
        latestSession.output,
        INITIAL_TERMINAL_OUTPUT_CURSOR,
      );
      if (initialOutput.type === "reset" && initialOutput.data.length > 0) {
        writeTerminalOutputUpdate(terminal, initialOutput);
      }
      outputCursorRef.current = initialOutput.cursor;
      if (latestSession.error !== null) writeSystemMessage(terminal, latestSession.error);
      synchronizedStatusRef.current = "closed";
      synchronizeTerminalStatus(terminal, latestSession.status, latestSession.version);
      // Read and subscribe in one synchronous step so no output lands between them.
      let previousSession = latestSession;
      let resizeGeneration = writableSessionGeneration(latestSession, hasTerminalWriteAccess());
      setupCleanups.push(
        subscribeTerminalSession((session) => {
          const nextResizeGeneration = writableSessionGeneration(session, hasTerminalWriteAccess());
          if (nextResizeGeneration !== resizeGeneration) {
            resizeGeneration = nextResizeGeneration;
            // The first fit can precede authorization/attach; replay the grid for each writable session, including
            // reconnects.
            if (nextResizeGeneration !== null) terminal.resendSize();
          }
          const previous = previousSession;
          previousSession = session;
          terminal.setSharedGrid(session.grid);
          synchronizeTerminalStatus(terminal, session.status, session.version);
          outputCursorRef.current = synchronizeTerminalSession(
            terminal,
            previous,
            session,
            outputCursorRef.current,
          );
        }),
      );
      if (
        hasTerminalWriteAccess() &&
        visibleRef.current &&
        mount.contains(document.activeElement)
      ) {
        terminal.focus();
      }

      const dismissSelectionAction = (supersede = false) => {
        const ownsMenu =
          openSelectionMenuRequestIdRef.current === selectionActionRequestIdRef.current;
        if (supersede || ownsMenu) selectionActionRequestIdRef.current += 1;
        if (ownsMenu) void localApi?.contextMenu.close();
      };
      const clearSelectionAction = () => {
        selectionActions?.cancel();
        dismissSelectionAction(true);
      };
      setupCleanups.push(clearSelectionAction);

      const readSelectionAction = (
        pointer: SelectionActionPoint | null = null,
      ): {
        position: { x: number; y: number };
        clipboardText: string;
        selection: TerminalContextSelection;
      } | null => {
        const activeTerminal = terminalRef.current;
        const mountElement = containerRef.current;
        if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
          return null;
        }
        const selectionText = activeTerminal.getSelection();
        const selectionPosition = activeTerminal.getSelectionPosition();
        const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
        if (!selectionPosition || normalizedText.length === 0) {
          return null;
        }
        const { lineStart, lineEnd } = terminalSelectionLineRange(selectionPosition);
        const bounds = mountElement.getBoundingClientRect();
        const position = resolveSelectionActionPosition({
          bounds,
          selectionRect: activeTerminal.getSelectionEndClientRect(),
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        return {
          position,
          clipboardText: selectionText,
          selection: {
            terminalId,
            terminalLabel: readTerminalLabel(),
            lineStart,
            lineEnd,
            text: normalizedText,
          },
        };
      };

      const addSelectionToChat = (clipboardText: string) => {
        // Output keeps moving the selected rows while a menu is open, so take
        // the line numbers now, and only if the same text is still selected.
        const current = readSelectionAction();
        if (current?.clipboardText !== clipboardText) return;
        handleAddTerminalContext(current.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      };

      const reportIfCurrent = (requestId: number, error: unknown, fallback: string) => {
        if (requestId !== selectionActionRequestIdRef.current) return;
        const activeTerminal = terminalRef.current;
        if (activeTerminal) {
          writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallback);
        }
      };

      const focusIfCurrent = (requestId: number) => {
        if (requestId === selectionActionRequestIdRef.current) {
          terminalRef.current?.focus();
        }
      };

      const copySelection = async (text: string, requestId: number) => {
        try {
          await writeTextToClipboard(text, "terminal selection");
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to copy terminal selection");
        }
        focusIfCurrent(requestId);
      };

      const pasteFromClipboard = async (requestId: number) => {
        if (!hasTerminalWriteAccess()) return;
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        try {
          // Let the surface own clipboard reads so paste shortcuts can supersede an in-flight menu paste.
          await activeTerminal.pasteFromClipboard(
            () => readTextFromClipboard("terminal input"),
            () => requestId === selectionActionRequestIdRef.current,
          );
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to read the clipboard");
          return;
        }
        focusIfCurrent(requestId);
      };

      const showTerminalContextMenu = async (event: MouseEvent) => {
        if (!localApi || !terminalRef.current) return;
        // Prevent default before awaits; native menus offer a permanently disabled Paste over the canvas.
        event.preventDefault();
        clearSelectionAction();
        const selectionAction = readSelectionAction();
        const requestId = selectionActionRequestIdRef.current;
        let clicked: TerminalContextMenuAction | null;
        try {
          clicked = await localApi.contextMenu.show(
            terminalContextMenuItems({
              hasSelection: selectionAction !== null,
              canAddToChat: canAddSelectionToChat(),
              readOnly: !hasTerminalWriteAccess(),
            }),
            { x: event.clientX, y: event.clientY },
          );
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to open the terminal context menu");
          focusIfCurrent(requestId);
          return;
        }
        if (requestId !== selectionActionRequestIdRef.current || clicked === null) {
          return;
        }
        switch (clicked) {
          case "add-to-chat":
            if (selectionAction && canAddSelectionToChat()) {
              addSelectionToChat(selectionAction.clipboardText);
            }
            return;
          case "copy":
            if (selectionAction) await copySelection(selectionAction.clipboardText, requestId);
            return;
          case "paste":
            await pasteFromClipboard(requestId);
            return;
          case "select-all":
            terminalRef.current?.selectAll();
            focusIfCurrent(requestId);
            return;
          case "scroll-to-bottom":
            terminalRef.current?.scrollToBottom();
            focusIfCurrent(requestId);
            return;
        }
      };

      const showSelectionAction = async (pointer: SelectionActionPoint | null) => {
        if (!localApi) {
          clearSelectionAction();
          return;
        }
        if (openSelectionMenuRequestIdRef.current === selectionActionRequestIdRef.current) {
          return;
        }
        const nextAction = readSelectionAction(pointer);
        if (!nextAction) {
          clearSelectionAction();
          return;
        }
        const requestId = ++selectionActionRequestIdRef.current;
        openSelectionMenuRequestIdRef.current = requestId;
        const clicked = await localApi.contextMenu
          .show(
            terminalSelectionMenuItems({ canAddToChat: canAddSelectionToChat() }),
            nextAction.position,
          )
          .finally(() => {
            if (openSelectionMenuRequestIdRef.current === requestId) {
              openSelectionMenuRequestIdRef.current = null;
            }
          });
        if (requestId !== selectionActionRequestIdRef.current || clicked === null) {
          return;
        }
        switch (clicked) {
          case "add-to-chat":
            if (canAddSelectionToChat()) addSelectionToChat(nextAction.clipboardText);
            return;
          case "copy":
            await copySelection(nextAction.clipboardText, requestId);
            return;
        }
      };

      const sendTerminalInput = async (data: string, fallbackError: string) => {
        if (!hasTerminalWriteAccess()) return;
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const result = await writeTerminal(data);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          writeSystemMessage(
            activeTerminal,
            error instanceof Error ? error.message : fallbackError,
          );
        }
      };

      function handleBeforeKey(event: KeyboardEvent): boolean {
        const currentKeybindings = readKeybindings();
        const options = { context: { terminalFocus: true, terminalOpen: true } };
        if (preventTerminalCloseShortcut(event, currentKeybindings)) {
          return false;
        }
        if (
          isTerminalToggleShortcut(event, currentKeybindings, options) ||
          isTerminalSplitShortcut(event, currentKeybindings, options) ||
          isTerminalSplitVerticalShortcut(event, currentKeybindings, options) ||
          isTerminalNewShortcut(event, currentKeybindings, options) ||
          isDiffToggleShortcut(event, currentKeybindings, options)
        ) {
          return false;
        }

        const navigationData = terminalNavigationShortcutData(event);
        if (navigationData !== null) {
          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput(navigationData, "Failed to move cursor");
          return false;
        }

        const deleteData = terminalDeleteShortcutData(event);
        if (deleteData !== null) {
          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput(deleteData, "Failed to delete terminal input");
          return false;
        }

        if (!isTerminalClearShortcut(event)) return true;
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput("\u000c", "Failed to clear terminal");
        return false;
      }

      function handleLinkActivate(text: string, event: MouseEvent): void {
        if (!canActivateTerminalLink(text)) return;
        const latestTerminal = terminalRef.current;
        if (!latestTerminal) return;
        if (isTerminalUrl(text)) {
          if (!localApi) {
            writeSystemMessage(latestTerminal, "Opening links is unavailable in this browser.");
            return;
          }
          const fallbackToBrowser = () => {
            void localApi.shell.openExternal(text).catch((error: unknown) => {
              writeSystemMessage(
                latestTerminal,
                error instanceof Error ? error.message : "Unable to open link",
              );
            });
          };
          if (!readEnvironmentScope(environmentId, AuthPreviewOperateScope)) {
            fallbackToBrowser();
            return;
          }
          void openLinkInPreview(text, event.metaKey || event.ctrlKey, fallbackToBrowser).catch(
            (error: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Unable to open link",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            },
          );
          return;
        }
        const target = resolvePathLinkTarget(text, cwd);
        void (async () => {
          const result = await openTerminalPath(target);
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
            return;
          }
          const error = squashAtomCommandFailure(result);
          writeSystemMessage(
            latestTerminal,
            error instanceof Error ? error.message : "Unable to open path",
          );
        })();
      }

      function handleData(data: string): void {
        if (!hasTerminalWriteAccess()) return;
        void (async () => {
          const result = await writeTerminal(data);
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          writeSystemMessage(
            terminal,
            error instanceof Error ? error.message : "Terminal write failed",
          );
        })();
      }

      function handleSelectionChange(): void {
        if (terminalRef.current?.hasSelection()) {
          return;
        }
        const shouldClear = shouldClearTerminalSelectionAction({
          actionPending: selectionActions?.pending ?? false,
          openMenuRequestId: openSelectionMenuRequestIdRef.current,
          currentRequestId: selectionActionRequestIdRef.current,
        });
        if (!shouldClear) return;
        clearSelectionAction();
      }

      selectionActions = observeSelectionActions({
        element: mount,
        onSelection: (pointer) => {
          void showSelectionAction(pointer);
        },
        onDismiss: (reason) => dismissSelectionAction(reason === "interaction"),
      });
      setupCleanups.push(() => selectionActions?.dispose());

      const themeObserver = new MutationObserver(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        activeTerminal.setTheme(terminalThemeFromApp(containerRef.current));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      setupCleanups.push(() => themeObserver.disconnect());

      const fitTimer = window.setTimeout(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const wasAtBottom = activeTerminal.isAtBottom();
        activeTerminal.fit();
        if (wasAtBottom) {
          activeTerminal.scrollToBottom();
        }
      }, 30);
      setupCleanups.push(() => window.clearTimeout(fitTimer));

      const cleanups = setupCleanups;
      setupCleanups = [];
      setupTerminal = null;
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
        if (terminalRef.current === terminal) terminalRef.current = null;
        terminal.dispose();
      };
    };

    void setup()
      .then((nextTeardown) => {
        if (cancelled) {
          nextTeardown?.();
          return;
        }
        teardown = nextTeardown;
      })
      .catch((error: unknown) => {
        for (const cleanup of setupCleanups.toReversed()) cleanup();
        setupCleanups = [];
        if (terminalRef.current === setupTerminal) terminalRef.current = null;
        setupTerminal?.dispose();
        setupTerminal = null;
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Unable to initialize libghostty-vt";
        mount.textContent = `${message}. Close and reopen the terminal to retry.`;
      });

    return () => {
      cancelled = true;
      const hadFocus = mount.contains(document.activeElement);
      teardown?.();
      if (hasTerminalWriteAccess() && hadFocus && mount.isConnected) {
        mount.focus({ preventScroll: true });
      }
    };
  }, [cwd, environmentId, terminalId]);

  const attachContainer = (mount: HTMLDivElement) => {
    containerRef.current = mount;
    const focus = () =>
      focusTerminalViewport({
        mount,
        surface: terminalRef.current,
        canOperate: readEnvironmentScope(environmentId, AuthTerminalOperateScope),
        visible: visibleRef.current,
      });
    // Once per viewport: a re-attached ref (a fresh callback identity) must not
    // pull focus back on every render of a chatty terminal. As a request, it
    // waits for the grant or for the viewport to show when it cannot focus yet.
    if (autoFocus && !autoFocusedRef.current) {
      autoFocusedRef.current = true;
      focusTerminal(threadRef, terminalId);
    }
    const unregister = registerTerminalFocusTarget({
      threadRef,
      terminalId,
      focus,
    });
    return () => {
      unregister();
      containerRef.current = null;
    };
  };
  return (
    <div
      ref={attachContainer}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden bg-(--terminal-background)"
    />
  );
}

