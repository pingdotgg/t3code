import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClientProviderEmitEvent } from "@t3tools/contracts";
import type { Json } from "@t3tools/extension-sdk/contracts";
import {
  applyThemeColorPreview,
  transferThemePreviewOwner,
  getThemeColorVariable,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  THEME_COLOR_ROLES,
  THEME_PREVIEW_ID,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "../themePalette";
import { themeStore } from "../hooks/useTheme";
import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { toastManager, type ThreadToastData } from "../components/ui/toast";
import { terminalThemeFromApp } from "../components/ThreadTerminalDrawer";
import {
  extensionPanelSurface,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { installedSurfaceRecord, installedWorkspaceContext } from "./installedContext";
import { readProject, readThreadShell } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildFileReviewComment } from "../reviewCommentContext";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  normalizeTerminalContextSelection,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  authorizeCaller,
  ClientProviderOpError,
  readInputObject,
  readInputString,
  type ClientLocalProvider,
  type ClientProviderAuthDeps,
  type ClientProviderInvokeCall,
  type ClientProviderStreamCall,
} from "./clientProviderTypes";
import { createKeybindingsClientProvider } from "./extensionCommandRegistry";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";

/** Local stores the providers drive; injected so tests can substitute fakes. */
export interface ClientProviderDeps extends ClientProviderAuthDeps {
  readonly environmentId: EnvironmentId;
  readonly client: string;
  readonly emit: (correlationId: string, event: ClientProviderEmitEvent) => void;
}

// ---------------------------------------------------------------------------
// Theme — stored prefs + provider-owned session overlay + preview ownership.

interface ThemeSessionOverlay {
  readonly theme: string;
  readonly appearanceMode?: ThemePreferenceMode;
  readonly themeHalves?: ThemeHalves;
  readonly writer: string;
}

// The painted document is client-global, so the overlay record is shared by
// every environment's provider — last-writer-wins across installations.
let sessionOverlay: ThemeSessionOverlay | null = null;
const overlayListeners = new Set<() => void>();

function setSessionOverlay(next: ThemeSessionOverlay | null) {
  sessionOverlay = next;
  for (const listener of overlayListeners) listener();
}

export function subscribeThemeOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => {
    overlayListeners.delete(listener);
  };
}

/** The owner tag painted with the current `__preview`, or null when none is shown. "" means unattributed. */
function paintedPreviewOwner(): string | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  return root.dataset.themeId === THEME_PREVIEW_ID ? (root.dataset.themePreviewOwner ?? "") : null;
}

function paintedTokens(): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (typeof document === "undefined") return tokens;
  const styles = getComputedStyle(document.documentElement);
  for (const role of THEME_COLOR_ROLES) {
    const value = styles.getPropertyValue(getThemeColorVariable(role)).trim();
    if (value) tokens[role] = value;
  }
  return tokens;
}

/**
 * An editor draft or unattributed preview blocks session writes. A paint owned
 * by another installation is a peer overlay — equal peers, last-writer-wins —
 * so it is superseded, not refused.
 */
function previewIsForeign(installationIds: ReadonlySet<string>): boolean {
  const owner = paintedPreviewOwner();
  if (owner === null || owner === sessionOverlay?.writer) return false;
  return !installationIds.has(owner);
}

function themeStateSnapshot() {
  const snapshot = themeStore.getSnapshot();
  const owner = paintedPreviewOwner();
  let effectiveTheme: Json;
  let overlay: Json = null;
  if (owner !== null && owner === sessionOverlay?.writer && sessionOverlay) {
    effectiveTheme = {
      kind: "session-overlay",
      theme: sessionOverlay.theme,
      writer: sessionOverlay.writer,
    };
    overlay = {
      theme: sessionOverlay.theme,
      ...(sessionOverlay.appearanceMode !== undefined
        ? { appearanceMode: sessionOverlay.appearanceMode }
        : {}),
      ...(sessionOverlay.themeHalves !== undefined
        ? { themeHalves: sessionOverlay.themeHalves }
        : {}),
      writer: sessionOverlay.writer,
    };
  } else if (owner !== null) {
    // An editor draft or unattributed paint supersedes any overlay record we
    // held — drop it so it cannot resurface once the foreign paint clears.
    sessionOverlay = null;
    // Report what is actually painted.
    effectiveTheme = {
      kind: "external-preview",
      tokens: paintedTokens(),
      ...(owner ? { writer: owner } : {}),
    };
  } else {
    // Nothing preview-painted: a stored repaint underneath (persist, refresh,
    // cross-tab storage) retires the overlay record so it cannot keep
    // steering token resolution or resurface on the next read.
    if (sessionOverlay) sessionOverlay = null;
    effectiveTheme = {
      kind: "stored",
      theme:
        (typeof document !== "undefined" && document.documentElement.dataset.themeId) ||
        snapshot.theme,
    };
  }
  return {
    theme: snapshot.theme,
    resolvedTheme: snapshot.resolvedTheme,
    systemDark: snapshot.systemDark,
    followSystem: snapshot.followSystem,
    appearanceMode: snapshot.appearanceMode,
    themeHalves: snapshot.themeHalves,
    effectiveTheme,
    sessionOverlay: overlay,
  } as unknown as Json;
}

