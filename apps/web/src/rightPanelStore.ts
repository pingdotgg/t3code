/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, file surfaces point at
 * workspace paths, and diff/files remain singleton surfaces.
 */
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ChatFileAttachment,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  assertId,
  copyJson,
  resourceKey,
  validateContext,
  type ViewRecord,
} from "@t3tools/extension-sdk/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "preview",
  "device",
  "terminal",
  "pull-request",
  "pull-requests",
  "agents",
  "extension",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

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
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}` | `attachment:${string}`;
      kind: "file";
      /** Workspace-relative, or absolute for a host file outside the workspace. */
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
      /** Durable explicit-open identity; a reload preserves it, a new open replaces it. */
      presentationRequestId?: string;
      /** Present when the file lives in the thread's attachment store rather
          than at a workspace or host path. */
      attachment?: ChatFileAttachment;
    }
  | {
      /**
       * A change request opened beside a thread or in the pull-request list's shared panel.
       * The reference lives in the id so several pull requests can remain open as peer tabs.
       */
      id: `pull-request:${string}`;
      kind: "pull-request";
      /**
       * Which server the change request was read from. The list spans every connected one, so
       * two of them can hold the same project id; a panel beside a thread leaves this out and
       * takes the environment from its own ref.
       */
      environmentId?: string;
      projectId: string;
      host?: string;
      repository: string;
      number: number;
      url?: string;
    }
  | { id: "pull-requests"; kind: "pull-requests" }
  | { id: "agents"; kind: "agents" }
  | ExtensionPanelSurface;

export interface ExtensionPanelSurface {
  viewerGeneration?: string;
  id: `extension:${string}`;
  kind: "extension";
  record: ViewRecord;
}

const MAX_EXTENSION_SURFACES = 64;

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
// v9 removed the "plan" surface kind (plans render inline in the transcript).
// v10 keys pull-request surfaces by reference instead of a singleton tab.
// v11 stops persisting the pull-request list's shared panel, so a restart opens the page fresh.
// v12 adds the device surface (main) and bounded SDK records (extensions), and v13 scopes
// devices to their hosts (main) and routes contributed bottom-dock records to their own
// thread layout (extensions). v14 reconciles the two v12/v13 lines; normalization also runs
// for current-version hydration, so either shape restores.
const RIGHT_PANEL_STORAGE_VERSION = 14;

/** A fixed workspace-level ref: each PR surface carries its own real environment. */
export const PULL_REQUESTS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("pull-requests-panel"),
  ThreadId.make("pull-requests-panel"),
);

/**
 * The pull-request list's shared panel is session
 * state: reopening the app should show the list, not last session's tabs and detail fetches.
 */
const isPullRequestsPanelKey = (threadKey: string) => threadKey.endsWith(":pull-requests-panel");

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
  dismissedDeviceSurfaceIds?: string[];
}

export interface ExtensionDockState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: ExtensionPanelSurface[];
  /** User-dragged frame height in CSS pixels; absent means the dock default. */
  height?: number;
}

interface RightPanelStoreState {
  extensionDockByThreadKey: Record<string, ExtensionDockState>;
  byThreadKey: Record<string, ThreadRightPanelState>;
  /** Session-only count of user panel choices per thread. Automatic updates do not advance it. */
  userActionRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (ref: ScopedThreadRef) => number;
  /**
   * Open a surface on behalf of the app, not the user. Refused when the user
   * made a panel choice after `expectedUserActionRevision` was read.
   */
  openProactive: (
    ref: ScopedThreadRef,
    surface: Extract<RightPanelSurface, { kind: "diff" | "pull-request" | "pull-requests" }>,
    expectedUserActionRevision: number,
  ) => boolean;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "extension">,
  ) => void;
  /** Opens a copied SDK record; an expected revision makes this an automatic request. */
  openExtension: (
    ref: ScopedThreadRef,
    record: ViewRecord,
    expectedUserActionRevision?: number,
  ) => boolean;
  /** Saves an existing viewer without taking focus or reopening a hidden panel. */
  updateExtensionRecord: (
    ref: ScopedThreadRef,
    record: ViewRecord,
    viewerGeneration?: string,
  ) => boolean;
  showExtensionDock: (ref: ScopedThreadRef) => void;
  hideExtensionDock: (ref: ScopedThreadRef) => void;
  setExtensionDockHeight: (ref: ScopedThreadRef, height: number) => void;
  activateDockExtension: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeDockExtension: (ref: ScopedThreadRef, surfaceId: string) => void;
  moveSurface: (ref: ScopedThreadRef, surfaceId: string, toIndex: number) => void;
  openDevice: (ref: ScopedThreadRef, target: DeviceTabTarget, automatic?: boolean) => void;
  renameDevice: (ref: ScopedThreadRef, surfaceId: string, title: string) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
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
    },
  ) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "extension">,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_EXTENSION_DOCK: ExtensionDockState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request" | "extension">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "pull-requests":
      return { id: "pull-requests", kind };
    case "agents":
      return { id: "agents", kind };
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
  presentationRequestId: string,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
  presentationRequestId,
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
  // The environment leads the id where there is one, so the same change request read from two
  // servers is two tabs rather than one tab that changes its mind about which server it is on.
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  const host = target.host === undefined ? "" : `${encodeURIComponent(target.host.toLowerCase())}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${host}${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  host?: string;
  repository: string;
  number: number;
  url?: string;
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
  };
}

