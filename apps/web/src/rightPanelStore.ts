import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useClosedViewStore } from "./closedViewStore";
import { m } from "./i18n/messages";
import { resolveStorage } from "./lib/storage";
import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import {
  decodeLinkedThreadSurface,
  linkedThreadSurface,
  type LinkedThreadSurface,
} from "./linkedThreadSurface";
import type { ThreadPanelPresentation } from "./rightPanelLayout";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, type ChatFileAttachment } from "./types";
import {
  nextUnseenRightPanelGroups,
  reconcileTerminalSurfaceIds,
  rightPanelGroupOf,
  visibleRightPanelGroups,
  type RightPanelRailGroup,
} from "./components/RightPanelTabs.logic";

const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "preview",
  "device",
  "terminal",
  "pull-request",
  "pull-requests",
  "issue",
  "thread",
  "linked-thread",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type PullRequestDetailTab = "summary" | "guide" | "timeline" | "code";

export interface DeviceTabTarget {
  hostId: string;
  deviceId: string;
  platform: "ios" | "android";
  name: string;
}

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "device" | `device:${string}`; kind: "device"; target?: DeviceTabTarget; title?: string }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | {
      id: "files";
      kind: "files";
      /** Set when breadcrumbs moved a folder browser up to the workspace root. */
      folderTrail?: string;
    }
  | {
      id: `file:${string}` | `attachment:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
      attachment?: ChatFileAttachment;
      /** Deepest workspace path retained for navigating back down after moving up. */
      folderTrail?: string;
    }
  | {
      id: `pull-request:${string}`;
      kind: "pull-request";
      /** Cross-environment lists can repeat project ids; thread panels inherit their ref's environment. */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
      /** A clicked link waiting for the panel to show where it points; cleared once shown. */
      revealUrl?: string;
      detailTab?: PullRequestDetailTab;
    }
  | { id: "pull-requests"; kind: "pull-requests" }
  /**
   * An issue opened in the issues list's shared panel, or beside a thread. Like `pull-request`,
   * the reference lives in the id so several issues can stay open as peer tabs.
   */
  | {
      id: `issue:${string}`;
      kind: "issue";
      environmentId?: string;
      projectId: string;
      tracker: string;
      host?: string;
      scope: string;
      key: string;
      url?: string;
    }
  /**
   * A thread of the panel's environment shown beside it: a side chat or a subagent. Which one is
   * the thread's own lineage, so the surface only names it.
   */
  | ThreadSurface
  /** A linked environment's thread, read through `viaEnvironmentId`; it has no thread here. */
  | LinkedThreadSurface;

export type ThreadSurface = { id: `thread:${string}`; kind: "thread"; threadId: ThreadId };

const threadSurface = (threadId: ThreadId): ThreadSurface => ({
  id: `thread:${threadId}`,
  kind: "thread",
  threadId,
});

/**
 * A saved thread surface with its id rebuilt, or null when it names no thread. Builds before
 * subagents opened here saved it as `side-chat`.
 */
export function decodeThreadSurface(surface: object): ThreadSurface | null {
  const { kind, threadId } = surface as Record<string, unknown>;
  if ((kind !== "thread" && kind !== "side-chat") || typeof threadId !== "string") return null;
  return threadId === "" ? null : threadSurface(ThreadId.make(threadId));
}

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 17;
const LEGACY_TERMINAL_UI_STATE_STORAGE_KEY = "t3code:terminal-state:v1";

export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

/** The issues page's shared panel, with the same fixed sentinel ref as the pull-request list. */
export const ISSUES_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("issues-panel"),
  ThreadId.make("issues-panel"),
);

/**
 * The pull-request and issues lists' shared panels are session
 * state: reopening the app should show the list, not last session's tabs and detail fetches.
 */
const isPullRequestsPanelKey = (threadKey: string) =>
  threadKey.endsWith(":pull-requests-panel") || threadKey.endsWith(":issues-panel");

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
  maximized?: true;
  proactiveDiffTurnId?: RunId;
  /** The drawer's sub-tab: always a terminal surface of `surfaces`, never the active tool. */
  activeTerminalSurfaceId?: string;
  /** The latest turn the open panel accounted for, so the Changes dot compares against it. */
  changesSeenTurnCount?: number;
}

export type TerminalPanelSurface = Extract<RightPanelSurface, { kind: "terminal" }>;

export interface TerminalDrawerPreference {
  open: boolean;
  height: number;
}

interface TerminalServerObservation {
  ids: readonly string[];
  snapshotId: string | symbol | undefined;
}

export interface ThreadPanelVisibility {
  inlineOpen: boolean;
  popoverOpen: boolean;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /** Global, not per thread: the drawer stays where the user left it across threads. */
  terminalDrawer: TerminalDrawerPreference;
  terminalDrawerMaximized: boolean;
  unseenGroupsByThreadKey: Record<string, readonly RightPanelRailGroup[]>;
  terminalServerObservationByThreadKey: Record<string, TerminalServerObservation>;
  /** Session only: ids the user opened that the server has not listed yet. */
  claimedTerminalIdsByThreadKey: Record<string, readonly string[]>;
  pendingMaximizeThreadKey: string | null;
  requestMaximize: (ref: ScopedThreadRef) => void;
  consumeMaximizeRequest: (ref: ScopedThreadRef) => boolean;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
  userActionRevisionByThreadKey: Record<string, number>;
  closeRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  markUserAction: (ref: ScopedThreadRef) => number;
  /** Refused if the user chose a panel after expectedUserActionRevision was read. */
  openProactive: (
    ref: ScopedThreadRef,
    request:
      | Extract<RightPanelSurface, { kind: "pull-request" | "pull-requests" }>
      | { kind: "diff"; turnId: RunId },
    expectedUserActionRevision: number,
    activateExisting?: boolean,
  ) => boolean;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<
      RightPanelKind,
      "file" | "terminal" | "pull-request" | "issue" | "thread" | "linked-thread"
    >,
  ) => void;
  /** Opens a side chat or subagent of `ref`'s environment as a tab; `ref` itself has no tab. */
  openThread: (ref: ScopedThreadRef, threadId: ThreadId) => void;
  openLinkedThread: (ref: ScopedThreadRef, target: LinkedThreadTarget) => void;
  /** Records the title the linked environment gave, so the tab and a reopened one show it. */
  setLinkedThreadTitle: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openDevice: (ref: ScopedThreadRef, target: DeviceTabTarget, automatic?: boolean) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  /** Moves in place; "" opens the root explorer. folderTrail keeps the return path; keepSource opens beside the source. */
  navigateFolder: (
    ref: ScopedThreadRef,
    surfaceId: string,
    relativePath: string,
    folderTrail: string,
    keepSource?: boolean,
  ) => void;
  openAttachment: (ref: ScopedThreadRef, attachment: ChatFileAttachment) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: {
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
      /** A clicked link to reveal; reopening a surface passes only its `url`. */
      revealUrl?: string;
      detailTab?: PullRequestDetailTab;
    },
  ) => void;
  openIssue: (ref: ScopedThreadRef, target: IssueSurfaceTarget) => void;
  setPullRequestDetailTab: (
    ref: ScopedThreadRef,
    surfaceId: string,
    detailTab: PullRequestDetailTab,
  ) => void;
  /** Clears the surface's pending link only while it is still `revealUrl`. */
  settlePullRequestReveal: (ref: ScopedThreadRef, surfaceId: string, revealUrl: string) => void;
  /** Shows the drawer (and the panel); background terminals arrive through reconcile. */
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  activateTerminalSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  /** Opening also opens the thread's panel. */
  setTerminalDrawerOpen: (ref: ScopedThreadRef, open: boolean) => void;
  setTerminalDrawerHeight: (height: number) => void;
  setTerminalDrawerMaximized: (maximized: boolean) => void;
  reconcileTerminalSurfaces: (
    ref: ScopedThreadRef,
    serverIds: readonly string[],
    snapshotId: string | symbol | undefined,
    closingIds: readonly string[],
  ) => void;
  markChangesSeen: (ref: ScopedThreadRef, turnCount: number) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  /** Agent-driven activation. Not a user action, so it does not move keyboard focus. */
  revealSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  moveSurface: (ref: ScopedThreadRef, surfaceId: string, toIndex: number) => void;
  reconcileBrowserSurfaces: (
    ref: ScopedThreadRef,
    tabIds: readonly string[],
    hiddenTabIds?: ReadonlySet<string>,
  ) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  setMaximized: (ref: ScopedThreadRef, maximized: boolean) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<
      RightPanelKind,
      "file" | "terminal" | "pull-request" | "issue" | "thread" | "linked-thread"
    >,
  ) => void;
  setThreadPanelOpen: (
    ref: ScopedThreadRef,
    presentation: ThreadPanelPresentation,
    open: boolean,
  ) => void;
  toggleThreadPanel: (ref: ScopedThreadRef, presentation: ThreadPanelPresentation) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const DEFAULT_THREAD_PANEL_VISIBILITY: ThreadPanelVisibility = {
  inlineOpen: true,
  popoverOpen: false,
};

const singletonSurface = (
  kind: Exclude<
    RightPanelKind,
    "file" | "preview" | "terminal" | "pull-request" | "issue" | "thread" | "linked-thread"
  >,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "pull-requests":
      return { id: "pull-requests", kind };
    case "device":
      return { id: "device", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const attachmentSurface = (attachment: ChatFileAttachment): RightPanelSurface => ({
  id: `attachment:${attachment.id}`,
  kind: "file",
  relativePath: attachment.name,
  revealLine: null,
  revealRequestId: 0,
  attachment,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export type IssueSurface = Extract<RightPanelSurface, { kind: "issue" }>;

export interface IssueSurfaceTarget {
  environmentId?: string;
  projectId: string;
  tracker: string;
  host?: string;
  scope: string;
  key: string;
  url?: string;
}

function issueSurfaceId(target: Omit<IssueSurfaceTarget, "url">): IssueSurface["id"] {
  const environment =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `issue:${environment}${encodeURIComponent(target.projectId)}:${target.tracker}:${host}${encodeURIComponent(target.scope.toLowerCase())}:${encodeURIComponent(target.key)}`;
}

function issueSurface(target: IssueSurfaceTarget): IssueSurface {
  return {
    id: issueSurfaceId(target),
    kind: "issue",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    tracker: target.tracker,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    scope: target.scope,
    key: target.key,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
  };
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
  detailTab?: PullRequestDetailTab;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    ...(typeof target.host === "string" ? { host: target.host.toLowerCase() } : {}),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
    ...(target.detailTab === undefined ? {} : { detailTab: target.detailTab }),
  };
}

/** A pending link belongs to the click that made it, not to a reload or a reopen. */
const withoutReveal = (surface: RightPanelSurface): RightPanelSurface => {
  if (surface.kind !== "pull-request" || surface.revealUrl === undefined) return surface;
  const { revealUrl: _pending, ...rest } = surface;
  return rest;
};

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  ...current,
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const isTerminalSurface = (surface: RightPanelSurface): surface is TerminalPanelSurface =>
  surface.kind === "terminal";
const isToolSurface = (surface: RightPanelSurface) => surface.kind !== "terminal";

/**
 * The one place that keeps `activeSurfaceId` on a tool and `activeTerminalSurfaceId` on a
 * terminal, so no fallback, reconcile or saved state can show a terminal as the tool.
 */
function withValidActivePointers(
  previous: ThreadRightPanelState,
  next: ThreadRightPanelState,
): ThreadRightPanelState {
  let result = next;
  const activeId = next.activeSurfaceId;
  if (activeId !== null) {
    const index = next.surfaces.findIndex((surface) => surface.id === activeId);
    if (index < 0 || next.surfaces[index]!.kind === "terminal") {
      const split =
        index >= 0
          ? index
          : Math.max(
              0,
              previous.surfaces.findIndex((surface) => surface.id === activeId),
            );
      const right = next.surfaces.slice(index >= 0 ? index + 1 : split).find(isToolSurface);
      const left = next.surfaces.slice(0, split).findLast(isToolSurface);
      result = { ...result, activeSurfaceId: (right ?? left)?.id ?? null };
    }
  }
  const terminals = next.surfaces.filter(isTerminalSurface);
  const terminalId = next.activeTerminalSurfaceId;
  if (terminals.length === 0) {
    if (terminalId === undefined) return result;
    const { activeTerminalSurfaceId: _dropped, ...rest } = result;
    return rest;
  }
  if (terminalId !== undefined && terminals.some((surface) => surface.id === terminalId)) {
    return result;
  }
  const previousTerminals = previous.surfaces.filter(isTerminalSurface);
  const previousIndex = previousTerminals.findIndex((surface) => surface.id === terminalId);
  const present = (surface: TerminalPanelSurface) =>
    terminals.some((entry) => entry.id === surface.id);
  const neighbor =
    previousIndex < 0
      ? undefined
      : (previousTerminals.slice(previousIndex + 1).find(present) ??
        previousTerminals.slice(0, previousIndex).findLast(present));
  return { ...result, activeTerminalSurfaceId: (neighbor ?? terminals[0]!).id };
}

const updateThreadStateMap = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = withValidActivePointers(current, updater(current));
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length &&
    next.proactiveDiffTurnId === undefined &&
    next.activeTerminalSurfaceId === undefined &&
    next.changesSeenTurnCount === undefined
  ) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

const updateThreadPanelVisibilityMap = (
  byThreadKey: Record<string, ThreadPanelVisibility>,
  threadKey: string,
  updater: (current: ThreadPanelVisibility) => ThreadPanelVisibility,
): Record<string, ThreadPanelVisibility> => {
  const current = byThreadKey[threadKey] ?? DEFAULT_THREAD_PANEL_VISIBILITY;
  const next = updater(current);
  if (next.inlineOpen && !next.popoverOpen) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

type RightPanelStoreData = Pick<
  RightPanelStoreState,
  "byThreadKey" | "threadPanelVisibilityByThreadKey" | "unseenGroupsByThreadKey" | "terminalDrawer"
>;

const EMPTY_UNSEEN: readonly RightPanelRailGroup[] = [];
const EMPTY_IDS: readonly string[] = [];

const updateUnseenGroups = (
  unseenGroupsByThreadKey: Record<string, readonly RightPanelRailGroup[]>,
  threadKey: string,
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
  drawerOpen: boolean,
): Record<string, readonly RightPanelRailGroup[]> => {
  const unseen = unseenGroupsByThreadKey[threadKey] ?? EMPTY_UNSEEN;
  const next = nextUnseenRightPanelGroups({
    before: before.surfaces,
    after,
    drawerOpen,
    unseen,
  });
  if (next === unseen) return unseenGroupsByThreadKey;
  if (next.length === 0) {
    const { [threadKey]: _cleared, ...rest } = unseenGroupsByThreadKey;
    return rest;
  }
  return { ...unseenGroupsByThreadKey, [threadKey]: next };
};

const updateThread = (
  state: RightPanelStoreData,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Pick<
  RightPanelStoreData,
  "byThreadKey" | "threadPanelVisibilityByThreadKey" | "unseenGroupsByThreadKey"
> => {
  const current = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const byThreadKey = updateThreadStateMap(state.byThreadKey, threadKey, updater);
  const next = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const unseenGroupsByThreadKey = updateUnseenGroups(
    state.unseenGroupsByThreadKey,
    threadKey,
    current,
    next,
    state.terminalDrawer.open,
  );
  let threadPanelVisibilityByThreadKey = state.threadPanelVisibilityByThreadKey;

  if (!current.isOpen && next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) => (visibility.popoverOpen ? { ...visibility, popoverOpen: false } : visibility),
    );
  } else if (current.isOpen && !next.isOpen) {
    threadPanelVisibilityByThreadKey = updateThreadPanelVisibilityMap(
      threadPanelVisibilityByThreadKey,
      threadKey,
      (visibility) =>
        visibility.popoverOpen && !visibility.inlineOpen
          ? { ...visibility, inlineOpen: true }
          : visibility,
    );
  }

  return { byThreadKey, threadPanelVisibilityByThreadKey, unseenGroupsByThreadKey };
};

/** Runs `update` against the store as if the drawer were already open, and opens it. */
const withDrawerOpen = (
  state: RightPanelStoreState,
  update: (state: RightPanelStoreState) => Partial<RightPanelStoreState>,
): Partial<RightPanelStoreState> => {
  const terminalDrawer = state.terminalDrawer.open
    ? state.terminalDrawer
    : { ...state.terminalDrawer, open: true };
  return { ...update({ ...state, terminalDrawer }), terminalDrawer };
};

const withClaimedTerminal = (
  state: RightPanelStoreState,
  threadKey: string,
  terminalId: string,
): Partial<RightPanelStoreState> => {
  const claimed = state.claimedTerminalIdsByThreadKey[threadKey] ?? EMPTY_IDS;
  const listed = state.terminalServerObservationByThreadKey[threadKey]?.ids.includes(terminalId);
  return claimed.includes(terminalId) || listed
    ? {}
    : {
        claimedTerminalIdsByThreadKey: {
          ...state.claimedTerminalIdsByThreadKey,
          [threadKey]: [...claimed, terminalId],
        },
      };
};

const withTerminal = (
  current: ThreadRightPanelState,
  terminalId: string,
): ThreadRightPanelState => {
  const owner = current.surfaces.find(
    (surface): surface is TerminalPanelSurface =>
      surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (!owner) {
    const surface = terminalSurface(terminalId);
    return {
      ...current,
      surfaces: [...current.surfaces, surface],
      activeTerminalSurfaceId: surface.id,
    };
  }
  return {
    ...current,
    activeTerminalSurfaceId: owner.id,
    surfaces: current.surfaces.map((surface) =>
      surface === owner ? { ...owner, activeTerminalId: terminalId } : surface,
    ),
  };
};

const isTerminalSurfaceId = (surfaceId: string) => surfaceId.startsWith("terminal:");

const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, updater),
});

// A side chat pane has no panel of its own, so its panel actions open in its parent's panel.
const panelHosts = new Map<string, ScopedThreadRef>();

/** Routes `guest`'s panel actions to `host`'s panel until the returned cleanup runs. */
export function hostRightPanel(guest: ScopedThreadRef, host: ScopedThreadRef): () => void {
  const guestKey = scopedThreadKey(guest);
  panelHosts.set(guestKey, host);
  return () => {
    if (panelHosts.get(guestKey) === host) panelHosts.delete(guestKey);
  };
}

/** The thread whose panel shows `ref`'s panel actions, so it also owns their browser tabs. */
export function rightPanelHostRef(ref: ScopedThreadRef): ScopedThreadRef {
  return panelHosts.get(scopedThreadKey(ref)) ?? ref;
}

const userAction = (
  state: RightPanelStoreState,
  guestKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView = false,
): Partial<RightPanelStoreState> => {
  const host = panelHosts.get(guestKey);
  const threadKey = host === undefined ? guestKey : scopedThreadKey(host);
  return userActionOnThread(state, threadKey, updater, closesView);
};

const userActionOnThread = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
  closesView: boolean,
): Partial<RightPanelStoreState> => ({
  ...updateThread(state, threadKey, (current) => {
    const next = updater(current);
    if (next === current) return current;
    const removedDevices = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" && !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removedDevices.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removedDevices.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
  ...(closesView
    ? {
        closeRevisionByThreadKey: {
          ...state.closeRevisionByThreadKey,
          [threadKey]: (state.closeRevisionByThreadKey[threadKey] ?? 0) + 1,
        },
      }
    : {}),
});

const activated = (current: ThreadRightPanelState, surfaceId: string): ThreadRightPanelState =>
  current.surfaces.some((surface) => surface.id === surfaceId)
    ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
    : current;

const activatedTerminal = (
  current: ThreadRightPanelState,
  surfaceId: string,
): ThreadRightPanelState =>
  current.surfaces.some((surface) => surface.id === surfaceId && surface.kind === "terminal")
    ? { ...current, isOpen: true, activeTerminalSurfaceId: surfaceId }
    : current;

const closeAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => userAction(state, threadKey, updater, true);

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

const DEFAULT_TERMINAL_DRAWER: TerminalDrawerPreference = {
  open: false,
  height: DEFAULT_THREAD_TERMINAL_HEIGHT,
};

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
  threadPanelVisibilityByThreadKey: Record<string, ThreadPanelVisibility>;
  terminalDrawer: TerminalDrawerPreference;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return {
      byThreadKey: {},
      threadPanelVisibilityByThreadKey: {},
      terminalDrawer: DEFAULT_TERMINAL_DRAWER,
    };
  }
  let openThreadHadActiveTerminal = false;
  const byThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(persistedState.byThreadKey as Record<string, ThreadRightPanelState>)
            .filter(([threadKey]) => !isPullRequestsPanelKey(threadKey))
            .map(([threadKey, threadState]) => {
              const validThreadState =
                threadState && typeof threadState === "object" ? threadState : null;
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) => {
                    if (!surface || typeof surface !== "object") return [];
                    const kind = (surface as { kind?: string }).kind;
                    if (kind === "thread" || kind === "side-chat") {
                      const decoded = decodeThreadSurface(surface);
                      return decoded === null ? [] : [decoded];
                    }
                    // Also drops kinds this build does not know, such as one a newer build saved.
                    if (!(RIGHT_PANEL_KINDS as ReadonlyArray<unknown>).includes(kind)) return [];
                    if (surface.kind === "linked-thread") {
                      const decoded = decodeLinkedThreadSurface(surface);
                      return decoded === null ? [] : [decoded];
                    }
                    if (
                      (surface.kind === "file" || surface.kind === "files") &&
                      "folderTrail" in surface &&
                      typeof surface.folderTrail !== "string"
                    ) {
                      const { folderTrail: _invalid, ...rest } = surface;
                      surface = rest;
                    }
                    if (surface.kind === "file") {
                      const revealLine =
                        typeof surface.revealLine === "number" &&
                        Number.isFinite(surface.revealLine)
                          ? Math.max(1, Math.trunc(surface.revealLine))
                          : null;
                      const revealRequestId =
                        typeof surface.revealRequestId === "number" &&
                        Number.isSafeInteger(surface.revealRequestId) &&
                        surface.revealRequestId >= 0
                          ? surface.revealRequestId
                          : 0;
                      return [{ ...surface, revealLine, revealRequestId }];
                    }
                    if (surface.kind === "pull-request") {
                      if (
                        typeof surface.projectId !== "string" ||
                        typeof surface.repository !== "string" ||
                        typeof surface.number !== "number" ||
                        !Number.isSafeInteger(surface.number) ||
                        surface.number < 1
                      ) {
                        return [];
                      }
                      const { environmentId, ...rest } = surface;
                      return [
                        pullRequestSurface({
                          ...rest,
                          ...(typeof environmentId === "string" ? { environmentId } : {}),
                        }),
                      ];
                    }
                    if (surface.kind === "issue") {
                      if (
                        typeof surface.projectId !== "string" ||
                        typeof surface.tracker !== "string" ||
                        typeof surface.scope !== "string" ||
                        typeof surface.key !== "string"
                      ) {
                        return [];
                      }
                      const { environmentId, ...rest } = surface;
                      return [
                        issueSurface({
                          ...rest,
                          ...(typeof environmentId === "string" ? { environmentId } : {}),
                        }),
                      ];
                    }
                    if (surface.kind !== "terminal") return [surface];
                    if (
                      !("resourceId" in surface) ||
                      typeof surface.resourceId !== "string" ||
                      surface.id !== `terminal:${surface.resourceId}`
                    ) {
                      return [];
                    }
                    const terminalIds =
                      "terminalIds" in surface && Array.isArray(surface.terminalIds)
                        ? [
                            ...new Set(
                              surface.terminalIds.filter(
                                (terminalId): terminalId is string =>
                                  typeof terminalId === "string",
                              ),
                            ),
                          ]
                        : [surface.resourceId];
                    const activeTerminalId =
                      "activeTerminalId" in surface &&
                      typeof surface.activeTerminalId === "string" &&
                      terminalIds.includes(surface.activeTerminalId)
                        ? surface.activeTerminalId
                        : (terminalIds[0] ?? surface.resourceId);
                    return [
                      {
                        ...surface,
                        terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                        activeTerminalId,
                      },
                    ];
                  })
                : [];
              const savedActiveSurfaceId = validThreadState?.activeSurfaceId;
              const rawActiveSurfaceId =
                typeof savedActiveSurfaceId === "string" &&
                savedActiveSurfaceId.startsWith("side-chat:")
                  ? `thread:${savedActiveSurfaceId.slice("side-chat:".length)}`
                  : savedActiveSurfaceId;
              const persistedActiveSurfaceId = surfaces.some(
                (surface) => surface.id === rawActiveSurfaceId,
              )
                ? (rawActiveSurfaceId ?? null)
                : rawActiveSurfaceId === "pull-request"
                  ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
                  : null;
              const isOpen =
                surfaces.length > 0 &&
                (typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : persistedActiveSurfaceId !== null);
              let activeSurfaceId =
                persistedActiveSurfaceId ??
                (isOpen || rawActiveSurfaceId === "agents" ? (surfaces[0]?.id ?? null) : null);
              const savedTerminalSurfaceId = validThreadState?.activeTerminalSurfaceId;
              let activeTerminalSurfaceId =
                typeof savedTerminalSurfaceId === "string" ? savedTerminalSurfaceId : undefined;
              // Builds before the drawer showed terminals as the tool; the tool falls back to
              // Changes and the drawer opens on that terminal.
              if (
                persistedActiveSurfaceId !== null &&
                isTerminalSurfaceId(persistedActiveSurfaceId)
              ) {
                activeTerminalSurfaceId = persistedActiveSurfaceId;
                activeSurfaceId = "diff";
                if (!surfaces.some((surface) => surface.id === "diff")) {
                  surfaces.push(singletonSurface("diff"));
                }
                if (isOpen) openThreadHadActiveTerminal = true;
              }
              const changesSeenTurnCount = validThreadState?.changesSeenTurnCount;
              return [
                threadKey,
                withValidActivePointers(EMPTY_THREAD_STATE, {
                  isOpen,
                  surfaces,
                  activeSurfaceId,
                  ...(activeTerminalSurfaceId === undefined ? {} : { activeTerminalSurfaceId }),
                  ...(typeof changesSeenTurnCount === "number" &&
                  Number.isSafeInteger(changesSeenTurnCount)
                    ? { changesSeenTurnCount }
                    : {}),
                  ...(typeof validThreadState?.proactiveDiffTurnId === "string"
                    ? { proactiveDiffTurnId: RunId.make(validThreadState.proactiveDiffTurnId) }
                    : {}),
                  ...(Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
                    ? {
                        dismissedDeviceSurfaceIds:
                          validThreadState.dismissedDeviceSurfaceIds.filter(
                            (id): id is string => typeof id === "string",
                          ),
                      }
                    : {}),
                  ...(validThreadState?.maximized === true ? { maximized: true as const } : {}),
                }),
              ];
            }),
        )
      : {};
  const threadPanelVisibilityByThreadKey =
    "threadPanelVisibilityByThreadKey" in persistedState &&
    persistedState.threadPanelVisibilityByThreadKey &&
    typeof persistedState.threadPanelVisibilityByThreadKey === "object"
      ? Object.fromEntries(
          Object.entries(
            persistedState.threadPanelVisibilityByThreadKey as Record<string, unknown>,
          ).flatMap(([threadKey, value]) => {
            if (!value || typeof value !== "object" || !("inlineOpen" in value)) return [];
            return value.inlineOpen === false
              ? [[threadKey, { inlineOpen: false, popoverOpen: false }]]
              : [];
          }),
        )
      : {};
  const savedDrawer =
    "terminalDrawer" in persistedState &&
    persistedState.terminalDrawer &&
    typeof persistedState.terminalDrawer === "object"
      ? (persistedState.terminalDrawer as Partial<Record<keyof TerminalDrawerPreference, unknown>>)
      : null;
  const terminalDrawer: TerminalDrawerPreference = {
    open:
      typeof savedDrawer?.open === "boolean"
        ? savedDrawer.open || openThreadHadActiveTerminal
        : openThreadHadActiveTerminal,
    height:
      typeof savedDrawer?.height === "number" && Number.isFinite(savedDrawer.height)
        ? savedDrawer.height
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
  };
  return { byThreadKey, threadPanelVisibilityByThreadKey, terminalDrawer };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      terminalDrawer: DEFAULT_TERMINAL_DRAWER,
      terminalDrawerMaximized: false,
      unseenGroupsByThreadKey: {},
      terminalServerObservationByThreadKey: {},
      claimedTerminalIdsByThreadKey: {},
      pendingMaximizeThreadKey: null,
      requestMaximize: (ref) => set({ pendingMaximizeThreadKey: scopedThreadKey(ref) }),
      consumeMaximizeRequest: (ref) => {
        if (get().pendingMaximizeThreadKey !== scopedThreadKey(ref)) return false;
        set({ pendingMaximizeThreadKey: null });
        return true;
      },
      threadPanelVisibilityByThreadKey: {},
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
      getUserActionRevision: (ref) =>
        get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
      markUserAction: (ref) => {
        const revision = get().getUserActionRevision(ref) + 1;
        set((state) => ({
          userActionRevisionByThreadKey: {
            ...state.userActionRevisionByThreadKey,
            [scopedThreadKey(ref)]: revision,
          },
        }));
        return revision;
      },
      openProactive: (ref, request, expectedUserActionRevision, activateExisting = false) => {
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (request.kind === "diff") {
            const current = selectThreadRightPanelState(state.byThreadKey, ref);
            if (current.proactiveDiffTurnId === request.turnId) return state;
            const activePanel = selectActiveRightPanel(state.byThreadKey, ref);
            const pullRequestActive =
              activePanel === "pull-request" || activePanel === "pull-requests";
            opened =
              (state.userActionRevisionByThreadKey[threadKey] ?? 0) ===
                expectedUserActionRevision &&
              activePanel !== "diff" &&
              !pullRequestActive;
            // Record the offer even when refused, so a revisit does not retry this turn.
            return automaticUpdate(state, threadKey, (thread) => ({
              ...(opened ? upsertSurface(thread, singletonSurface("diff")) : thread),
              proactiveDiffTurnId: request.turnId,
            }));
          }
          if (
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          ) {
            // The user chose something else since; the PR waits behind the reviews icon.
            return automaticUpdate(state, threadKey, (current) =>
              current.surfaces.some((entry) => entry.id === request.id)
                ? current
                : { ...current, surfaces: [...current.surfaces, request] },
            );
          }
          // Keep an existing PR tab where the user left it when revisiting a thread.
          if (
            !activateExisting &&
            selectThreadRightPanelState(state.byThreadKey, ref).surfaces.some(
              (entry) => entry.id === request.id,
            )
          ) {
            return state;
          }
          opened = true;
          return automaticUpdate(state, threadKey, (current) => upsertSurface(current, request));
        });
        return opened;
      },
      open: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      openDevice: (ref, target, automatic = false) =>
        set((state) =>
          (automatic ? automaticUpdate : userAction)(state, scopedThreadKey(ref), (current) => {
            const id =
              `device:${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}` as const;
            if (automatic && current.dismissedDeviceSurfaceIds?.includes(id)) return current;
            const surface: RightPanelSurface = { id, kind: "device", target };
            const existing = current.surfaces.find((entry) => entry.id === id);
            const surfaces = existing
              ? current.surfaces.filter((entry) => entry.id !== "device")
              : current.surfaces.map((entry) => (entry.id === "device" ? surface : entry));
            return upsertSurface(
              {
                ...current,
                surfaces,
                dismissedDeviceSurfaceIds: (current.dismissedDeviceSurfaceIds ?? []).filter(
                  (entry) => entry !== id,
                ),
              },
              existing ?? surface,
            );
          }),
        ),
      openThread: (ref, threadId) =>
        set((state) =>
          rightPanelHostRef(ref).threadId === threadId
            ? state
            : userAction(state, scopedThreadKey(ref), (current) =>
                upsertSurface(current, threadSurface(threadId)),
              ),
        ),
      openLinkedThread: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = linkedThreadSurface(target);
            const next = upsertSurface(current, surface);
            return {
              ...next,
              // A later click may know the title or label an earlier one did not.
              surfaces: next.surfaces.map((entry) =>
                entry.id === surface.id && entry.kind === "linked-thread"
                  ? { ...surface, title: surface.title ?? entry.title }
                  : entry,
              ),
            };
          }),
        ),
      setLinkedThreadTitle: (ref, surfaceId, title) =>
        set((state) => {
          const threadKey = scopedThreadKey(rightPanelHostRef(ref));
          const existing = state.byThreadKey[threadKey]?.surfaces.find(
            (surface) => surface.id === surfaceId,
          );
          if (existing?.kind !== "linked-thread" || existing.title === title) return state;
          return automaticUpdate(state, threadKey, (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "linked-thread"
                ? { ...surface, title }
                : surface,
            ),
          }));
        }),
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? {
                    ...surface,
                    title:
                      title.trim() ||
                      surface.target?.name ||
                      m(msg("Device", { $context: "a simulator or emulator" })),
                  }
                : surface,
            ),
          })),
        ),
      openBrowser: (ref, tabId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        ),
      openPullRequest: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = pullRequestSurface(target);
            const next = upsertSurface(current, surface);
            const { url, revealUrl } = target;
            if (!url && !revealUrl) return next;
            return {
              ...next,
              surfaces: next.surfaces.map((entry) => {
                if (entry.id !== surface.id || entry.kind !== "pull-request") return entry;
                // A later link replaces one not yet shown.
                const { revealUrl: _previous, ...rest } = entry;
                return { ...rest, ...surface, ...(revealUrl ? { revealUrl } : {}) };
              }),
            };
          }),
        ),
      openIssue: (ref, target) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = issueSurface(target);
            const next = upsertSurface(current, surface);
            return target.url
              ? {
                  ...next,
                  surfaces: next.surfaces.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  ),
                }
              : next;
          }),
        ),
      setPullRequestDetailTab: (ref, surfaceId, detailTab) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const existing = state.byThreadKey[threadKey]?.surfaces.find(
            (surface) => surface.id === surfaceId,
          );
          if (existing?.kind !== "pull-request" || (existing.detailTab ?? "summary") === detailTab)
            return state;
          return automaticUpdate(state, threadKey, (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "pull-request"
                ? { ...surface, detailTab }
                : surface,
            ),
          }));
        }),
      settlePullRequestReveal: (ref, surfaceId, revealUrl) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const existing = state.byThreadKey[threadKey]?.surfaces.find(
            (surface) => surface.id === surfaceId,
          );
          if (existing?.kind !== "pull-request" || existing.revealUrl !== revealUrl) return state;
          return automaticUpdate(state, threadKey, (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId ? withoutReveal(surface) : surface,
            ),
          }));
        }),
      openFile: (ref, requestedPath, line) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            if (requestedPath === ".") {
              return upsertSurface(current, singletonSurface("files"));
            }
            // Workspace entry paths use '/', including on Windows.
            const relativePath = /^[A-Za-z]:\/+$/.test(requestedPath)
              ? requestedPath
              : requestedPath.replace(/\/+$/, "") || requestedPath;
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            const surfaceId = `file:${relativePath}` as const;
            const existing = withoutStandaloneExplorer.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? withoutStandaloneExplorer.map((entry) =>
                    entry.id === surface.id ? surface : entry,
                  )
                : [...withoutStandaloneExplorer, surface],
            };
          }),
        ),
      navigateFolder: (ref, surfaceId, relativePath, folderTrail, keepSource = false) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const trail = folderTrail === relativePath ? {} : { folderTrail };
            const target: RightPanelSurface =
              relativePath === ""
                ? { ...singletonSurface("files"), ...trail }
                : { ...fileSurface(relativePath, null, 1), ...trail };
            const source = current.surfaces[index]!;
            const existing = current.surfaces.some(
              (surface, i) => i !== index && surface.id === target.id,
            );
            const surfaces = current.surfaces.flatMap((surface, i) => {
              if (i === index) {
                const kept = keepSource ? [source] : [];
                return existing ? kept : [...kept, target];
              }
              return !existing && target.kind === "file" && surface.kind === "files"
                ? []
                : [surface];
            });
            return { ...current, isOpen: true, activeSurfaceId: target.id, surfaces };
          }),
        ),
      openAttachment: (ref, attachment) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const withoutStandaloneExplorer = current.surfaces.filter(
              (surface) => surface.kind !== "files",
            );
            return upsertSurface(
              { ...current, surfaces: withoutStandaloneExplorer },
              attachmentSurface(attachment),
            );
          }),
        ),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          ...withDrawerOpen(state, (opened) =>
            userAction(opened, scopedThreadKey(ref), (current) => ({
              ...withTerminal(current, terminalId),
              isOpen: true,
            })),
          ),
          ...withClaimedTerminal(state, scopedThreadKey(ref), terminalId),
        })),
      activateTerminalSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            activatedTerminal(current, surfaceId),
          ),
        ),
      setTerminalDrawerOpen: (ref, open) =>
        set((state) => {
          if (!open) {
            return state.terminalDrawer.open
              ? {
                  terminalDrawer: { ...state.terminalDrawer, open: false },
                  terminalDrawerMaximized: false,
                }
              : state;
          }
          return withDrawerOpen(state, (opened) =>
            userAction(opened, scopedThreadKey(ref), (current) =>
              current.isOpen ? current : { ...current, isOpen: true },
            ),
          );
        }),
      setTerminalDrawerHeight: (height) =>
        set((state) =>
          !Number.isFinite(height) || state.terminalDrawer.height === height
            ? state
            : { terminalDrawer: { ...state.terminalDrawer, height } },
        ),
      setTerminalDrawerMaximized: (maximized) =>
        set((state) =>
          state.terminalDrawerMaximized === maximized
            ? state
            : { terminalDrawerMaximized: maximized },
        ),
      reconcileTerminalSurfaces: (ref, serverIds, snapshotId, closingIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const current = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
          const ownedIds = new Set(
            current.surfaces.flatMap((surface) =>
              surface.kind === "terminal" ? surface.terminalIds : [],
            ),
          );
          const previous = state.terminalServerObservationByThreadKey[threadKey];
          const { adopt, drop } = reconcileTerminalSurfaceIds({
            ownedIds,
            serverIds,
            previous,
            snapshotId,
            closingIds,
          });
          const ids = [...serverIds].toSorted();
          const observationUnchanged =
            previous !== undefined &&
            previous.snapshotId === snapshotId &&
            previous.ids.length === ids.length &&
            previous.ids.every((id, index) => id === ids[index]);
          const observation = observationUnchanged
            ? {}
            : {
                terminalServerObservationByThreadKey: {
                  ...state.terminalServerObservationByThreadKey,
                  [threadKey]: { ids, snapshotId },
                },
              };
          // A restarted server never saw a pending claim; a listed one no longer needs it.
          const claimed = state.claimedTerminalIdsByThreadKey[threadKey] ?? EMPTY_IDS;
          const restarted = previous !== undefined && previous.snapshotId !== snapshotId;
          const stillClaimed = restarted
            ? EMPTY_IDS
            : claimed.filter((id) => !serverIds.includes(id));
          let claims: Partial<RightPanelStoreState> = {};
          if (stillClaimed.length !== claimed.length) {
            const { [threadKey]: _claimed, ...claimedTerminalIdsByThreadKey } =
              state.claimedTerminalIdsByThreadKey;
            claims = {
              claimedTerminalIdsByThreadKey:
                stillClaimed.length === 0
                  ? claimedTerminalIdsByThreadKey
                  : { ...claimedTerminalIdsByThreadKey, [threadKey]: stillClaimed },
            };
          }
          if (adopt.length === 0 && drop.length === 0) {
            return observationUnchanged && stillClaimed.length === claimed.length
              ? state
              : { ...observation, ...claims };
          }
          const dropped = new Set(drop);
          return {
            ...claims,
            ...automaticUpdate(state, threadKey, (thread) => {
              const surfaces = thread.surfaces.flatMap<RightPanelSurface>((surface) => {
                if (surface.kind !== "terminal") return [surface];
                const terminalIds = surface.terminalIds.filter((id) => !dropped.has(id));
                if (terminalIds.length === surface.terminalIds.length) return [surface];
                if (terminalIds.length === 0) return [];
                return [
                  {
                    ...surface,
                    terminalIds,
                    activeTerminalId: terminalIds.includes(surface.activeTerminalId)
                      ? surface.activeTerminalId
                      : terminalIds[0]!,
                  },
                ];
              });
              const adopted = [...surfaces, ...adopt.map(terminalSurface)];
              return {
                ...thread,
                isOpen: adopted.length > 0 && thread.isOpen,
                surfaces: adopted,
              };
            }),
            ...observation,
          };
        }),
      markChangesSeen: (ref, turnCount) =>
        set((state) =>
          selectThreadRightPanelState(state.byThreadKey, ref).changesSeenTurnCount === turnCount
            ? state
            : automaticUpdate(state, scopedThreadKey(ref), (current) => ({
                ...current,
                changesSeenTurnCount: turnCount,
              })),
        ),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          ...withClaimedTerminal(state, scopedThreadKey(ref), terminalId),
          ...withDrawerOpen(state, (opened) =>
            userAction(opened, scopedThreadKey(ref), (current) => ({
              ...current,
              isOpen: true,
              activeTerminalSurfaceId: surfaceId,
              surfaces: current.surfaces.map((surface) => {
                if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
                const { splitDirection: _splitDirection, ...baseSurface } = surface;
                return {
                  ...baseSurface,
                  terminalIds: surface.terminalIds.includes(terminalId)
                    ? surface.terminalIds
                    : [...surface.terminalIds, terminalId],
                  activeTerminalId: terminalId,
                  ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
                };
              }),
            })),
          ),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            activeTerminalSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        ),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          isTerminalSurfaceId(surfaceId)
            ? withDrawerOpen(state, (opened) =>
                userAction(opened, scopedThreadKey(ref), (current) =>
                  activatedTerminal(current, surfaceId),
                ),
              )
            : userAction(state, scopedThreadKey(ref), (current) => activated(current, surfaceId)),
        ),
      revealSurface: (ref, surfaceId) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) =>
            isTerminalSurfaceId(surfaceId)
              ? activatedTerminal(current, surfaceId)
              : activated(current, surfaceId),
          ),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (surfaces.length === current.surfaces.length) return current;
            return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
          }),
        ),
      // Bulk closes stay inside the clicked surface's group, and never take a terminal along.
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface) return current;
            const group = rightPanelGroupOf(surface);
            const surfaces = current.surfaces.filter(
              (entry) => entry === surface || rightPanelGroupOf(entry) !== group,
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (entry) => entry.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: true,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const group = rightPanelGroupOf(current.surfaces[index]!);
            const surfaces = current.surfaces.filter(
              (surface, i) => i <= index || rightPanelGroupOf(surface) !== group,
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          closeAction(state, scopedThreadKey(ref), (current) => {
            const surfaces = current.surfaces.filter(isTerminalSurface);
            return surfaces.length === current.surfaces.length
              ? current
              : { ...current, isOpen: false, surfaces, activeSurfaceId: null };
          }),
        ),
      moveSurface: (ref, surfaceId, toIndex) =>
        set((state) =>
          updateThread(state, scopedThreadKey(ref), (current) => {
            const fromIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (fromIndex < 0 || fromIndex === toIndex) return current;
            const surfaces = [...current.surfaces];
            surfaces.splice(toIndex, 0, ...surfaces.splice(fromIndex, 1));
            return { ...current, surfaces };
          }),
        ),
      reconcileBrowserSurfaces: (ref, tabIds, hiddenTabIds) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const kept = current.surfaces.filter(
              (surface) =>
                surface.kind !== "preview" ||
                (surface.id !== "browser:new" && validIds.has(surface.id)),
            );
            const knownIds = new Set(kept.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`) && !hiddenTabIds?.has(tabId))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...kept, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            // A closed session tab was the last surface: hide the panel rather than leave it on
            // the empty picker, as a user close would. A dropped `browser:new` placeholder does not count.
            const closedLastSessionTab =
              surfaces.length === 0 &&
              current.surfaces.some((surface) => surface.kind === "preview" && surface.resourceId);
            return {
              ...current,
              isOpen: closedLastSessionTab ? false : current.isOpen,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        ),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) =>
                surface.kind !== "files" &&
                (surface.kind !== "file" || surface.attachment !== undefined),
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (surfaces.at(-1)?.id ?? null),
            };
          }),
        ),
      show: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      setMaximized: (ref, maximized) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            if ((current.maximized ?? false) === maximized) return current;
            const { maximized: _maximized, ...rest } = current;
            return maximized ? { ...rest, maximized: true } : rest;
          }),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        ),
      setThreadPanelOpen: (ref, presentation, open) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) => {
              const key = presentation === "inline" ? "inlineOpen" : "popoverOpen";
              return visibility[key] === open ? visibility : { ...visibility, [key]: open };
            },
          ),
        })),
      toggleThreadPanel: (ref, presentation) =>
        set((state) => ({
          threadPanelVisibilityByThreadKey: updateThreadPanelVisibilityMap(
            state.threadPanelVisibilityByThreadKey,
            scopedThreadKey(ref),
            (visibility) =>
              presentation === "inline"
                ? { ...visibility, inlineOpen: !visibility.inlineOpen }
                : { ...visibility, popoverOpen: !visibility.popoverOpen },
          ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.threadPanelVisibilityByThreadKey) &&
            !(threadKey in state.userActionRevisionByThreadKey) &&
            !(threadKey in state.closeRevisionByThreadKey) &&
            !(threadKey in state.unseenGroupsByThreadKey) &&
            !(threadKey in state.terminalServerObservationByThreadKey) &&
            !(threadKey in state.claimedTerminalIdsByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _claimed, ...claimedTerminalIdsByThreadKey } =
            state.claimedTerminalIdsByThreadKey;
          const { [threadKey]: _unseen, ...unseenGroupsByThreadKey } =
            state.unseenGroupsByThreadKey;
          const { [threadKey]: _observation, ...terminalServerObservationByThreadKey } =
            state.terminalServerObservationByThreadKey;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _visibility, ...threadPanelVisibilityByThreadKey } =
            state.threadPanelVisibilityByThreadKey;
          const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
            state.userActionRevisionByThreadKey;
          const { [threadKey]: _closeRevision, ...closeRevisionByThreadKey } =
            state.closeRevisionByThreadKey;
          return {
            byThreadKey,
            threadPanelVisibilityByThreadKey,
            userActionRevisionByThreadKey,
            closeRevisionByThreadKey,
            unseenGroupsByThreadKey,
            terminalServerObservationByThreadKey,
            claimedTerminalIdsByThreadKey,
          };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        terminalDrawer: state.terminalDrawer,
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).flatMap(([threadKey, threadState]) =>
            isPullRequestsPanelKey(threadKey)
              ? []
              : [
                  [
                    threadKey,
                    { ...threadState, surfaces: threadState.surfaces.map(withoutReveal) },
                  ],
                ],
          ),
        ),
        threadPanelVisibilityByThreadKey: Object.fromEntries(
          Object.entries(state.threadPanelVisibilityByThreadKey).flatMap(
            ([threadKey, visibility]) =>
              visibility.inlineOpen ? [] : [[threadKey, { inlineOpen: false, popoverOpen: false }]],
          ),
        ),
      }),
      migrate: (persistedState) => {
        // The chat drawer's own store is gone; its terminals are adopted from the server list.
        if (typeof window !== "undefined") {
          resolveStorage(window.localStorage).removeItem(LEGACY_TERMINAL_UI_STATE_STORAGE_KEY);
        }
        return migratePersistedRightPanelState(persistedState);
      },
    },
  ),
);