function resolveThemeTokens(appearance?: ThemeAppearance): Json {
  const cssVars: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) cssVars[role] = getThemeColorVariable(role);
  if (appearance === undefined && paintedPreviewOwner() !== null) {
    // A preview is painted: report the live computed values, not stored prefs.
    return { tokens: paintedTokens(), cssVars } as unknown as Json;
  }
  const snapshot = themeStore.getSnapshot();
  const mode = appearance ?? snapshot.resolvedTheme;
  // The overlay steers resolution only while its paint is still up.
  const overlay =
    sessionOverlay && paintedPreviewOwner() === sessionOverlay.writer ? sessionOverlay : null;
  const baseTheme = overlay && appearance === undefined ? overlay.theme : snapshot.theme;
  const halves = overlay?.themeHalves ?? snapshot.themeHalves;
  const themeId = resolveThemeHalf(baseTheme, halves ?? null, mode);
  const definition = getThemeDefinition(themeId);
  if (!definition) {
    // "system" and other unresolvable preferences carry no palette — the real
    // colors are whatever the stylesheets currently compute.
    return { tokens: paintedTokens(), cssVars } as unknown as Json;
  }
  const colors = getThemeColorsForMode(definition, mode) ?? definition.colors;
  const tokens: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) {
    if (colors?.[role]) tokens[role] = colors[role];
  }
  return { tokens, cssVars } as unknown as Json;
}

function paintOverlay(overlay: ThemeSessionOverlay): "painted" | "unknown-theme" | "refused" {
  const snapshot = themeStore.getSnapshot();
  const mode =
    overlay.appearanceMode === "light" || overlay.appearanceMode === "dark"
      ? overlay.appearanceMode
      : snapshot.resolvedTheme;
  const themeId = resolveThemeHalf(overlay.theme, overlay.themeHalves ?? null, mode);
  const definition = getThemeDefinition(themeId);
  if (!definition) return "unknown-theme";
  const colors = getThemeColorsForMode(definition, mode) ?? definition.colors;
  // A peer installation's overlay owns the paint: supersede acquires the
  // owner record first, then repaints through the single-writer gate. The
  // caller already refused foreign/editor/unattributed paint, so a tagged
  // owner here is a peer (or this writer repainting its own overlay).
  const owner = paintedPreviewOwner();
  if (owner !== null && owner !== overlay.writer) transferThemePreviewOwner(overlay.writer);
  return applyThemeColorPreview(colors, mode, overlay.writer) ? "painted" : "refused";
}