/** Invalid or differently scoped records never enter the layout or reach the renderer. */
export function extensionPanelSurface(
  ref: ScopedThreadRef,
  value: ViewRecord,
): ExtensionPanelSurface | null {
  try {
    const record = copyJson(value);
    if (!record || typeof record !== "object") return null;
    assertId(record.surfaceId);
    if (
      !record.surfaceId.includes("/") ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.stateVersion) ||
      record.stateVersion < 1 ||
      !["side-panel", "bottom-dock", "full-page", "compact-detail"].includes(record.placement) ||
      typeof record.fallback !== "string" ||
      !record.fallback.trim()
    )
      return null;
    const context = validateContext(record.context);
    const parsed = parseScopedThreadKey(scopedThreadKey(ref));
    // The existing persistence key splits at the first colon. Reject ambiguous
    // environment IDs rather than restoring their records into a different ref.
    if (
      !parsed ||
      parsed.environmentId !== ref.environmentId ||
      parsed.threadId !== ref.threadId ||
      context.resource.environmentId !== ref.environmentId ||
      (context.resource.threadId !== undefined && context.resource.threadId !== ref.threadId)
    )
      return null;
    return {
      id: `extension:${encodeURIComponent(record.surfaceId)}:${encodeURIComponent(resourceKey(context.resource))}`,
      kind: "extension",
      record: {
        version: 1,
        surfaceId: record.surfaceId,
        context,
        placement: record.placement,
        stateVersion: record.stateVersion,
        restoreState: copyJson(record.restoreState),
        fallback: record.fallback,
      },
    };
  } catch {
    return null;
  }
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (
    !next.isOpen &&
    next.activeSurfaceId === null &&
    next.surfaces.length === 0 &&
    !next.dismissedDeviceSurfaceIds?.length
  ) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

// Every store action is a user choice unless it goes through `automaticUpdate`.
// Only `openProactive` and resource reconciliation are automatic, so a new
// action counts as a user choice by default.
const automaticUpdate = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, updater),
});

