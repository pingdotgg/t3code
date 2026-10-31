/**
 * Capture-phase layout commands must work inside terminal and composer focus.
 * The palette calls the same actions so keyboard and menu placement stay consistent.
 */
import {
  LAYOUT_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type LayoutKeybindingCommand,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { evaluateWhenNode } from "@t3tools/shared/keybindingMatching";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isKeybindingCaptureTarget } from "../lib/keybindingCapture";
import { isModalDialogOpen } from "../lib/modalDialog";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import { renderWaitingChatNow } from "./chatRenderGate";
import { isLayoutDragActive } from "./layoutDrag";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { closeLayoutTabByUser } from "./layoutActions";
import { toggleThreadSidePane, toggleThreadTerminalPane } from "./openRules";
import { findThreadChat } from "./surfaceSync";
import {
  isThreadlessSurfacesRef,
  readThreadlessHome,
  threadlessSurfacesProjectRef,
} from "../threadlessSurfaces";
import {
  findLayoutPane,
  findLayoutTabByContent,
  selectFocusedPane,
  selectFocusedTab,
  selectFocusedWorkspace,
  type LayoutState,
} from "./layoutModel";
import { RELATED_CHAT_COMMANDS } from "./layoutPaneContext";
import { landPendingLayoutFocus, selectIntendedLayout, useLayoutStore } from "./layoutStore";
import { toggleLayoutShortcutSheet } from "./layoutOverlayStore";

/** Commands the chat route handles itself: they open tabs, which needs the route. */
export const ROUTE_LAYOUT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.splitRight",
  "layout.splitDown",
  "layout.fill",
]);

export function isLayoutCommand(command: string | null): command is LayoutKeybindingCommand {
  return (
    command !== null && (LAYOUT_KEYBINDING_COMMANDS as ReadonlyArray<string>).includes(command)
  );
}

/**
 * What the layout keys still do while the overview is open: move the
 * selection, move the selected pane or workspace, step rows. The rest only
 * make sense on the strip, so the overview swallows them.
 */
const OVERVIEW_LAYOUT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.overview",
  "layout.focusLeft",
  "layout.focusRight",
  "layout.focusUp",
  "layout.focusDown",
  "layout.moveLeft",
  "layout.moveRight",
  "layout.moveUp",
  "layout.moveDown",
  "layout.focusFirstColumn",
  "layout.focusLastColumn",
  "layout.focusWorkspaceDown",
  "layout.focusWorkspaceUp",
  "layout.moveToWorkspaceDown",
  "layout.moveToWorkspaceUp",
  "layout.moveWorkspaceDown",
  "layout.moveWorkspaceUp",
]);

/** Commands after which a hint names the workspace the pane landed in (pen NFUgn). */
const WORKSPACE_HINT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.moveToWorkspaceDown",
  "layout.moveToWorkspaceUp",
  "layout.moveWorkspaceDown",
  "layout.moveWorkspaceUp",
]);

/**
 * Workspaces as the hints count them: every workspace with something in it,
 * plus the empty one only while it has focus.
 */
export function countedLayoutWorkspaces(layout: LayoutState) {
  return layout.workspaces.filter(
    (workspace) => workspace.columns.length > 0 || workspace.id === layout.focusedWorkspaceId,
  );
}

/** Commands after which a hint shows where the pane landed (pen Q5TwsK). */
const COLUMN_HINT_COMMANDS: ReadonlySet<LayoutKeybindingCommand> = new Set([
  "layout.moveLeft",
  "layout.moveRight",
  "layout.pullLeft",
  "layout.pullRight",
]);

