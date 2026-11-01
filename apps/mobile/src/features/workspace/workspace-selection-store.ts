import type { NavigationState } from "@react-navigation/native";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Linking from "expo-linking";
import { AppState, Dimensions, Platform } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { deriveLayout } from "../../lib/layout";
import {
  NATIVE_METRICS_TIMEOUT_MS,
  nativeWorkspaceColumnsSupportedFor,
} from "../../native/NativeWorkspaceColumns";
import {
  currentNativeLayoutMetrics,
  firstNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { loadPreferences, savePreferencesPatch } from "../../persistence/imperative";
import { rootStackState, type RootStackNavigation } from "../../lib/root-stack-reset";
import { workspaceRoutesOf } from "../layout/workspace-overlay-routes";
import type { WorkspaceSelections } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import {
  environmentThreadShells,
  startOpeningEnvironmentThread,
  threadEnvironment,
  threadFamilies,
} from "../../state/threads";
import {
  rememberedSettingsPage,
  workspaceSelectionsIn,
  type WorkspaceSelectionCheck,
} from "./workspace-tab-navigation";

// Only iOS columns reopen a remembered page; Android always opens a tab on its list.
const REMEMBERS = Platform.OS === "ios";

// Read synchronously when a tab opens, so it lives in memory and is saved when the app leaves
// the foreground rather than on every chat switch.
let selections: WorkspaceSelections = {};
let saved = selections;
let hydration: Promise<void> | null = null;
let rememberedFamily: {
  readonly selection: NonNullable<WorkspaceSelections["threads"]>;
  readonly release: () => void;
} | null = null;

// A shell may leave the remembered chat out (older settled, idle subagent). Its mounted family
// keeps the chat's row in the thread index while it exists, so the check can trust that index.
function mountRememberedFamily() {
  const selection = selections.threads;
  const mounted = rememberedFamily?.selection;
  if (
    selection?.environmentId === mounted?.environmentId &&
    selection?.threadId === mounted?.threadId
  ) {
    return;
  }
  rememberedFamily?.release();
  rememberedFamily = selection
    ? {
        selection,
        release: threadFamilies.mount(
          appAtomRegistry,
          selection.environmentId as EnvironmentId,
          selection.threadId as ThreadId,
        ),
      }
    : null;
}

function save() {
  const writing = selections;
  if (saved === writing) return;
  // Marked saved only once written, so a failed write is retried on the next background.
  void savePreferencesPatch({ workspaceSelections: writing })
    .then(() => {
      saved = writing;
    })
    .catch(() => undefined);
}

// Route keys only name routes of the session that wrote them; a saved one would make a tab rebuild
// its page under a stale key, which UIKit animates as a pop and a push.
function withoutRouteKeys(saved: WorkspaceSelections | undefined): WorkspaceSelections {
  const omitKey = <Selection extends { readonly key?: string }>({ key: _, ...rest }: Selection) =>
    rest;
  const { threads, pullRequests, settingsKey: _, threadsDraft: _draft, ...rest } = saved ?? {};
  return {
    ...rest,
    ...(threads ? { threads: omitKey(threads) } : {}),
    ...(pullRequests ? { pullRequests: omitKey(pullRequests) } : {}),
  };
}

/** Loads the saved selections once; pages visited before it resolves win over saved ones. */
export function hydrateWorkspaceSelections() {
  if (!REMEMBERS) return Promise.resolve();
  hydration ??= loadPreferences()
    .then((preferences) => {
      selections = { ...withoutRouteKeys(preferences.workspaceSelections), ...selections };
      saved = selections;
      mountRememberedFamily();
      AppState.addEventListener("change", (status) => {
        if (status !== "active") save();
      });
    })
    .catch(() => undefined);
  return hydration;
}

export function currentWorkspaceSelections() {
  return selections;
}

/**
 * The navigation container's `onReady` and `onStateChange`: remembers the page each tab is
 * showing. The initial state, such as a cold start's reopened chat, reaches only `onReady`.
 */
export function recordWorkspaceSelections(state: NavigationState | undefined) {
  if (!REMEMBERS || !state) return;
  selections = workspaceSelectionsIn(state.routes.slice(0, state.index + 1), selections);
  mountRememberedFamily();
}

function environmentRemoved(environmentId: string) {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return (
    catalog.isReady &&
    !appAtomRegistry
      .get(environmentPresentations.presentationsAtom)
      .has(environmentId as EnvironmentId)
  );
}

/**
 * A remembered chat is gone once its environment was removed, or once that environment's
 * snapshot has loaded without it and the current shell's read of its family has settled. Before
 * then the chat's own page decides.
 */
export const workspaceSelectionCheck: WorkspaceSelectionCheck = {
  thread: (selection) => {
    if (environmentRemoved(selection.environmentId)) return false;
    const environmentId = selection.environmentId as EnvironmentId;
    const threadId = selection.threadId as ThreadId;
    if (!appAtomRegistry.get(threadEnvironment.snapshotAtom(environmentId))) return true;
    if (
      appAtomRegistry
        .get(environmentThreadShells.environmentThreadIndexAtom(environmentId))
        .has(threadId)
    ) {
      return true;
    }
    const read = threadFamilyRead(
      appAtomRegistry.get(threadFamilies.familyAtom(environmentId, threadId)),
    );
    // Otherwise a failed read would keep reopening the chat until the next shell.
    if (read === "failed") threadFamilies.refresh(appAtomRegistry, environmentId, threadId);
    return read !== "settled";
  },
  pullRequest: (selection) => !environmentRemoved(selection.environmentId),
};

/** Whether the window lays the workspace out in columns, by the rule the layout itself uses. */
export function workspaceHasColumns() {
  const metrics = currentNativeLayoutMetrics();
  const { width, height } = metrics ?? Dimensions.get("window");
  return deriveLayout({
    width,
    height,
    nativeMetrics: metrics,
    nativeWorkspace: nativeWorkspaceColumnsSupportedFor(metrics),
  }).usesSplitView;
}

/** The Settings page a bare `settings` link opens beside the list when there are columns. */
export function settingsLinkPage() {
  return REMEMBERS && workspaceHasColumns() ? rememberedSettingsPage(selections) : undefined;
}

/**
 * Where a cold start without a link opens. A window that starts with columns reopens the last
 * chat beside the list instead of an empty detail column; a compact window opens on the list.
 * It waits for the first layout metrics as long as the workspace itself does.
 */
export async function launchWorkspaceURL(): Promise<string | null> {
  if (!REMEMBERS) return null;
  const metrics = firstNativeLayoutMetrics(NATIVE_METRICS_TIMEOUT_MS);
  await hydrateWorkspaceSelections();
  const thread = selections.threads;
  // Read the chat's cached copy while the layout metrics are still on their way.
  if (thread) {
    startOpeningEnvironmentThread(
      thread.environmentId as EnvironmentId,
      thread.threadId as ThreadId,
    );
  }
  await metrics;
  if (!thread || !workspaceHasColumns() || !workspaceSelectionCheck.thread(thread)) return null;
  return Linking.createURL(
    `threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
  );
}

/** Whether the workspace shows its first detail page, directly above its list. */
export function firstWorkspaceDetailOpen(navigation: RootStackNavigation) {
  const state = rootStackState(navigation);
  if (!state) return false;
  const { workspace, overlays } = workspaceRoutesOf(state.routes.slice(0, state.index + 1));
  const list = (name: string | undefined) => name === "Home" || name === "Settings";
  return overlays.length === 0 && !list(workspace.at(-1)?.name) && list(workspace.at(-2)?.name);
}