const userAction = (
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Partial<RightPanelStoreState> => ({
  byThreadKey: updateThread(state.byThreadKey, threadKey, (current) => {
    const next = updater(current);
    const removed = current.surfaces.filter(
      (surface) =>
        surface.kind === "device" &&
        surface.target &&
        !next.surfaces.some((entry) => entry.id === surface.id),
    );
    if (removed.length === 0) return next;
    return {
      ...next,
      dismissedDeviceSurfaceIds: [
        ...new Set([
          ...(next.dismissedDeviceSurfaceIds ?? []),
          ...removed.map((surface) => surface.id),
        ]),
      ],
    };
  }),
  userActionRevisionByThreadKey: {
    ...state.userActionRevisionByThreadKey,
    [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
  },
});

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function normalizeLegacyRightPanelState(
  persistedState: unknown,
  extensionPlacement?: ViewRecord["placement"],
): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {} };
  }
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
              const extensionIds = new Set<string>();
              const restoredExtensionIds = new Map<string, string>();
              const surfaces = Array.isArray(validThreadState?.surfaces)
                ? validThreadState.surfaces.flatMap<RightPanelSurface>((surface) => {
                    if (!surface || typeof surface !== "object") return [];
                    if (surface.kind === "extension") {
                      const ref = parseScopedThreadKey(threadKey);
                      const normalized = ref ? extensionPanelSurface(ref, surface.record) : null;
                      if (
                        !normalized ||
                        (extensionPlacement !== undefined &&
                          normalized.record.placement !== extensionPlacement) ||
                        extensionIds.has(normalized.id) ||
                        extensionIds.size >= MAX_EXTENSION_SURFACES
                      )
                        return [];
                      extensionIds.add(normalized.id);
                      if (typeof surface.id === "string")
                        restoredExtensionIds.set(surface.id, normalized.id);
                      return [normalized];
                    }
                    if (extensionPlacement !== undefined) return [];
                    if (!(RIGHT_PANEL_KINDS as readonly string[]).includes(surface.kind)) return [];
                    if (typeof surface.id !== "string" || surface.id.startsWith("extension:"))
                      return [];
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
                      const { presentationRequestId, ...restored } = surface;
                      return [
                        {
                          ...restored,
                          revealLine,
                          revealRequestId,
                          ...(typeof presentationRequestId === "string" &&
                          presentationRequestId.length > 0 &&
                          presentationRequestId.length <= 160
                            ? { presentationRequestId }
                            : {}),
                        },
                      ];
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
                      // Anything else stored under that name is not an environment.
                      return [
                        pullRequestSurface({
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
              const rawActiveSurfaceId = validThreadState?.activeSurfaceId;
              const persistedActiveSurfaceId = surfaces.some(
                (surface) => surface.id === rawActiveSurfaceId,
              )
                ? (rawActiveSurfaceId ?? null)
                : typeof rawActiveSurfaceId === "string" &&
                    restoredExtensionIds.has(rawActiveSurfaceId)
                  ? (restoredExtensionIds.get(rawActiveSurfaceId) ?? null)
                  : rawActiveSurfaceId === "pull-request"
                    ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
                    : null;
              // A migration that dropped every surface (e.g. plan-only panels
              // in v9) must not reopen an empty panel.
              const isOpen =
                surfaces.length > 0 &&
                (typeof validThreadState?.isOpen === "boolean"
                  ? validThreadState.isOpen
                  : persistedActiveSurfaceId !== null);
              // An open panel needs an active surface: if migration dropped
              // the persisted one (e.g. plan was active), fall back to the
              // first survivor instead of rendering an open empty panel.
              const activeSurfaceId =
                persistedActiveSurfaceId ?? (isOpen ? (surfaces[0]?.id ?? null) : null);
              return [
                threadKey,
                {
                  isOpen,
                  surfaces,
                  activeSurfaceId,
                  ...(Array.isArray(validThreadState?.dismissedDeviceSurfaceIds)
                    ? {
                        dismissedDeviceSurfaceIds:
                          validThreadState.dismissedDeviceSurfaceIds.filter(
                            (id): id is string => typeof id === "string",
                          ),
                      }
                    : {}),
                },
              ];
            }),
        )
      : {};
  return { byThreadKey };
}

/** Migrate misplaced v12 dock records and normalize current-version storage without activation. */
export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
  extensionDockByThreadKey: Record<string, ExtensionDockState>;
} {
  const { byThreadKey: legacy } = normalizeLegacyRightPanelState(persistedState);
  // Reuse the copied-record validation and identity normalization for persisted dock entries.
  const dockInput =
    persistedState &&
    typeof persistedState === "object" &&
    "extensionDockByThreadKey" in persistedState
      ? persistedState.extensionDockByThreadKey
      : {};
  const currentDocks = normalizeLegacyRightPanelState(
    { byThreadKey: dockInput },
    "bottom-dock",
  ).byThreadKey;
  const byThreadKey: Record<string, ThreadRightPanelState> = {};
  const extensionDockByThreadKey: Record<string, ExtensionDockState> = {};
  for (const threadKey of new Set([...Object.keys(legacy), ...Object.keys(currentDocks)])) {
    const previous = legacy[threadKey] ?? EMPTY_THREAD_STATE;
    const currentDock = currentDocks[threadKey];
    const misplaced = previous.surfaces.filter(
      (surface): surface is ExtensionPanelSurface =>
        surface.kind === "extension" && surface.record.placement === "bottom-dock",
    );
    const surfaces = previous.surfaces.filter(
      (surface) => surface.kind !== "extension" || surface.record.placement !== "bottom-dock",
    );
    const currentDockSurfaces = (currentDock?.surfaces ?? []).filter(
      (surface): surface is ExtensionPanelSurface =>
        surface.kind === "extension" && surface.record.placement === "bottom-dock",
    );
    const remaining =
      MAX_EXTENSION_SURFACES - surfaces.filter((surface) => surface.kind === "extension").length;
    const seen = new Set<string>();
    const dockSurfaces = [...currentDockSurfaces, ...misplaced].filter((surface) => {
      if (seen.has(surface.id) || seen.size >= remaining) return false;
      seen.add(surface.id);
      return true;
    });
    const movedActive = misplaced.some((surface) => surface.id === previous.activeSurfaceId);
    if (threadKey in legacy) {
      byThreadKey[threadKey] = {
        isOpen: previous.isOpen && surfaces.length > 0,
        activeSurfaceId: movedActive ? (surfaces[0]?.id ?? null) : previous.activeSurfaceId,
        surfaces,
        ...(previous.dismissedDeviceSurfaceIds
          ? { dismissedDeviceSurfaceIds: previous.dismissedDeviceSurfaceIds }
          : {}),
      };
    }
    if (dockSurfaces.length) {
      const preferredId =
        currentDock?.activeSurfaceId ?? (movedActive ? previous.activeSurfaceId : null);
      const rawHeight =
        dockInput && typeof dockInput === "object"
          ? (dockInput as Record<string, unknown>)[threadKey]
          : undefined;
      const height =
        rawHeight &&
        typeof rawHeight === "object" &&
        "height" in rawHeight &&
        typeof rawHeight.height === "number" &&
        Number.isFinite(rawHeight.height)
          ? rawHeight.height
          : undefined;
      extensionDockByThreadKey[threadKey] = {
        isOpen: currentDock ? currentDock.isOpen : movedActive && previous.isOpen,
        activeSurfaceId: dockSurfaces.some((surface) => surface.id === preferredId)
          ? preferredId
          : dockSurfaces[0]!.id,
        surfaces: dockSurfaces,
        ...(height !== undefined ? { height } : {}),
      };
    }
  }
  return { byThreadKey, extensionDockByThreadKey };
}