/** Run a layout command against the store; DOM focus follows the focused pane. */
export function runLayoutCommand(command: LayoutKeybindingCommand): void {
  const store = useLayoutStore.getState();
  const before = store.layout;
  switch (command) {
    case "layout.focusLeft":
      store.focusDirection("left");
      break;
    case "layout.focusRight":
      store.focusDirection("right");
      break;
    case "layout.focusUp":
      store.focusDirection("up");
      break;
    case "layout.focusDown":
      store.focusDirection("down");
      break;
    case "layout.moveLeft":
      store.moveFocused("left");
      break;
    case "layout.moveRight":
      store.moveFocused("right");
      break;
    case "layout.moveUp":
      store.moveFocused("up");
      break;
    case "layout.moveDown":
      store.moveFocused("down");
      break;
    case "layout.focusFirstColumn":
      store.focusColumnEdge("first");
      break;
    case "layout.focusLastColumn":
      store.focusColumnEdge("last");
      break;
    case "layout.cycleColumnWidth": {
      const pane = selectFocusedPane(store.layout);
      const column = pane ? findLayoutPane(store.layout, pane.id)?.column : null;
      if (column) store.cycleColumnWidth(column.id);
      break;
    }
    case "layout.centerColumn":
      store.requestCenter();
      break;
    case "layout.pullLeft":
      store.pullPane("left");
      break;
    case "layout.pullRight":
      store.pullPane("right");
      break;
    case "layout.shortcutSheet":
      toggleLayoutShortcutSheet();
      return;
    case "layout.focusWorkspaceDown":
      store.focusWorkspaceStep(1);
      break;
    case "layout.focusWorkspaceUp":
      store.focusWorkspaceStep(-1);
      break;
    case "layout.moveToWorkspaceDown":
      store.moveTabToWorkspace(1);
      break;
    case "layout.moveToWorkspaceUp":
      store.moveTabToWorkspace(-1);
      break;
    case "layout.moveWorkspaceDown":
      store.moveWorkspace(1);
      break;
    case "layout.moveWorkspaceUp":
      store.moveWorkspace(-1);
      break;
    case "layout.overview":
      store.setOverviewOpen(!store.overviewOpen);
      return;
    case "layout.splitRight":
    case "layout.splitDown":
    case "layout.fill":
      return;
  }
  // Keyboard focus lands a frame later (layoutStore's focusSoon); hint what it lands on.
  const layout = selectIntendedLayout();
  // The overview shows where a pane landed; a hint would float off the stage.
  if (layout === before || store.overviewOpen) return;
  const workspace = selectFocusedWorkspace(layout);
  if (WORKSPACE_HINT_COMMANDS.has(command)) {
    const workspaces = countedLayoutWorkspaces(layout);
    store.showHint({
      kind: "workspace",
      workspaceId: workspace.id,
      index: workspaces.indexOf(workspace),
      count: workspaces.length,
      command,
    });
    return;
  }
  if (!COLUMN_HINT_COMMANDS.has(command)) return;
  const index = workspace.columns.findIndex((column) =>
    column.panes.some((pane) => pane.id === workspace.focusedPaneId),
  );
  if (index === -1) return;
  store.showHint({ kind: "column", index, count: workspace.columns.length, command });
}

/**
 * The chat whose ChatView answers this command: the focused one, or for a
 * focused surface tab its thread's chat, which answers only its thread's own.
 */
function answeringChatTabId(layout: LayoutState, command: string): string | null {
  const focused = selectFocusedTab(layout);
  if (focused?.content.kind !== "surface") return focused?.id ?? null;
  if (!RELATED_CHAT_COMMANDS.has(command)) return null;
  return findThreadChat(layout, focused.content.threadRef)?.tab.id ?? null;
}

/** A key that types a character, as type-to-focus hears it. */
function isTypedText(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.isComposing
  );
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Alt", "Control", "Meta", "Shift"]);

/** Commands the chat route answers without a ChatView, so a new tab can keep waiting. */
const CHAT_FREE_COMMANDS: ReadonlySet<string> = new Set([
  "tab.new",
  "tab.next",
  "tab.previous",
  "chat.new",
  "chat.newLocal",
  "chat.newWithoutProject",
  "commandPalette.toggle",
  "sidebar.toggle",
]);

/**
 * Window-level handler for the layout map, mounted with the layout host.
 * Capture phase, so an editor, a terminal or a pane's own key handling
 * cannot swallow the chord first.
 */