useRightPanelStore.subscribe((next, previous) => {
  if (next.closeRevisionByThreadKey === previous.closeRevisionByThreadKey) return;
  for (const [threadKey, revision] of Object.entries(next.closeRevisionByThreadKey)) {
    if (revision === previous.closeRevisionByThreadKey[threadKey]) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    const before = previous.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const after = next.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
    const removed = before.surfaces.filter(
      (surface) => !after.surfaces.some((entry) => entry.id === surface.id),
    );
    const closedInOrder = [
      ...removed.filter((surface) => surface.id !== before.activeSurfaceId),
      ...removed.filter((surface) => surface.id === before.activeSurfaceId),
    ];
    for (const surface of closedInOrder.map(withoutReveal)) {
      if (
        surface.kind === "terminal" ||
        (surface.kind === "preview" && surface.resourceId !== null)
      )
        continue;
      useClosedViewStore.getState().remember({ kind: "panel-tab", threadRef, surface });
    }
  }
});

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectThreadPanelVisibility(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
): ThreadPanelVisibility {
  if (!ref) return DEFAULT_THREAD_PANEL_VISIBILITY;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_THREAD_PANEL_VISIBILITY;
}

export function selectThreadPanelOpen(
  byThreadKey: Record<string, ThreadPanelVisibility>,
  ref: ScopedThreadRef | null | undefined,
  presentation: ThreadPanelPresentation,
): boolean {
  const visibility = selectThreadPanelVisibility(byThreadKey, ref);
  return presentation === "inline" ? visibility.inlineOpen : visibility.popoverOpen;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectActiveTerminalSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): TerminalPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return (
    state.surfaces.find(
      (surface): surface is TerminalPanelSurface =>
        surface.kind === "terminal" && surface.id === state.activeTerminalSurfaceId,
    ) ?? null
  );
}

