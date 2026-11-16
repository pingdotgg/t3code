import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type ContextMenuItem,
  type ScopedThreadRef,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  DISPLAY_MODES,
  type DisplayMode,
  NORMAL_DISPLAY,
  NORMAL_DISPLAY_MODE,
  type ThreadDisplay,
  threadDisplay,
} from "@t3tools/shared/displayModes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { use } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { TimelineEntry } from "../../session-logic";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { SubThreadViewContext } from "../subThreads/subThreadsState";
import { applyDisplayMode } from "./displayModeTimeline";

/** A Dashboard item's id names the state that a click sets, so a stale menu sets what it showed. */
export type DisplayModeMenuId =
  | "display-mode"
  | `display-mode:${string}`
  | "dashboard:on"
  | "dashboard:off";

const noSettingsAtom = Atom.make<ServerSettings | null>(null);

/** Returns the thread's mode and Dashboard switch. A draft thread is Normal with no Dashboard. */
export function useThreadDisplay(threadRef: ScopedThreadRef | null): ThreadDisplay {
  const settings = useAtomValue(
    threadRef === null
      ? noSettingsAtom
      : serverEnvironment.settingsValueAtom(threadRef.environmentId),
  );
  return threadRef === null ? NORMAL_DISPLAY : threadDisplay(settings, threadRef.threadId);
}

/** Returns the thread's mode. A draft thread is Normal. */
export const useThreadDisplayMode = (threadRef: ScopedThreadRef | null): DisplayMode =>
  useThreadDisplay(threadRef).mode;

const MODE_SURFACE_KINDS = ["replies", "dashboard"] as const;
export type ModeSurfaceKind = (typeof MODE_SURFACE_KINDS)[number];

/** The right-panel tabs that `display` has, in menu order. */
export const modeSurfaces = (display: ThreadDisplay): ReadonlyArray<ModeSurfaceKind> => [
  ...(display.mode.subThreads ? (["replies"] as const) : []),
  ...(display.dashboard ? (["dashboard"] as const) : []),
];

/**
 * Returns the rows that the thread's mode draws from `entries`. `repliesChosen` is true when the
 * mode itself picks which replies show, so the timeline must not hide any of them. Inside a
 * SubThreadViewContext, the rows are that sub-thread's.
 */
export function useDisplayModeTimeline(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<TimelineEntry>,
  activeThreadKey: string | null,
): {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly repliesChosen: boolean;
  /**
   * The key that the thread-switch cache keeps these rows under, one per mode, since modes load
   * different views. A sub-thread's view keeps none.
   */
  readonly rememberKey: string | null;
} {
  const mode = useThreadDisplayMode(threadRef);
  const subThread = use(SubThreadViewContext);
  return {
    entries: applyDisplayMode(mode, entries, mode.subThreads ? subThread : null),
    repliesChosen: mode.subThreads,
    rememberKey:
      subThread === null && activeThreadKey !== null ? `${activeThreadKey}\u0000${mode.id}` : null,
  };
}

/** The thread's mode and Dashboard switch, read outside React. */
export const readThreadDisplay = (threadRef: ScopedThreadRef) =>
  threadDisplay(
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(threadRef.environmentId)),
    threadRef.threadId,
  );

/**
 * Returns the Display mode submenu and the Enable Dashboard switch beside it, each only when the
 * server can store it.
 */
export function displayModeMenuItems(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ContextMenuItem<DisplayModeMenuId>> {
  const capabilities = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(threadRef.environmentId)?.environment.capabilities;
  return displayMenuItems({
    modes: capabilities?.threadDisplayModes === true,
    dashboard: capabilities?.threadDashboards === true,
    current: readThreadDisplay(threadRef),
    disabled: !readEnvironmentScope(threadRef.environmentId, AuthSettingsWriteScope),
  });
}

/** The items `displayModeMenuItems` returns, for a server that can store `modes` and `dashboard`. */
export function displayMenuItems(input: {
  readonly modes: boolean;
  readonly dashboard: boolean;
  readonly current: ThreadDisplay;
  readonly disabled: boolean;
}): ReadonlyArray<ContextMenuItem<DisplayModeMenuId>> {
  const { current, disabled } = input;
  return [
    ...(input.modes
      ? [
          {
            id: "display-mode" as const,
            label: "Display mode",
            icon: "message-square",
            disabled,
            children: DISPLAY_MODES.map((mode) => ({
              id: `display-mode:${mode.id}` as const,
              label: mode.label,
              checked: mode === current.mode,
            })),
          },
        ]
      : []),
    ...(input.dashboard
      ? [
          {
            id: current.dashboard ? ("dashboard:off" as const) : ("dashboard:on" as const),
            label: "Enable Dashboard",
            checked: current.dashboard,
            disabled,
          },
        ]
      : []),
  ];
}

type DisplayModeAction = Exclude<DisplayModeMenuId, "display-mode">;

const isDisplayModeAction = (action: string): action is DisplayModeAction =>
  action.startsWith("display-mode:") || action === "dashboard:on" || action === "dashboard:off";

/**
 * Returns the settings patch for a menu item, which writes only that item's key, or null when the
 * thread's stored mode id is already the one the item sets.
 */
export function displayModePatch(
  threadRef: ScopedThreadRef,
  action: DisplayModeAction,
  storedModeId: string | undefined,
): ServerSettingsPatch | null {
  const { threadId } = threadRef;
  if (action === "dashboard:on" || action === "dashboard:off")
    return { threadDashboards: { [threadId]: action === "dashboard:on" ? true : null } };
  const modeId = action.slice("display-mode:".length);
  // An older server can store a removed mode, which shows as Normal; choosing Normal clears it.
  if (modeId === (storedModeId ?? NORMAL_DISPLAY_MODE.id)) return null;
  return { threadDisplayModes: { [threadId]: modeId === NORMAL_DISPLAY_MODE.id ? null : modeId } };
}

/** Closes the thread's Replies and Dashboard tabs that `display` does not have. */
export function closeModeSurfacesOutside(threadRef: ScopedThreadRef, display: ThreadDisplay): void {
  const kept = modeSurfaces(display);
  const store = useRightPanelStore.getState();
  const panel = selectThreadRightPanelState(store.byThreadKey, threadRef);
  for (const kind of MODE_SURFACE_KINDS) {
    if (!kept.includes(kind) && panel.surfaces.some((surface) => surface.kind === kind)) {
      store.closeSurface(threadRef, kind);
    }
  }
}

/**
 * Returns a menu handler. For a Display mode or Dashboard item, the handler saves what the item sets
 * and resolves to true, even when the save fails. For any other item, it resolves to false.
 */
export function useDisplayModeMenuAction() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return async (threadRef: ScopedThreadRef, action: string): Promise<boolean> => {
    if (!isDisplayModeAction(action)) return false;
    const settings = appAtomRegistry.get(
      serverEnvironment.settingsValueAtom(threadRef.environmentId),
    );
    const patch = displayModePatch(
      threadRef,
      action,
      settings?.threadDisplayModes[threadRef.threadId],
    );
    if (patch === null) return true;
    const result = await updateSettings({
      environmentId: threadRef.environmentId,
      input: { patch },
    });
    if (result._tag === "Success") {
      closeModeSurfacesOutside(threadRef, threadDisplay(result.value, threadRef.threadId));
    }
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to change display mode",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return true;
  };
}