export function useLayoutKeyboardCommands(): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the layout command scope for the mounted host and remove it on unmount.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen() || isModalDialogOpen()) return;
      if (isKeybindingCaptureTarget(event.target)) return;
      const command = resolveShortcutCommand(
        event,
        appAtomRegistry.get(primaryServerKeybindingsAtom),
        {
          context: {
            terminalFocus: isTerminalFocused(),
            previewFocus: isPreviewFocused(),
            editableFocus: isEditableFocused(event.target),
            modelPickerOpen: isModelPickerOpen(),
          },
        },
      );
      // Any other key lands queued keyboard focus first, so it reaches the
      // pane focus is going to; layout moves keep queueing onto it.
      if (!isLayoutCommand(command) && !MODIFIER_KEYS.has(event.key)) landPendingLayoutFocus();
      // cmd+W closes the focused tab, whichever element holds DOM focus and
      // whether or not a chat has rendered: the layout answers it, no pane.
      // rightPanel.close (a retired default some keep) closes surfaces only.
      if (command === "tab.close" || command === "rightPanel.close") {
        const focused = selectFocusedTab(useLayoutStore.getState().layout);
        // Nothing focused (an empty workspace): the key keeps its native meaning.
        if (!focused || (command === "rightPanel.close" && focused.content.kind !== "surface")) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) closeLayoutTabByUser(focused.id);
        return;
      }
      // A focused chat waiting for its first render must mount before replaying its shortcuts or
      // typed text; the overview retains its own keyboard ownership.
      const layout = useLayoutStore.getState().layout;
      const waitingChatTabId =
        command === null
          ? isTypedText(event) &&
            !isEditableFocused(event.target) &&
            !useLayoutStore.getState().overviewOpen
            ? (selectFocusedTab(layout)?.id ?? null)
            : null
          : !isLayoutCommand(command) && !CHAT_FREE_COMMANDS.has(command)
            ? answeringChatTabId(layout, command)
            : null;
      if (renderWaitingChatNow(waitingChatTabId)) {
        event.stopImmediatePropagation();
        const replay = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          location: event.location,
          repeat: event.repeat,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        });
        // Unhandled, the key keeps its native meaning, as it would have.
        if (!(event.target ?? window).dispatchEvent(replay)) event.preventDefault();
        return;
      }
      // A surface tab whose thread's chat is not open answers its thread's
      // pane toggles here; with the chat open, the related chat does.
      const focusedSurface = selectFocusedTab(useLayoutStore.getState().layout);
      if (
        focusedSurface?.content.kind === "surface" &&
        (command === "rightPanel.toggle" || command === "terminal.toggle") &&
        !findThreadChat(useLayoutStore.getState().layout, focusedSurface.content.threadRef)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        const { threadRef } = focusedSurface.content;
        if (command === "rightPanel.toggle") toggleThreadSidePane(threadRef, () => false);
        // A threadless surface's terminal is its project's, or with none, the server's home.
        else if (
          !isThreadlessSurfacesRef(threadRef) ||
          threadlessSurfacesProjectRef(threadRef) ||
          readThreadlessHome(threadRef)
        ) {
          toggleThreadTerminalPane(threadRef, () =>
            useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true),
          );
        }
        return;
      }
      // alt+cmd+B on the launcher it opened beside a thread closes it again.
      if (command === "rightPanel.toggle") {
        const layout = useLayoutStore.getState().layout;
        const focused = selectFocusedTab(layout);
        if (focused?.content.kind !== "launcher" || focused.content.context === null) return;
        const chat = findLayoutTabByContent(layout, {
          kind: "chat",
          target: focused.content.context,
        });
        if (!chat) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        useLayoutStore.getState().closeTab(focused.id);
        useLayoutStore.getState().focusTab(chat.tab.id);
        return;
      }
      if (!isLayoutCommand(command) || ROUTE_LAYOUT_COMMANDS.has(command)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && command === "layout.shortcutSheet") return;
      // The overview owns the keyboard while open; its moves still pass.
      if (useLayoutStore.getState().overviewOpen && !OVERVIEW_LAYOUT_COMMANDS.has(command)) return;
      if (isLayoutDragActive()) return;
      runLayoutCommand(command);
    };
    return registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => {
          onKeyDown(event);
          return event.defaultPrevented;
        },
      },
    );
  }, []);

  useDesktopLayoutShortcutForwarding(keybindings);
}

/**
 * On desktop a focused browser view gets keys before this window does. Tell
 * the shell which chords belong to the layout (as bound now, custom keys
 * included) so it hands them back instead of the page seeing them; a
 * forwarded chord replays here as a keydown on the window.
 */
function useDesktopLayoutShortcutForwarding(keybindings: ResolvedKeybindingsConfig): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Update Electron browser-view key forwarding when configured bindings change.
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.setForwardedKeyChords) return;
    const mac = isMacPlatform(navigator.platform);
    // Only chords this platform binds: a forwarded chord never reaches the
    // page, so one no rule claims here would just be eaten (AltGr letters,
    // option+shift+arrow selection).
    const platform = { isMac: mac, isDesktop: true, isWeb: false };
    const commands: KeybindingCommand[] = [
      ...LAYOUT_KEYBINDING_COMMANDS,
      "tab.close",
      "tab.new",
      "rightPanel.toggle",
      "terminal.toggle",
    ];
    const shortcuts = commands.flatMap((command) =>
      keybindings.flatMap((binding) => {
        if (binding.command !== command) return [];
        if (binding.whenAst && !evaluateWhenNode(binding.whenAst, platform)) return [];
        const { shortcut } = binding;
        return [
          {
            key: shortcut.key,
            metaKey: shortcut.metaKey || (shortcut.modKey && mac),
            ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
            altKey: shortcut.altKey,
            shiftKey: shortcut.shiftKey,
          },
        ];
      }),
    );
    void preview.setForwardedKeyChords(shortcuts.slice(0, 256)).catch(() => undefined);
  }, [keybindings]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to Electron browser-view forwarded keys for the mounted layout host.
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.onForwardedKeyChord) return;
    return preview.onForwardedKeyChord((input) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: input.key,
          code: input.code,
          metaKey: input.metaKey,
          ctrlKey: input.ctrlKey,
          altKey: input.altKey,
          shiftKey: input.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }, []);
}