export function selectClaimedTerminalIds(
  state: Pick<RightPanelStoreState, "claimedTerminalIdsByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): readonly string[] {
  return (ref && state.claimedTerminalIdsByThreadKey[scopedThreadKey(ref)]) || EMPTY_IDS;
}

/** What `terminalOpen` means: the drawer is open in an open panel, even with no terminal. */
export function selectTerminalDrawerVisible(
  state: Pick<RightPanelStoreState, "byThreadKey" | "terminalDrawer">,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return state.terminalDrawer.open && selectThreadRightPanelState(state.byThreadKey, ref).isOpen;
}

/** The drawer flag is global, so a group another thread already shows is filtered here. */
export function selectRightPanelUnseenGroups(
  state: Pick<RightPanelStoreState, "byThreadKey" | "terminalDrawer" | "unseenGroupsByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): readonly RightPanelRailGroup[] {
  if (!ref) return EMPTY_UNSEEN;
  const unseen = state.unseenGroupsByThreadKey[scopedThreadKey(ref)] ?? EMPTY_UNSEEN;
  if (unseen.length === 0) return unseen;
  const visible = visibleRightPanelGroups(
    selectThreadRightPanelState(state.byThreadKey, ref),
    state.terminalDrawer.open,
  );
  return unseen.some((group) => visible.has(group))
    ? unseen.filter((group) => !visible.has(group))
    : unseen;
}