function updateExtensionDock(
  state: RightPanelStoreState,
  threadKey: string,
  updater: (current: ExtensionDockState) => ExtensionDockState,
  userChoice = true,
): Partial<RightPanelStoreState> {
  const current = state.extensionDockByThreadKey[threadKey] ?? EMPTY_EXTENSION_DOCK;
  const next = updater(current);
  if (next === current) return state;
  const extensionDockByThreadKey = { ...state.extensionDockByThreadKey };
  if (!next.surfaces.length) delete extensionDockByThreadKey[threadKey];
  else extensionDockByThreadKey[threadKey] = next;
  return {
    extensionDockByThreadKey,
    ...(userChoice
      ? {
          userActionRevisionByThreadKey: {
            ...state.userActionRevisionByThreadKey,
            [threadKey]: (state.userActionRevisionByThreadKey[threadKey] ?? 0) + 1,
          },
        }
      : {}),
  };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      extensionDockByThreadKey: {},
      userActionRevisionByThreadKey: {},
      getUserActionRevision: (ref) =>
        get().userActionRevisionByThreadKey[scopedThreadKey(ref)] ?? 0,
      openProactive: (ref, surface, expectedUserActionRevision) => {
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          ) {
            return state;
          }
          // A linked PR takes priority over a completed-turn diff. Manual actions
          // always apply, and later user choices reject both proactive requests.
          if (
            surface.kind === "diff" &&
            (selectActiveRightPanel(state.byThreadKey, ref) === "pull-request" ||
              selectActiveRightPanel(state.byThreadKey, ref) === "pull-requests")
          ) {
            return state;
          }
          opened = true;
          return automaticUpdate(state, threadKey, (current) => upsertSurface(current, surface));
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
      openExtension: (ref, record, expectedUserActionRevision) => {
        const surface = extensionPanelSurface(ref, record);
        if (!surface || !["side-panel", "bottom-dock"].includes(surface.record.placement))
          return false;
        surface.viewerGeneration = randomUUID();
        let opened = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            expectedUserActionRevision !== undefined &&
            (state.userActionRevisionByThreadKey[threadKey] ?? 0) !== expectedUserActionRevision
          )
            return state;
          const isDock = surface.record.placement === "bottom-dock";
          const current = isDock
            ? (state.extensionDockByThreadKey[threadKey] ?? EMPTY_EXTENSION_DOCK)
            : (state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE);
          const exists = current.surfaces.some((entry) => entry.id === surface.id);
          const count =
            (state.byThreadKey[threadKey]?.surfaces.filter((entry) => entry.kind === "extension")
              .length ?? 0) + (state.extensionDockByThreadKey[threadKey]?.surfaces.length ?? 0);
          if (!exists && count >= MAX_EXTENSION_SURFACES) return state;
          opened = true;
          if (isDock)
            return updateExtensionDock(
              state,
              threadKey,
              (dock) => ({
                isOpen: true,
                activeSurfaceId: surface.id,
                surfaces: exists
                  ? dock.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                  : [...dock.surfaces, surface],
              }),
              expectedUserActionRevision === undefined,
            );
          const update = expectedUserActionRevision === undefined ? userAction : automaticUpdate;
          return update(state, threadKey, (panel) => ({
            ...upsertSurface(panel, surface),
            surfaces: exists
              ? panel.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
              : [...panel.surfaces, surface],
          }));
        });
        return opened;
      },
      updateExtensionRecord: (ref, record, viewerGeneration) => {
        const surface = extensionPanelSurface(ref, record);
        if (!surface || !["side-panel", "bottom-dock"].includes(surface.record.placement))
          return false;
        let updated = false;
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (surface.record.placement === "bottom-dock") {
            const dock = state.extensionDockByThreadKey[threadKey];
            const existing = dock?.surfaces.find((entry) => entry.id === surface.id);
            if (!existing || !canSaveExtensionRecord(existing, surface.record, viewerGeneration))
              return state;
            const saved = {
              ...existing,
              record: { ...existing.record, restoreState: surface.record.restoreState },
            };
            updated = true;
            return updateExtensionDock(
              state,
              threadKey,
              (current) => ({
                ...current,
                surfaces: current.surfaces.map((entry) =>
                  entry.id === surface.id ? saved : entry,
                ),
              }),
              false,
            );
          }
          const current = state.byThreadKey[threadKey];
          const existing = current?.surfaces.find(
            (entry): entry is ExtensionPanelSurface =>
              entry.kind === "extension" && entry.id === surface.id,
          );
          if (!existing || !canSaveExtensionRecord(existing, surface.record, viewerGeneration))
            return state;
          const saved = {
            ...existing,
            record: { ...existing.record, restoreState: surface.record.restoreState },
          };
          updated = true;
          return automaticUpdate(state, threadKey, (panel) => ({
            ...panel,
            surfaces: panel.surfaces.map((entry) => (entry.id === surface.id ? saved : entry)),
          }));
        });
        return updated;
      },
      showExtensionDock: (ref) =>
        set((state) =>
          updateExtensionDock(state, scopedThreadKey(ref), (dock) =>
            dock.isOpen || !dock.surfaces.length ? dock : { ...dock, isOpen: true },
          ),
        ),
      hideExtensionDock: (ref) =>
        set((state) =>
          updateExtensionDock(state, scopedThreadKey(ref), (dock) =>
            dock.isOpen ? { ...dock, isOpen: false } : dock,
          ),
        ),
      setExtensionDockHeight: (ref, height) =>
        set((state) =>
          Number.isFinite(height)
            ? updateExtensionDock(state, scopedThreadKey(ref), (dock) =>
                dock.height === height ? dock : { ...dock, height },
              )
            : state,
        ),
      activateDockExtension: (ref, surfaceId) =>
        set((state) =>
          updateExtensionDock(state, scopedThreadKey(ref), (dock) =>
            !dock.surfaces.some((surface) => surface.id === surfaceId) ||
            (dock.isOpen && dock.activeSurfaceId === surfaceId)
              ? dock
              : { ...dock, isOpen: true, activeSurfaceId: surfaceId },
          ),
        ),
      closeDockExtension: (ref, surfaceId) =>
        set((state) =>
          updateExtensionDock(state, scopedThreadKey(ref), (dock) => {
            const index = dock.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index === -1) return dock;
            const surfaces = dock.surfaces.filter((surface) => surface.id !== surfaceId);
            return {
              isOpen: dock.isOpen && surfaces.length > 0,
              activeSurfaceId:
                dock.activeSurfaceId === surfaceId
                  ? (surfaces[Math.min(index, surfaces.length - 1)]?.id ?? null)
                  : dock.activeSurfaceId,
              surfaces,
            };
          }),
        ),
      moveSurface: (ref, surfaceId, toIndex) =>
        set((state) => {
          if (!Number.isSafeInteger(toIndex)) return state;
          return userAction(state, scopedThreadKey(ref), (current) => {
            const fromIndex = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (fromIndex < 0) return current;
            const target = Math.max(0, Math.min(toIndex, current.surfaces.length - 1));
            if (target === fromIndex) return current;
            const surfaces = [...current.surfaces];
            const [surface] = surfaces.splice(fromIndex, 1);
            if (!surface) return current;
            surfaces.splice(target, 0, surface);
            return { ...current, surfaces };
          });
        }),
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
      renameDevice: (ref, surfaceId, title) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId && surface.kind === "device"
                ? { ...surface, title: title.trim() || surface.target?.name || "Device" }
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
      openFile: (ref, requestedPath, line) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
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
              randomUUID(),
            );
            return {
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
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        ),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
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
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
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
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
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
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      closeSurface: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          userAction(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
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
          userAction(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) =>
          automaticUpdate(state, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
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
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.extensionDockByThreadKey) &&
            !(threadKey in state.userActionRevisionByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          const { [threadKey]: _revision, ...userActionRevisionByThreadKey } =
            state.userActionRevisionByThreadKey;
          const { [threadKey]: _dock, ...extensionDockByThreadKey } =
            state.extensionDockByThreadKey;
          return { byThreadKey: rest, extensionDockByThreadKey, userActionRevisionByThreadKey };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        extensionDockByThreadKey: Object.fromEntries(
          Object.entries(state.extensionDockByThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey),
          ),
        ),
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey),
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedRightPanelState(persistedState),
      }),
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
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

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectThreadExtensionDock(
  byThreadKey: Record<string, ExtensionDockState>,
  ref: ScopedThreadRef | null | undefined,
): ExtensionDockState {
  return ref ? (byThreadKey[scopedThreadKey(ref)] ?? EMPTY_EXTENSION_DOCK) : EMPTY_EXTENSION_DOCK;
}

function canSaveExtensionRecord(
  existing: ExtensionPanelSurface,
  record: ViewRecord,
  generation: string | undefined,
): boolean {
  if (existing.viewerGeneration !== generation) return false;
  const { restoreState: _oldState, ...oldMetadata } = existing.record;
  const { restoreState: _newState, ...newMetadata } = record;
  return JSON.stringify(oldMetadata) === JSON.stringify(newMetadata);
}