export function createThemeClientProvider(deps: ClientProviderDeps): ClientLocalProvider {
  const read = (call: ClientProviderInvokeCall | ClientProviderStreamCall) =>
    authorizeCaller(deps, call.caller, call.context, ["t3.ui/theme.read"]);
  const write = (call: ClientProviderInvokeCall) =>
    authorizeCaller(deps, call.caller, call.context, ["t3.ui/theme.write"]);
  const foreignPreview = () =>
    previewIsForeign(new Set((deps.installations() ?? []).map((item) => item.id)));
  return {
    invoke(call) {
      const input = readInputObject(call.input);
      switch (call.method) {
        case "getState":
          read(call);
          return themeStateSnapshot();
        case "resolveTokens": {
          read(call);
          const appearance = input.appearance;
          if (appearance !== undefined && appearance !== "light" && appearance !== "dark")
            throw new ClientProviderOpError("provider-rejected", "Invalid appearance");
          return resolveThemeTokens(appearance);
        }
        case "applyPreference": {
          write(call);
          const writer = readInputString(input, "writer")!;
          if (writer !== call.caller.installationId)
            throw new ClientProviderOpError(
              "client-target-denied",
              "Writer must be the calling installation",
            );
          const preference = readInputObject(input.preference ?? null);
          const mode = readInputString(preference, "mode");
          if (preference.clear === true) {
            if (foreignPreview())
              return { applied: false, reason: "external-preview-active" } as unknown as Json;
            if (sessionOverlay) setSessionOverlay(null);
            themeStore.refreshTheme();
            return { applied: true, propagatedTo: "connection" } as unknown as Json;
          }
          if (mode === "session") {
            const theme = readInputString(preference, "theme")!;
            const appearanceMode = preference.appearanceMode;
            if (
              appearanceMode !== undefined &&
              appearanceMode !== "light" &&
              appearanceMode !== "dark" &&
              appearanceMode !== "system"
            )
              throw new ClientProviderOpError("provider-rejected", "Invalid appearanceMode");
            if (foreignPreview())
              return { applied: false, reason: "external-preview-active" } as unknown as Json;
            const themeHalves = preference.themeHalves;
            const next: ThemeSessionOverlay = {
              theme,
              ...(appearanceMode !== undefined
                ? { appearanceMode: appearanceMode as ThemePreferenceMode }
                : {}),
              ...(themeHalves !== null &&
              typeof themeHalves === "object" &&
              !Array.isArray(themeHalves)
                ? { themeHalves: themeHalves as ThemeHalves }
                : {}),
              writer,
            };
            const painted = paintOverlay(next);
            if (painted !== "painted")
              return {
                applied: false,
                reason: painted === "unknown-theme" ? "unknown-theme" : "external-preview-active",
              } as unknown as Json;
            setSessionOverlay(next);
            themeStore.emitChange();
            return { applied: true, propagatedTo: "connection" } as unknown as Json;
          }
          if (mode === "persist") {
            const theme = preference.theme;
            if (theme !== undefined) {
              if (typeof theme !== "string" || !theme)
                throw new ClientProviderOpError("provider-rejected", "Invalid theme");
              if (!themeStore.setTheme(theme))
                return { applied: false, reason: "theme-write-failed" } as unknown as Json;
            }
            const appearanceMode = preference.appearanceMode;
            if (
              appearanceMode === "light" ||
              appearanceMode === "dark" ||
              appearanceMode === "system"
            )
              themeStore.setAppearanceMode(appearanceMode);
            const halves = preference.themeHalves;
            if (halves !== undefined && halves !== null) {
              if (typeof halves !== "object" || Array.isArray(halves))
                throw new ClientProviderOpError("provider-rejected", "Invalid themeHalves");
              themeStore.setThemeHalves(halves as { light?: string; dark?: string });
            }
            if (sessionOverlay) setSessionOverlay(null);
            // A stored write supersedes an installation-owned overlay — the
            // paint and token resolution must both show the persisted theme.
            // A foreign/editor preview is never clobbered by a persist.
            if (!foreignPreview() && paintedPreviewOwner() !== null) themeStore.refreshTheme();
            return { applied: true, propagatedTo: "storage-origin" } as unknown as Json;
          }
          throw new ClientProviderOpError("provider-rejected", "Invalid mode");
        }
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown theme op ${call.method}`,
          );
      }
    },
    openStream(call) {
      read(call);
      if (call.name !== "watchState")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown theme stream ${call.name}`,
        );
      call.emit({ type: "snapshot", value: themeStateSnapshot() });
      let last = JSON.stringify(themeStateSnapshot());
      const push = () => {
        const next = themeStateSnapshot();
        const encoded = JSON.stringify(next);
        if (encoded === last) return;
        last = encoded;
        call.emit({ type: "data", value: next });
      };
      const unsubs = [themeStore.subscribe(push), subscribeThemeOverlay(push)];
      const observer =
        typeof MutationObserver !== "undefined" && typeof document !== "undefined"
          ? new MutationObserver(push)
          : null;
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-id", "data-theme-preview-owner", "style", "class"],
      });
      return () => {
        observer?.disconnect();
        for (const unsub of unsubs) unsub();
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Notifications — toast-backed, owner-scoped, outcomes over emit.

interface OwnedNotification {
  readonly toastId: string;
  readonly owner: string;
  readonly data: ThreadToastData;
  readonly timeoutId?: ReturnType<typeof setTimeout>;
}

const notificationsByEnvironment = new Map<string, Map<string, OwnedNotification>>();

function notificationsFor(environmentId: string): Map<string, OwnedNotification> {
  let map = notificationsByEnvironment.get(environmentId);
  if (!map) {
    map = new Map();
    notificationsByEnvironment.set(environmentId, map);
  }
  return map;
}

export function createNotificationsClientProvider(deps: ClientProviderDeps): ClientLocalProvider {
  const owned = notificationsFor(deps.environmentId);
  const ownedEntry = (call: ClientProviderInvokeCall, notificationId: string) => {
    const entry = owned.get(notificationId);
    if (!entry) throw new ClientProviderOpError("notification-expired", "Unknown notification");
    if (entry.owner !== call.caller.installationId)
      throw new ClientProviderOpError(
        "notification-owner-mismatch",
        "Notification belongs to another installation",
      );
    return entry;
  };
  // First-write-wins settle: deletes the owned record, stops its lifetime
  // timer, and emits the outcome exactly once per notification.
  const settle = (notificationId: string, outcome: { actionId: string } | { dismissed: true }) => {
    const entry = owned.get(notificationId);
    if (!entry) return;
    owned.delete(notificationId);
    if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId);
    deps.emit(notificationId, { type: "notificationOutcome", outcome });
  };
  const variantMap = {
    default: "secondary",
    primary: "default",
    destructive: "destructive",
  } as const satisfies Record<string, NonNullable<ThreadToastData["secondaryActionVariant"]>>;
  return {
    invoke(call) {
      authorizeCaller(deps, call.caller, call.context, ["t3.ui/notify"]);
      const input = readInputObject(call.input);
      switch (call.method) {
        case "notify": {
          const notification = readInputObject(input.notification ?? null);
          const notificationId = readInputString(notification, "notificationId")!;
          const severity = readInputString(notification, "severity")!;
          const title = readInputString(notification, "title")!;
          const body = notification.body;
          const actions = Array.isArray(notification.actions) ? notification.actions : [];
          // Targeting fields are ScopedThreadRef-only: an input threadId or
          // projectId may name the invocation context's own scope, nothing else.
          const threadId = readInputString(notification, "threadId", false);
          const projectId = readInputString(notification, "projectId", false);
          const scoped = call.context.resource;
          if (threadId !== undefined && threadId !== scoped.threadId)
            throw new ClientProviderOpError(
              "client-target-denied",
              "Notification thread target is outside the granted thread scope",
            );
          if (projectId !== undefined && projectId !== scoped.projectId)
            throw new ClientProviderOpError(
              "client-target-denied",
              "Notification project target is outside the granted project scope",
            );
          const anchor = readInputString(notification, "anchor", false) ?? "global";
          if (anchor !== "global" && anchor !== "thread")
            throw new ClientProviderOpError("provider-rejected", "Unsupported anchor");
          // `anchor:"thread"` renders through the native active-thread filter:
          // the toast exists globally but only paints while its thread is
          // active. Without a threadId there is nothing to anchor to.
          const effectiveThreadId = anchor === "thread" ? (threadId ?? scoped.threadId) : threadId;
          if (anchor === "thread" && !effectiveThreadId)
            throw new ClientProviderOpError(
              "provider-rejected",
              "A thread-anchored notification requires a threadId",
            );
          const threadRef =
            effectiveThreadId !== undefined
              ? scopeThreadRef(deps.environmentId, ThreadId.make(effectiveThreadId))
              : undefined;
          const dismissible = notification.dismissible !== false;
          const toastData: ThreadToastData = {
            ...(threadRef !== undefined ? { threadRef } : {}),
            dismissible,
            onClose: () => settle(notificationId, { dismissed: true }),
            ...(actions.length > 0
              ? {
                  additionalActions: actions.slice(0, 3).map((action) => {
                    const record = readInputObject(action);
                    const actionId = readInputString(record, "id")!;
                    const label = readInputString(record, "label")!;
                    const variant = readInputString(record, "variant", false);
                    return {
                      id: actionId,
                      ...(variant !== undefined && variant in variantMap
                        ? { variant: variantMap[variant as keyof typeof variantMap] }
                        : {}),
                      props: {
                        children: label,
                        onClick: () => {
                          settle(notificationId, { actionId });
                          toastManager.close(toastId);
                        },
                      },
                    };
                  }),
                }
              : {}),
          };
          const toastId = toastManager.add({
            type: severity,
            title,
            ...(typeof body === "string" ? { description: body } : {}),
            // The manager defaults every toast to a 5 s auto-dismiss whose
            // close path never reaches `data.onClose` — `timeout: 0` keeps
            // lifetime owned here, and the top-level `onClose` settles the
            // outcome record on every remaining close path (timeout close,
            // closeAll, swipe, programmatic close), not just the X button.
            timeout: 0,
            onClose: () => settle(notificationId, { dismissed: true }),
            data: toastData,
          });
          const timeoutId =
            typeof notification.durationMs === "number"
              ? setTimeout(() => {
                  settle(notificationId, { dismissed: true });
                  toastManager.close(toastId);
                }, notification.durationMs)
              : undefined;
          owned.set(notificationId, {
            toastId,
            owner: call.caller.installationId,
            data: toastData,
            ...(timeoutId !== undefined ? { timeoutId } : {}),
          });
          return { applied: true } as unknown as Json;
        }
        case "update": {
          const notificationId = readInputString(input, "notificationId")!;
          const entry = ownedEntry(call, notificationId);
          const patch = readInputObject(input.patch ?? null);
          const patchRecord: Record<string, unknown> = {};
          if (typeof patch.severity === "string") patchRecord.type = patch.severity;
          if (typeof patch.title === "string") patchRecord.title = patch.title;
          if (typeof patch.body === "string") patchRecord.description = patch.body;
          if (typeof patch.dismissible === "boolean") {
            // `data` replaces wholesale on update — merge onto the stored copy.
            patchRecord.data = { ...entry.data, dismissible: patch.dismissible };
          }
          toastManager.update(entry.toastId, patchRecord);
          return { applied: true } as unknown as Json;
        }
        case "dismiss": {
          const notificationId = readInputString(input, "notificationId")!;
          const entry = ownedEntry(call, notificationId);
          settle(notificationId, { dismissed: true });
          toastManager.close(entry.toastId);
          return { dismissed: true } as unknown as Json;
        }
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown notifications op ${call.method}`,
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Panels — client-local lifecycle over rightPanelStore, owner+context scoped.

function installationSurface(deps: ClientProviderDeps, installationId: string, surfaceId: string) {
  const installation = deps.installations()?.find((item) => item.id === installationId);
  const surface = installation?.package.manifest.surfaces.find(
    (candidate) => candidate.id === surfaceId,
  );
  if (!installation || !surface)
    throw new ClientProviderOpError("panel-surface-not-found", "Unknown extension surface");
  return { installation, surface };
}

export function createPanelsClientProvider(deps: ClientProviderDeps): ClientLocalProvider {
  return {
    invoke(call) {
      authorizeCaller(deps, call.caller, call.context, ["t3.ui/panels"]);
      const input = readInputObject(call.input);
      const threadId = readInputString(input, "threadId");
      if (!threadId) throw new ClientProviderOpError("provider-rejected", "Missing threadId");
      const ref = scopeThreadRef(deps.environmentId, ThreadId.make(threadId));
      const store = useRightPanelStore.getState();
      switch (call.method) {
        case "openSurface": {
          const surfaceId = readInputString(input, "surfaceId")!;
          const { installation, surface } = installationSurface(
            deps,
            call.caller.installationId,
            surfaceId,
          );
          // Omitted placement means the surface's own first declared slot.
          const requestedPlacement = readInputString(input, "placement", false);
          const placement = requestedPlacement ?? surface.placements[0];
          if (placement !== "side-panel" && placement !== "bottom-dock")
            throw new ClientProviderOpError("provider-rejected", "Unsupported placement");
          if (!surface.placements.includes(placement))
            throw new ClientProviderOpError(
              "provider-rejected",
              "Placement not declared by the surface",
            );
          if (!surface.clients.includes(deps.client))
            throw new ClientProviderOpError("provider-rejected", "Surface is not for this client");
          const shell = readThreadShell(ref);
          if (!shell?.projectId)
            throw new ClientProviderOpError("panel-surface-not-found", "Unknown thread");
          if (!installation.grants.projectIds.some((id) => id === shell.projectId))
            throw new ClientProviderOpError("client-target-denied", "Thread outside granted scope");
          const project = readProject(scopeProjectRef(deps.environmentId, shell.projectId));
          if (!project)
            throw new ClientProviderOpError("panel-surface-not-found", "Unknown project");
          const context = installedWorkspaceContext({
            environmentId: deps.environmentId,
            projectId: shell.projectId,
            threadId,
            projectWorkspaceRoot: project.workspaceRoot,
            threadWorktreePath: shell.worktreePath ?? null,
            client: deps.client,
          });
          // Mirrors the InstalledExtensionMenu open path: an identical live
          // surface is activated; a changed record replaces it.
          const record = installedSurfaceRecord(
            call.caller.installationId,
            surface,
            placement,
            context,
          );
          const requested = extensionPanelSurface(ref, record);
          if (!requested)
            throw new ClientProviderOpError("panel-surface-not-found", "Surface rejected");
          const layout =
            placement === "bottom-dock"
              ? selectThreadExtensionDock(store.extensionDockByThreadKey, ref)
              : selectThreadRightPanelState(store.byThreadKey, ref);
          const existing = layout.surfaces.find((entry) => entry.id === requested.id);
          if (
            existing?.kind === "extension" &&
            existing.record.version === requested.record.version &&
            existing.record.stateVersion === requested.record.stateVersion &&
            existing.record.placement === requested.record.placement &&
            existing.record.context.client === requested.record.context.client &&
            existing.record.context.workspaceRevision === requested.record.context.workspaceRevision
          ) {
            if (placement === "bottom-dock") store.activateDockExtension(ref, existing.id);
            else store.activateSurface(ref, existing.id);
          } else if (!store.openExtension(ref, record)) {
            throw new ClientProviderOpError("panel-surface-not-found", "Surface could not open");
          }
          return { surfaceId } as unknown as Json;
        }
        case "activateSurface":
        case "closeSurface": {
          const surfaceId = readInputString(input, "surfaceId")!;
          // Owner-scoped: callers may only drive surfaces carrying their own
          // installation prefix — same rule listSurfaces enumerates by.
          if (!surfaceId.startsWith(`${call.caller.installationId}/`))
            throw new ClientProviderOpError(
              "client-target-denied",
              "Surface belongs to another installation",
            );
          const panel = selectThreadRightPanelState(store.byThreadKey, ref);
          const dock = selectThreadExtensionDock(store.extensionDockByThreadKey, ref);
          const side = panel.surfaces.find(
            (surface) => surface.kind === "extension" && surface.record.surfaceId === surfaceId,
          );
          const inDock = dock.surfaces.find((surface) => surface.record.surfaceId === surfaceId);
          if (!side && !inDock)
            throw new ClientProviderOpError("panel-surface-not-found", "Surface is not open");
          if (call.method === "activateSurface") {
            if (side) store.activateSurface(ref, side.id);
            else if (inDock) store.activateDockExtension(ref, inDock.id);
          } else {
            if (side) store.closeSurface(ref, side.id);
            else if (inDock) store.closeDockExtension(ref, inDock.id);
          }
          return { applied: true } as unknown as Json;
        }
        case "listSurfaces": {
          const installation = deps
            .installations()
            ?.find((item) => item.id === call.caller.installationId);
          const panel = selectThreadRightPanelState(store.byThreadKey, ref);
          const dock = selectThreadExtensionDock(store.extensionDockByThreadKey, ref);
          const surfaces: { id: string; title: string; placement: string; active: boolean }[] = [];
          const prefix = `${call.caller.installationId}/`;
          for (const surface of panel.surfaces) {
            if (surface.kind !== "extension" || !surface.record.surfaceId.startsWith(prefix))
              continue;
            surfaces.push({
              id: surface.record.surfaceId,
              title:
                installation?.package.manifest.surfaces.find(
                  (entry) => entry.id === surface.record.surfaceId,
                )?.title ?? surface.record.surfaceId,
              placement: "side-panel",
              active: panel.activeSurfaceId === surface.id,
            });
          }
          for (const surface of dock.surfaces) {
            if (!surface.record.surfaceId.startsWith(prefix)) continue;
            surfaces.push({
              id: surface.record.surfaceId,
              title:
                installation?.package.manifest.surfaces.find(
                  (entry) => entry.id === surface.record.surfaceId,
                )?.title ?? surface.record.surfaceId,
              placement: "bottom-dock",
              active: dock.activeSurfaceId === surface.id && dock.isOpen,
            });
          }
          return { surfaces } as unknown as Json;
        }
        case "hideDock":
          store.hideExtensionDock(ref);
          return { applied: true } as unknown as Json;
        case "showDock":
          store.showExtensionDock(ref);
          return { applied: true } as unknown as Json;
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown panels op ${call.method}`,
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Composer — real composerDraftStore writes, ScopedThreadRef only.

/**
 * `buildFileReviewComment` slices the quoted code out of `contents` by 1-based
 * line number, treating it as the whole file. An excerpt is not a whole file:
 * passed through raw, any comment below the excerpt's own line count quotes
 * nothing, and without an excerpt the comment body or path would be quoted as
 * code. Padding the excerpt to its real line position makes the slice yield
 * exactly the excerpt; no excerpt means no quoted code.
 */
function composerQuotedContents(excerpt: string, startLine: number, endLine: number): string {
  if (excerpt === "") return "";
  const firstLine = Math.max(1, Math.min(startLine, endLine));
  return "\n".repeat(firstLine - 1) + excerpt;
}

function composerThread(call: ClientProviderInvokeCall, threadId: string): ScopedThreadRef {
  const scoped = call.context.resource.threadId;
  if (threadId !== scoped)
    throw new ClientProviderOpError(
      "client-target-denied",
      "Draft target is outside the granted thread scope",
    );
  return scopeThreadRef(
    EnvironmentId.make(call.context.resource.environmentId),
    ThreadId.make(threadId),
  );
}

/** Appends `serializeComposerFileLink(path) + " "` with a leading boundary — the byte-exact reduction of the Files panel's `insertTextAtEnd(…, {ensureLeadingBoundary: true})` at the end position. */
function appendMention(prompt: string, path: string): string {
  const boundary = prompt.length > 0 && !/\s/.test(prompt[prompt.length - 1] ?? "") ? " " : "";
  return `${prompt}${boundary}${serializeComposerFileLink(path)} `;
}

/** The canonical selection normalizer; a selection that empties on trim is the provider's named rejection. */
function requireTerminalSelection(selection: TerminalContextSelection): TerminalContextSelection {
  const normalized = normalizeTerminalContextSelection(selection);
  if (normalized === null)
    throw new ClientProviderOpError("provider-rejected", "Invalid terminal context");
  return normalized;
}

function readAnnotationSelection(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ClientProviderOpError("provider-rejected", "Invalid selection");
  const record = value as Record<string, unknown>;
  const side = (key: string): "additions" | "deletions" => {
    const entry = record[key];
    if (entry !== "additions" && entry !== "deletions")
      throw new ClientProviderOpError("provider-rejected", `Invalid selection ${key}`);
    return entry;
  };
  const line = (key: string): number => {
    const entry = record[key];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 1_000_000)
      throw new ClientProviderOpError("provider-rejected", `Invalid selection ${key}`);
    return entry;
  };
  return { start: line("start"), side: side("side"), end: line("end"), endSide: side("endSide") };
}

export function createComposerClientProvider(deps: ClientProviderDeps): ClientLocalProvider {
  return {
    invoke(call) {
      const input = readInputObject(call.input);
      switch (call.method) {
        case "insertContext": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const refs = input.refs;
          if (!Array.isArray(refs) || refs.length === 0 || refs.length > 8)
            throw new ClientProviderOpError("provider-rejected", "refs must be 1-8 entries");
          const store = useComposerDraftStore.getState();
          let inserted = 0;
          for (const item of refs) {
            const record = readInputObject(item);
            const path = readInputString(record, "path")!;
            const startLine = typeof record.startLine === "number" ? record.startLine : 1;
            const endLine = typeof record.endLine === "number" ? record.endLine : startLine;
            const excerpt = typeof record.excerpt === "string" ? record.excerpt : "";
            store.addReviewComment(
              ref,
              buildFileReviewComment({
                id: `ext-context:${call.caller.installationId}:${randomUUID()}`,
                filePath: path,
                startLine,
                endLine,
                text: excerpt || `Context from ${path}`,
                contents: composerQuotedContents(excerpt, startLine, endLine),
              }),
            );
            inserted += 1;
          }
          return {
            inserted,
            target: `${ref.environmentId}:${ref.threadId}`,
          } as unknown as Json;
        }
        case "insertMention": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const paths = input.paths;
          if (!Array.isArray(paths) || paths.length === 0 || paths.length > 8)
            throw new ClientProviderOpError("provider-rejected", "paths must be 1-8 entries");
          for (const path of paths) {
            if (typeof path !== "string" || !path || path.length > 512)
              throw new ClientProviderOpError("provider-rejected", "Invalid path");
          }
          const store = useComposerDraftStore.getState();
          let prompt = store.getComposerDraft(ref)?.prompt ?? "";
          for (const path of paths) prompt = appendMention(prompt, path);
          store.setPrompt(ref, prompt);
          return {
            inserted: paths.length,
            target: `${ref.environmentId}:${ref.threadId}`,
          } as unknown as Json;
        }
        case "insertTerminalContext": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const lineStart = input.lineStart;
          const lineEnd = input.lineEnd;
          if (typeof lineStart !== "number" || typeof lineEnd !== "number")
            throw new ClientProviderOpError("provider-rejected", "Invalid line range");
          const selection = requireTerminalSelection({
            terminalId: readInputString(input, "terminalId")!,
            terminalLabel: readInputString(input, "terminalLabel")!,
            lineStart,
            lineEnd,
            text: readInputString(input, "text")!,
          });
          const store = useComposerDraftStore.getState();
          // The store dedupes on (terminalId, lineStart, lineEnd); say so
          // instead of reporting an insert it silently dropped.
          const duplicate = (store.getComposerDraft(ref)?.terminalContexts ?? []).some(
            (context) =>
              context.terminalId === selection.terminalId &&
              context.lineStart === selection.lineStart &&
              context.lineEnd === selection.lineEnd,
          );
          const target = `${ref.environmentId}:${ref.threadId}`;
          if (duplicate) return { inserted: false, reason: "duplicate", target } as unknown as Json;
          const context: TerminalContextDraft = {
            id: randomUUID(),
            threadId: ThreadId.make(threadId),
            createdAt: new Date().toISOString(),
            ...selection,
          };
          store.addTerminalContext(ref, context);
          return { inserted: true, target } as unknown as Json;
        }
        case "getDraftState": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const draft = useComposerDraftStore.getState().getComposerDraft(ref);
          if (!draft) return { draft: null } as unknown as Json;
          const prompt = draft.prompt.slice(0, 10_000);
          return {
            draft: {
              prompt,
              promptTruncated: draft.prompt.length > prompt.length,
              contextCounts: {
                files: draft.files.length,
                images: draft.images.length + draft.persistedAttachments.length,
                terminalContexts: draft.terminalContexts.length,
                // Element picks are drafted as preview annotations; the SDK keeps the key.
                elementContexts: 0,
                previewAnnotations: draft.previewAnnotations.length,
                reviewComments: draft.reviewComments.length,
              },
            },
          } as unknown as Json;
        }
        case "attachAnnotation": {
          authorizeCaller(deps, call.caller, call.context, ["t3.messages/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const annotation = readInputObject(input.annotation ?? null);
          if (annotation.kind !== undefined && annotation.kind !== "diff")
            throw new ClientProviderOpError("provider-rejected", "Invalid annotation kind");
          const annotationId = `annotation:${call.caller.installationId}:${randomUUID()}`;
          const store = useComposerDraftStore.getState();
          if (annotation.kind === "diff") {
            // The record `buildDiffReviewComment` returns, rendered back inline
            // by AnnotatableCodeView through its `selection`.
            const annotationIndex = (value: unknown): number => {
              if (value === undefined) return 0;
              if (
                typeof value !== "number" ||
                !Number.isInteger(value) ||
                value < 0 ||
                value > 1_000_000
              )
                throw new ClientProviderOpError("provider-rejected", "Invalid annotation index");
              return value;
            };
            store.addReviewComment(ref, {
              id: annotationId,
              sectionId: readInputString(annotation, "sectionId")!,
              sectionTitle: readInputString(annotation, "sectionTitle")!,
              filePath: readInputString(annotation, "filePath")!,
              startIndex: annotationIndex(annotation.startIndex),
              endIndex: annotationIndex(annotation.endIndex),
              rangeLabel: readInputString(annotation, "rangeLabel")!,
              text: readInputString(annotation, "body")!.trim(),
              diff: readInputString(annotation, "diff")!,
              fenceLanguage: "diff",
              selection: readAnnotationSelection(annotation.selection),
            });
            return { annotationId } as unknown as Json;
          }
          const filePath = readInputString(annotation, "filePath")!;
          const startLine = typeof annotation.startLine === "number" ? annotation.startLine : 1;
          const endLine = typeof annotation.endLine === "number" ? annotation.endLine : startLine;
          const body = readInputString(annotation, "body")!;
          const excerpt = typeof annotation.excerpt === "string" ? annotation.excerpt : "";
          store.addReviewComment(
            ref,
            buildFileReviewComment({
              id: annotationId,
              filePath,
              startLine,
              endLine,
              text: body,
              contents: composerQuotedContents(excerpt, startLine, endLine),
            }),
          );
          return { annotationId } as unknown as Json;
        }
        case "listAnnotations": {
          authorizeCaller(deps, call.caller, call.context, ["t3.messages/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          // Own ids only: the prefix minted by attachAnnotation above. Native
          // comments and other installations' annotations stay unlisted.
          const prefix = `annotation:${call.caller.installationId}:`;
          const comments =
            useComposerDraftStore.getState().getComposerDraft(ref)?.reviewComments ?? [];
          const annotations = comments
            .filter((entry) => entry.id.startsWith(prefix))
            .slice(0, 8)
            .map((entry) => ({
              annotationId: entry.id,
              // File comments never carry a selection; diff ones always do.
              kind: entry.selection !== undefined ? "diff" : "file",
              filePath: entry.filePath,
              rangeLabel: entry.rangeLabel,
              sectionTitle: entry.sectionTitle,
            }));
          return { annotations } as unknown as Json;
        }
        case "removeAnnotation": {
          authorizeCaller(deps, call.caller, call.context, ["t3.messages/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const annotationId = readInputString(input, "annotationId")!;
          if (!annotationId.startsWith(`annotation:${call.caller.installationId}:`))
            throw new ClientProviderOpError(
              "client-target-denied",
              "Annotation belongs to another installation",
            );
          const store = useComposerDraftStore.getState();
          const present = (store.getComposerDraft(ref)?.reviewComments ?? []).some(
            (entry) => entry.id === annotationId,
          );
          // Also strips the inline reference from the prompt, like the native
          // removeReviewComment path. An already-gone own id is idempotent.
          if (present) store.removeReviewComment(ref, annotationId);
          return { removed: present } as unknown as Json;
        }
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown composer op ${call.method}`,
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Terminal appearance — a specialized read inside the theme area.

const rgb = (color: { readonly r: number; readonly g: number; readonly b: number }) =>
  `rgb(${color.r}, ${color.g}, ${color.b})`;

function terminalAppearanceSnapshot(): Json {
  const theme = terminalThemeFromApp(null);
  const settings = getClientSettings();
  const appearance = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return {
    theme: {
      background: rgb(theme.background),
      foreground: rgb(theme.foreground),
      cursor: rgb(theme.cursor),
      ...(theme.selectionBackground !== undefined
        ? { selectionBackground: theme.selectionBackground }
        : {}),
    },
    font: {
      ...(settings.fontFamilyTerminal ? { family: settings.fontFamilyTerminal } : {}),
      size: settings.fontSizeTerminal,
    },
    appearance,
  } as unknown as Json;
}

export function createTerminalAppearanceClientProvider(
  deps: ClientProviderDeps,
): ClientLocalProvider {
  const read = (call: ClientProviderInvokeCall | ClientProviderStreamCall) =>
    authorizeCaller(deps, call.caller, call.context, ["t3.ui/theme.read"]);
  return {
    invoke(call) {
      read(call);
      if (call.method !== "getAppearance")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown terminal appearance op ${call.method}`,
        );
      return terminalAppearanceSnapshot();
    },
    openStream(call) {
      read(call);
      if (call.name !== "watchAppearance")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown terminal appearance stream ${call.name}`,
        );
      call.emit({ type: "snapshot", value: terminalAppearanceSnapshot() });
      let last = JSON.stringify(terminalAppearanceSnapshot());
      const push = () => {
        const next = terminalAppearanceSnapshot();
        const encoded = JSON.stringify(next);
        if (encoded === last) return;
        last = encoded;
        call.emit({ type: "data", value: next });
      };
      const unsubs = [themeStore.subscribe(push), subscribeClientSettings(push)];
      const observer =
        typeof MutationObserver !== "undefined" && typeof document !== "undefined"
          ? new MutationObserver(push)
          : null;
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-id", "data-theme-preview-owner", "class"],
      });
      return () => {
        observer?.disconnect();
        for (const unsub of unsubs) unsub();
      };
    },
  };
}

// ---------------------------------------------------------------------------

/** All host-owned `t3.client/*` providers for one environment connection. */
export function createClientProviders(
  deps: ClientProviderDeps,
): ReadonlyMap<string, ClientLocalProvider> {
  return new Map<string, ClientLocalProvider>([
    ["t3.client/theme", createThemeClientProvider(deps)],
    ["t3.client/notifications", createNotificationsClientProvider(deps)],
    ["t3.client/keybindings", createKeybindingsClientProvider(deps)],
    ["t3.client/panels", createPanelsClientProvider(deps)],
    ["t3.client/composer", createComposerClientProvider(deps)],
    ["t3.client/terminal-appearance", createTerminalAppearanceClientProvider(deps)],
  ]);
}

export const CLIENT_PROVIDER_DESCRIPTORS = [
  { id: "t3.client/theme", version: "1.0.0" },
  { id: "t3.client/notifications", version: "1.0.0" },
  { id: "t3.client/keybindings", version: "1.0.0" },
  { id: "t3.client/panels", version: "1.0.0" },
  { id: "t3.client/composer", version: "1.1.0" },
  { id: "t3.client/terminal-appearance", version: "1.0.0" },
] as const;

export const CLIENT_PROVIDER_CLIENT_TAG = isElectron ? "desktop" : "web";
