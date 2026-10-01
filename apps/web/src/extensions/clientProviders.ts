import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  buildRemoteOpenUrl,
  EditorId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClientProviderEmitEvent } from "@t3tools/contracts";
import { BROWSER_CAPTURE_ARTIFACT_REF_PATTERN } from "@t3tools/extension-sdk/catalogue";
import { resourceKey } from "@t3tools/extension-sdk/contracts";
import { useBrowserSurfaceStore } from "../browser/browserSurfaceStore";
import { submitBrowserAnnotation } from "./browserAnnotationSubmission";
import {
  BROWSER_READ_HISTORY,
  BROWSER_RECORD_HISTORY,
  checkExternalUrl,
  fitBrowserHistoryList,
  isWorkspaceFilePath,
  UI_EDITOR_OPEN,
  UI_EXTERNAL_OPEN,
  UI_NAVIGATION_OPEN,
  UI_NAVIGATION_OPEN_SESSION,
  VCS_HANDOFF,
  VCS_MUTATE,
  type VcsActionHandoffResult,
  type UiExternalLinkReceipt,
  type UiNavigationFileReceipt,
  type UiNavigationFileRefusalReason,
  type UiNavigationReceipt,
  type UiNavigationSessionReceipt,
  type UiNavigationRefusalReason,
} from "@t3tools/extension-sdk/catalogue";
import {
  CLIENT_PROVIDER_APIS,
  CLIENT_PR_HANDOFF_MODES,
  CLIENT_PR_HANDOFF_TASKS,
  LISTED_ANNOTATION_TEXT_MAX,
} from "@t3tools/extension-sdk/clientProviders";
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
import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsUpdate,
  subscribeClientSettings,
} from "../hooks/useSettings";
import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "../hooks/useLocalStorage";
import {
  FILE_EXPLORER_STORAGE_KEY,
  RENDER_BROWSER_FILE_STORAGE_KEY,
} from "../components/files/filePreviewMode";
import { createElement } from "react";
import { toastManager, type ThreadToastData } from "../components/ui/toast";
import {
  beginPullRequestCheckoutToast,
  pullRequestCheckoutErrorDetail,
  showTaskAddedToComposerToast,
} from "../components/pullRequest/pullRequestHandoffToast";
import { Spinner } from "../components/ui/spinner";
import { terminalThemeFromApp } from "../components/ThreadTerminalDrawer";
import {
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
  normalizeRevealLine,
} from "../rightPanelStore";
import { openInstalledSurface } from "./installedSurfaceOpen";
import { readProject, readThreadShell } from "../state/entities";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type DraftId,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { buildResolveConflictsPrompt } from "../components/pullRequest/pullRequestDetail.logic";
import { writePullRequestTaskToComposer } from "../components/pullRequest/pullRequestHandoffDraft";
import { gitEnvironment } from "../state/git";
import {
  fetchBrowserCaptureArtifact,
  releaseBrowserCaptureArtifact,
} from "../browser/browserCaptureArtifacts";
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
import { readLocalApi } from "../localApi";
import { isBrowserPreviewFile, openWorkspaceFileInPreview } from "../browser/openFileInPreview";
import { filePresentationRequest, presentBeforeOpen } from "./SelectedApiPresentation";
import { rightPanelViewContext } from "./installedContext";
import { isPreviewSupportedInRuntime, readThreadPreviewState } from "../previewStateStore";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { readBrowserCaptureAnnotation } from "./browserCaptureAnnotations";
import { openTerminalLinkInPreview } from "../components/preview/openTerminalLinkInPreview";
import { previewEnvironment } from "../state/preview";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  openInPreferredEditor,
  persistPreferredEditor,
  resolvePreferredEditor,
  PreferredEditorUnavailableError,
} from "../editorPreferences";
import {
  getRemoteCapableEditors,
  markRemoteOpenHintSeen,
  openRemoteEditorUrl,
  remoteOpenStateFor,
  type RemoteOpenState,
} from "../remoteOpen";
import { environmentPresentations } from "../state/presentation";
import { resolvePathLinkTarget } from "../terminal-links";
import { splitFilePathPosition } from "@t3tools/client-runtime/markdown-links";
import { resolveEditorChoices } from "../editorLabels";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import {
  environmentHostnameFor,
  readThreadHistory,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
} from "../browserHistoryStore";

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

function subscribeThemeOverlay(listener: () => void): () => void {
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

interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly variant?: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly primary: boolean;
  readonly keepOpen: boolean;
}

interface OwnedNotification {
  readonly toastId: string;
  readonly owner: string;
  data: ThreadToastData;
  readonly actions: readonly NotificationAction[];
  /** Whether the notification carries an explicit `durationMs` lifetime. */
  readonly timed: boolean;
  /** Temporary labels from `flashAction`, keyed by action id. */
  readonly flashes: Map<string, { label: string; timeoutId: ReturnType<typeof setTimeout> }>;
}

/**
 * Base UI never times out a `type:"loading"` toast. A loading notification
 * with an explicit `durationMs` keeps the store's pausable timer by rendering
 * the native spinner through `leadingIcon` on an untyped toast instead.
 */
function notificationPresentation(severity: string, timed: boolean) {
  return severity === "loading" && timed
    ? { leadingIcon: createElement(Spinner, { className: "size-4 opacity-80" }) }
    : { type: severity, leadingIcon: undefined };
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
    for (const flash of entry.flashes.values()) clearTimeout(flash.timeoutId);
    deps.emit(notificationId, { type: "notificationOutcome", outcome });
  };
  /**
   * A `keepOpen` click reports without settling, so the toast and its other
   * actions stay usable (native "Copy path"); any other click settles and closes.
   * A trailing primary action becomes the toast's own action in native's
   * bottom row (`stackedThreadToast`), like native "Copy image".
   */
  const renderActions = (
    notificationId: string,
    actions: readonly NotificationAction[],
    flashes: OwnedNotification["flashes"],
    toastId: () => string,
  ) => {
    const button = (action: NotificationAction) => {
      const flash = flashes.get(action.id);
      return {
        children: flash?.label ?? action.label,
        disabled: flash !== undefined,
        onClick: () => {
          if (action.keepOpen) {
            if (owned.has(notificationId))
              deps.emit(notificationId, { type: "notificationAction", actionId: action.id });
            return;
          }
          settle(notificationId, { actionId: action.id });
          toastManager.close(toastId());
        },
      };
    };
    const main = actions.at(-1)?.primary ? actions.at(-1) : undefined;
    const rest = main ? actions.slice(0, -1) : actions;
    return {
      ...(main ? { actionProps: button(main) } : {}),
      data: {
        ...(main ? { actionLayout: "stacked-end" as const } : {}),
        additionalActions: rest.map((action) => ({
          id: action.id,
          ...(action.variant !== undefined ? { variant: action.variant } : {}),
          props: button(action),
        })),
      },
    };
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
          const ownedActions = actions.slice(0, 3).map((action): NotificationAction => {
            const record = readInputObject(action);
            const variant = readInputString(record, "variant", false);
            return {
              id: readInputString(record, "id")!,
              label: readInputString(record, "label")!,
              ...(variant !== undefined && variant in variantMap
                ? { variant: variantMap[variant as keyof typeof variantMap] }
                : {}),
              primary: variant === "primary",
              keepOpen: record.keepOpen === true,
            };
          });
          const timeout = typeof notification.durationMs === "number" ? notification.durationMs : 0;
          const { leadingIcon, ...presentation } = notificationPresentation(severity, timeout > 0);
          const flashes: OwnedNotification["flashes"] = new Map();
          const rendered =
            ownedActions.length > 0
              ? renderActions(notificationId, ownedActions, flashes, () => toastId)
              : null;
          const toastData: ThreadToastData = {
            ...(threadRef !== undefined ? { threadRef } : {}),
            dismissible,
            ...(leadingIcon ? { leadingIcon } : {}),
            onClose: () => settle(notificationId, { dismissed: true }),
            ...rendered?.data,
          };
          const toastId: string = toastManager.add({
            ...presentation,
            title,
            ...(typeof body === "string" ? { description: body } : {}),
            ...(rendered?.actionProps ? { actionProps: rendered.actionProps } : {}),
            // The manager owns the lifetime, so hovering pauses it like any
            // native toast. Its 5 s default never applies (`0` keeps a toast
            // without `durationMs` open), and the top-level `onClose` settles
            // the outcome on every close path — timeout, closeAll, swipe,
            // programmatic — not just the X button, which reaches `data.onClose`.
            timeout,
            onClose: () => settle(notificationId, { dismissed: true }),
            data: toastData,
          });
          owned.set(notificationId, {
            toastId,
            owner: call.caller.installationId,
            data: toastData,
            actions: ownedActions,
            timed: timeout > 0,
            flashes,
          });
          return { applied: true } as unknown as Json;
        }
        case "update": {
          const notificationId = readInputString(input, "notificationId")!;
          const entry = ownedEntry(call, notificationId);
          const patch = readInputObject(input.patch ?? null);
          const patchRecord: Record<string, unknown> = {};
          if (typeof patch.severity === "string") {
            const { type, leadingIcon } = notificationPresentation(patch.severity, entry.timed);
            patchRecord.type = type;
            entry.data = { ...entry.data, leadingIcon };
            patchRecord.data = entry.data;
          }
          if (typeof patch.title === "string") patchRecord.title = patch.title;
          if (typeof patch.body === "string") patchRecord.description = patch.body;
          if (typeof patch.dismissible === "boolean") {
            // `data` replaces wholesale on update — merge onto the stored copy.
            entry.data = { ...entry.data, dismissible: patch.dismissible };
            patchRecord.data = entry.data;
          }
          const flash = patch.flashAction === undefined ? null : readInputObject(patch.flashAction);
          if (flash !== null) {
            const actionId = readInputString(flash, "actionId")!;
            if (!entry.actions.some((action) => action.id === actionId))
              throw new ClientProviderOpError("provider-rejected", "Unknown notification action");
            const rerender = () => {
              const { actionProps, data } = renderActions(
                notificationId,
                entry.actions,
                entry.flashes,
                () => entry.toastId,
              );
              entry.data = { ...entry.data, ...data };
              return { ...(actionProps ? { actionProps } : {}), data: entry.data };
            };
            const previous = entry.flashes.get(actionId);
            if (previous) clearTimeout(previous.timeoutId);
            const durationMs = typeof flash.durationMs === "number" ? flash.durationMs : 0;
            entry.flashes.set(actionId, {
              label: readInputString(flash, "label")!,
              timeoutId: setTimeout(() => {
                entry.flashes.delete(actionId);
                if (owned.get(notificationId) === entry)
                  toastManager.update(entry.toastId, rerender());
              }, durationMs),
            });
            Object.assign(patchRecord, rerender());
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

export function createPanelsClientProvider(
  deps: ClientProviderDeps,
  readPreview: (ref: ScopedThreadRef) => {
    readonly serverEpoch: string | null;
    readonly sessions: Readonly<Record<string, unknown>>;
  } = readThreadPreviewState,
  miniPlayerSupported: () => boolean = isPreviewSupportedInRuntime,
): ClientLocalProvider {
  return {
    invoke(call) {
      if (call.method === "getCapabilities") {
        authorizeCaller(deps, call.caller, call.context, []);
        return { browserMiniPlayer: miniPlayerSupported() };
      }
      authorizeCaller(deps, call.caller, call.context, ["t3.ui/panels"]);
      const input = readInputObject(call.input);
      const threadId = readInputString(input, "threadId");
      if (!threadId) throw new ClientProviderOpError("provider-rejected", "Missing threadId");
      const ref = scopeThreadRef(deps.environmentId, ThreadId.make(threadId));
      const store = useRightPanelStore.getState();
      switch (call.method) {
        case "getBrowserMiniPlayer":
        case "setBrowserMiniPlayer": {
          composerThread(call, threadId);
          if (!miniPlayerSupported())
            throw new ClientProviderOpError(
              "provider-rejected",
              "Floating browser previews require the desktop client",
            );
          const miniPlayer = usePreviewMiniPlayerStore.getState();
          if (call.method === "setBrowserMiniPlayer") {
            authorizeCaller(deps, call.caller, call.context, ["t3.browser/sessions"]);
            const tabId = readInputString(input, "tabId")!;
            const serverEpoch = readInputString(input, "serverEpoch")!;
            if (typeof input.open !== "boolean" || tabId.length > 128 || serverEpoch.length > 128)
              throw new ClientProviderOpError("provider-rejected", "Invalid mini-player request");
            const preview = readPreview(ref);
            if (preview.serverEpoch !== serverEpoch)
              throw new ClientProviderOpError(
                "provider-rejected",
                "The browser session epoch changed",
              );
            const key = resourceKey(call.context.resource);
            const held = useBrowserSurfaceStore.getState().extensionTargetsByResourceKey[key];
            if (
              !held ||
              held.installationId !== call.caller.installationId ||
              held.tabId !== tabId ||
              held.serverEpoch !== serverEpoch
            )
              throw new ClientProviderOpError(
                "client-target-denied",
                "This installation does not hold this browser session",
              );
            if (input.open) {
              if (!Object.hasOwn(preview.sessions, tabId))
                throw new ClientProviderOpError(
                  "provider-rejected",
                  "The browser session is not in this thread",
                );
              const panel = selectThreadRightPanelState(store.byThreadKey, ref);
              const surface = panel.surfaces.find(
                (item) =>
                  item.kind === "extension" &&
                  item.record.surfaceId.startsWith(`${call.caller.installationId}/`) &&
                  resourceKey(item.record.context.resource) === key,
              );
              miniPlayer.open(ref, browserMiniPlayerSource(tabId, surface?.id));
              if (surface && panel.activeSurfaceId === surface.id) store.close(ref);
            } else if (selectThreadPreviewMiniPlayerTabId(miniPlayer.byThreadKey, ref) === tabId) {
              miniPlayer.close(ref);
            }
          }
          return {
            tabId: selectThreadPreviewMiniPlayerTabId(
              usePreviewMiniPlayerStore.getState().byThreadKey,
              ref,
            ),
          } as Json;
        }
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
          if (
            !openInstalledSurface(deps, ref, call.caller.installationId, surface, placement, {
              projectId: shell.projectId,
              workspaceRoot: project.workspaceRoot,
              worktreePath: shell.worktreePath ?? null,
            })
          )
            throw new ClientProviderOpError("panel-surface-not-found", "Surface could not open");
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

/** `text` trimmed, and cut with "…" to at most `max` units past it. */
function boundedAnnotationText(text: string, max: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  let cut = trimmed.slice(0, max - 1);
  // Never leave half a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${cut}…`, truncated: true };
}

/** A review comment's text as `listAnnotations` lists it: a marked preview when cut. */
function listedAnnotationText(text: string): { text: string; textTruncated?: true } {
  const listed = boundedAnnotationText(text, LISTED_ANNOTATION_TEXT_MAX);
  return listed.truncated ? { text: listed.text, textTruncated: true } : { text: listed.text };
}

/** Bound on `getAnnotation`'s text: the longest body `attachAnnotation` takes. */
const ANNOTATION_TEXT_MAX = 4096;

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

const CAPTURE_ARTIFACT_REF = new RegExp(BROWSER_CAPTURE_ARTIFACT_REF_PATTERN);

/** Reads a capture artifact as a PNG File; the test seam for insertImage. */
export type FetchCaptureArtifact = (
  environmentId: EnvironmentId,
  artifactRef: string,
  name: string,
) => Promise<File>;

/** Deletes a capture artifact's pending upload; the test seam for insertImage. */
export type ReleaseCaptureArtifact = (environmentId: EnvironmentId, artifactRef: string) => void;

export function createComposerClientProvider(
  deps: ClientProviderDeps,
  fetchCaptureArtifact: FetchCaptureArtifact = fetchBrowserCaptureArtifact,
  releaseCaptureArtifact: ReleaseCaptureArtifact = releaseBrowserCaptureArtifact,
  readAnnotation: typeof readBrowserCaptureAnnotation = readBrowserCaptureAnnotation,
  submitAnnotation: typeof submitBrowserAnnotation = submitBrowserAnnotation,
): ClientLocalProvider {
  return {
    invoke(call) {
      const input = readInputObject(call.input);
      switch (call.method) {
        case "insertPreviewAnnotation": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const annotationRef = readInputString(input, "annotationRef")!;
          const capture = readAnnotation(
            ref.environmentId,
            ref.threadId,
            call.caller.installationId,
            annotationRef,
          );
          if (!capture)
            throw new ClientProviderOpError(
              "provider-rejected",
              "The captured annotation is no longer available to this installation and thread",
            );
          const store = useComposerDraftStore.getState();
          let imageInserted = false;
          let attachedImage: ComposerImageAttachment | null = null;
          if (capture.file && capture.annotation.screenshot) {
            const image: ComposerImageAttachment = {
              type: "image",
              id: capture.annotation.id,
              name: capture.file.name,
              mimeType: "image/png",
              sizeBytes: capture.file.size,
              previewUrl: URL.createObjectURL(capture.file),
              file: capture.file,
            };
            imageInserted = store.addImage(ref, image);
            if (imageInserted) attachedImage = image;
            if (!imageInserted) URL.revokeObjectURL(image.previewUrl);
          }
          store.addPreviewAnnotation(
            ref,
            imageInserted ? capture.annotation : { ...capture.annotation, screenshot: null },
          );
          if (capture.artifactRef) releaseCaptureArtifact(ref.environmentId, capture.artifactRef);
          capture.consume();
          if (capture.submission === "send")
            submitAnnotation(
              ref,
              imageInserted ? capture.annotation : { ...capture.annotation, screenshot: null },
              attachedImage,
            );
          return {
            inserted: true,
            imageInserted,
            screenshotFailed: capture.screenshotFailed || (capture.file !== null && !imageInserted),
            target: `${ref.environmentId}:${ref.threadId}`,
          } as Json;
        }
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
        case "insertImage": {
          authorizeCaller(deps, call.caller, call.context, ["t3.composer/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const artifactRef = readInputString(input, "artifactRef")!;
          if (!CAPTURE_ARTIFACT_REF.test(artifactRef))
            throw new ClientProviderOpError("provider-rejected", "Invalid artifactRef");
          const name =
            typeof input.name === "string" && input.name.length > 0 && input.name.length <= 128
              ? input.name
              : `browser-capture-${artifactRef.slice("pending-".length, "pending-".length + 8)}.png`;
          return fetchCaptureArtifact(ref.environmentId, artifactRef, name).then(
            (file) => {
              const image: ComposerImageAttachment = {
                type: "image",
                id: randomUUID(),
                name,
                mimeType: "image/png",
                sizeBytes: file.size,
                previewUrl: URL.createObjectURL(file),
                file,
              };
              const inserted = useComposerDraftStore.getState().addImage(ref, image);
              // Once accepted, the draft owns its own upload of these bytes, like
              // a pasted image, so the capture's pending upload would be an
              // orphan. A refused insert (full composer, duplicate) keeps the
              // ref so the caller can retry after making room.
              if (inserted) releaseCaptureArtifact(ref.environmentId, artifactRef);
              else URL.revokeObjectURL(image.previewUrl);
              return {
                inserted,
                target: `${ref.environmentId}:${ref.threadId}`,
              } as unknown as Json;
            },
            (error: unknown) => {
              throw new ClientProviderOpError(
                "provider-rejected",
                error instanceof Error ? error.message : "The capture could not be read",
              );
            },
          );
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
          const include = readInputObject(input).include;
          const withText = Array.isArray(include) && include.includes("text");
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
              // The words the composer chip shows, cut to fit the frame.
              ...(withText ? listedAnnotationText(entry.text) : {}),
            }));
          return { annotations } as unknown as Json;
        }
        case "getAnnotation": {
          // One own comment's whole text: what a listing's preview cut off.
          authorizeCaller(deps, call.caller, call.context, ["t3.messages/write"]);
          const threadId = readInputString(input, "threadId")!;
          const ref = composerThread(call, threadId);
          const annotationId = readInputString(input, "annotationId")!;
          if (!annotationId.startsWith(`annotation:${call.caller.installationId}:`))
            throw new ClientProviderOpError(
              "client-target-denied",
              "Annotation belongs to another installation",
            );
          const entry = (
            useComposerDraftStore.getState().getComposerDraft(ref)?.reviewComments ?? []
          ).find((comment) => comment.id === annotationId);
          return (entry === undefined
            ? { found: false }
            : {
                found: true,
                text: boundedAnnotationText(entry.text, ANNOTATION_TEXT_MAX).text,
              }) as unknown as Json;
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

function readAdvancedTypography(): boolean {
  try {
    return getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean) ?? false;
  } catch {
    return false;
  }
}

function terminalAppearanceSnapshot(): Json {
  const theme = terminalThemeFromApp(null);
  const settings = getClientSettings();
  // Same resolution as the native drawer: simple typography uses the code font.
  const advanced = readAdvancedTypography();
  const family = resolveTerminalFontPreference({
    advanced,
    code: settings.fontFamilyCode,
    terminal: settings.fontFamilyTerminal,
  });
  const size = resolveTerminalFontSizePreference({
    advanced,
    code: settings.fontSizeCode,
    terminal: settings.fontSizeTerminal,
  });
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
      ...(family ? { family } : {}),
      size,
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
      const unsubs = [
        themeStore.subscribe(push),
        subscribeClientSettings(push),
        subscribeLocalStorageKey(TYPOGRAPHY_ADVANCED_STORAGE_KEY, push),
      ];
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
// Preferences — a named subset of the persisted client settings.

/** A native file preview choice stored under `key`; `fallback` when never chosen. */
function storedChoice(key: string, fallback: boolean): boolean {
  try {
    return getLocalStorageItem(key, Schema.Boolean) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The keys a server may ask for, each stored where the native file preview keeps it. */
const STORED_PREFERENCES = [
  { name: "renderBrowserFile", key: RENDER_BROWSER_FILE_STORAGE_KEY },
  { name: "fileExplorerOpen", key: FILE_EXPLORER_STORAGE_KEY },
] as const;
type StoredPreference = (typeof STORED_PREFERENCES)[number]["name"];

/**
 * The preferences this client holds. `renderBrowserFile` (1.1.0) and
 * `fileExplorerOpen` (1.2.0) go only to a server that asked for them: an older
 * server rejects an unknown key, which would break word wrap too. Both default
 * to true when never chosen, as in the native file preview.
 */
function preferencesSnapshot(asked: ReadonlySet<StoredPreference>): Json {
  const { wordWrap } = getClientSettings();
  const snapshot: Record<string, boolean> = { wordWrap };
  for (const { name, key } of STORED_PREFERENCES)
    if (asked.has(name)) snapshot[name] = storedChoice(key, true);
  return snapshot;
}

/** The later keys the server's call asked for. */
function askedPreferences(input: Json): ReadonlySet<StoredPreference> {
  const include = readInputObject(input ?? {}).include;
  return new Set(
    STORED_PREFERENCES.map(({ name }) => name).filter(
      (name) => Array.isArray(include) && include.includes(name),
    ),
  );
}

/**
 * Reads wait for hydration: the pre-hydration snapshot is schema defaults,
 * and a pack must not render (or persist over) a value the user never chose.
 */
async function hydratedPreferences(asked: ReadonlySet<StoredPreference>): Promise<Json> {
  try {
    await ensureClientSettingsHydrated();
  } catch {
    throw new ClientProviderOpError("client-provider-unavailable", "Client settings did not load");
  }
  return preferencesSnapshot(asked);
}

export function createPreferencesClientProvider(deps: ClientProviderDeps): ClientLocalProvider {
  const read = (call: ClientProviderInvokeCall | ClientProviderStreamCall) =>
    authorizeCaller(deps, call.caller, call.context, ["t3.ui/preferences.read"]);
  const write = (call: ClientProviderInvokeCall) =>
    authorizeCaller(deps, call.caller, call.context, ["t3.ui/preferences.write"]);
  return {
    async invoke(call) {
      switch (call.method) {
        case "getPreferences":
          read(call);
          return hydratedPreferences(askedPreferences(call.input));
        case "applyPreferences": {
          write(call);
          const input = readInputObject(call.input);
          const asked = askedPreferences(call.input);
          if (readInputString(input, "writer") !== call.caller.installationId)
            throw new ClientProviderOpError(
              "client-target-denied",
              "Writer must be the calling installation",
            );
          const patch = readInputObject(input.patch ?? null);
          const { wordWrap } = patch;
          if (wordWrap !== undefined && typeof wordWrap !== "boolean")
            throw new ClientProviderOpError("provider-rejected", "Invalid wordWrap");
          const stored = STORED_PREFERENCES.filter(({ name }) => patch[name] !== undefined);
          for (const { name } of stored)
            if (typeof patch[name] !== "boolean")
              throw new ClientProviderOpError("provider-rejected", `Invalid ${name}`);
          if (wordWrap === undefined && stored.length === 0)
            return {
              applied: false,
              reason: "empty-patch",
              preferences: await hydratedPreferences(asked),
            } as unknown as Json;
          // Persist-then-publish: the receipt reports only what storage holds,
          // and the watch stream sees each change through its own store.
          try {
            await ensureClientSettingsHydrated();
            if (wordWrap !== undefined)
              await persistClientSettingsUpdate((current) => ({ ...current, wordWrap }));
            for (const { name, key } of stored) {
              setLocalStorageItem(key, patch[name] as boolean, Schema.Boolean);
              dispatchLocalStorageChange(key);
            }
            return { applied: true, preferences: preferencesSnapshot(asked) } as unknown as Json;
          } catch {
            // Hydrated like every read: a failure caused by hydration itself
            // must not report schema defaults as the stored value.
            return {
              applied: false,
              reason: "persist-failed",
              preferences: await hydratedPreferences(asked),
            } as unknown as Json;
          }
        }
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown preferences op ${call.method}`,
          );
      }
    },
    async openStream(call) {
      read(call);
      if (call.name !== "watchPreferences")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown preferences stream ${call.name}`,
        );
      const asked = askedPreferences(call.input);
      const snapshot = await hydratedPreferences(asked);
      call.emit({ type: "snapshot", value: snapshot });
      let last = JSON.stringify(snapshot);
      const push = () => {
        const next = preferencesSnapshot(asked);
        const encoded = JSON.stringify(next);
        if (encoded === last) return;
        last = encoded;
        call.emit({ type: "data", value: next });
      };
      const unsubs = [
        subscribeClientSettings(push),
        ...STORED_PREFERENCES.map(({ key }) => subscribeLocalStorageKey(key, push)),
      ];
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
  };
}

// External open — the same opener as the native "Open in system browser".

export interface ExternalOpener {
  readonly kind: "desktop-shell" | "browser-window";
  /** Rejects when the OS opener declines the URL. */
  open(url: string): Promise<void>;
}

/**
 * Desktop hands the URL to Electron's shell (which re-checks its own
 * allowlist); web opens a severed browser window. Both reject when nothing
 * opened (a declined URL, a blocked popup). Undefined outside a window.
 */
function localExternalOpener(): ExternalOpener | undefined {
  const api = readLocalApi();
  if (!api) return undefined;
  return {
    kind: window.desktopBridge ? "desktop-shell" : "browser-window",
    open: (url) => api.shell.openExternal(url),
  };
}

/**
 * Opens a link where the "Open links in" setting says, calling
 * `fallbackToBrowser` when it belongs in the system browser; injected so tests
 * need no preview runtime. The default is the native terminal drawer's own.
 */
export type LinkRouter = (input: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly forceBrowser: boolean;
  readonly fallbackToBrowser: () => void;
}) => Promise<void>;

const nativeLinkRouter: LinkRouter = (input) =>
  openTerminalLinkInPreview({
    ...input,
    openPreview: (value) =>
      runAtomCommand(appAtomRegistry, previewEnvironment.open, value, { reportFailure: false }),
  });

export function createExternalClientProvider(
  deps: ClientProviderAuthDeps,
  opener: () => ExternalOpener | undefined = localExternalOpener,
  routeLink: LinkRouter = nativeLinkRouter,
): ClientLocalProvider {
  return {
    async invoke(call): Promise<UiExternalLinkReceipt> {
      const installation = authorizeCaller(deps, call.caller, call.context, [UI_EXTERNAL_OPEN]);
      if (call.method !== "open" && call.method !== "openLink")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown external op ${call.method}`,
        );
      // The server adapter already checked; the client owns the final say.
      const input = readInputObject(call.input);
      const checked = checkExternalUrl(readInputString(input, "url")!);
      if (!checked.ok) return { status: "refused", reason: checked.reason };
      const openSystem = async (): Promise<UiExternalLinkReceipt> => {
        const target = opener();
        if (!target) return { status: "refused", reason: "opener-refused" };
        try {
          await target.open(checked.url);
        } catch {
          return { status: "refused", reason: "opener-refused" };
        }
        return { status: "opened", url: checked.url, opener: target.kind };
      };
      // `openLink` lands like a native terminal link: the setting may send it
      // to the preview browser of the caller's own thread, when that thread
      // is in a granted project; anything else goes to the OS opener.
      const threadId = call.context.resource.threadId;
      const ref = threadId
        ? scopeThreadRef(EnvironmentId.make(deps.environmentId), ThreadId.make(threadId))
        : null;
      const projectId = ref ? readThreadShell(ref)?.projectId : undefined;
      if (
        call.method === "open" ||
        !ref ||
        !projectId ||
        !installation.grants.projectIds.some((id) => id === projectId)
      )
        return openSystem();
      let system: Promise<UiExternalLinkReceipt> | null = null;
      await routeLink({
        url: checked.url,
        threadRef: ref,
        forceBrowser: input.forceSystem === true,
        fallbackToBrowser: () => {
          system = openSystem();
        },
      });
      return system ?? { status: "opened", url: checked.url, opener: "in-app-browser" };
    },
  };
}

// ---------------------------------------------------------------------------
// Editor — native local launches or client-local SSH editor deep links.

/** The environment seams `t3.client/editor` launches through; tests fake them. */
export interface EditorLauncher {
  availableEditors(environmentId: EnvironmentId): readonly EditorId[];
  remoteState(environmentId: EnvironmentId): RemoteOpenState;
  remoteEditors(): Promise<readonly EditorId[]>;
  isPrimaryEnvironment?(environmentId: EnvironmentId): boolean;
  environmentLabel?(environmentId: EnvironmentId): string;
  openRemoteUrl(url: string): Promise<boolean>;
  openInEditor(value: {
    environmentId: EnvironmentId;
    input: { cwd: string; editor: EditorId };
  }): Promise<AtomCommandResult<unknown, unknown>>;
}

const environmentEditorLauncher: EditorLauncher = {
  availableEditors: (environmentId) =>
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.availableEditors ?? [],
  remoteState: (environmentId) => {
    const presentation = appAtomRegistry.get(
      environmentPresentations.presentationAtom(environmentId),
    );
    return remoteOpenStateFor(presentation ?? null);
  },
  isPrimaryEnvironment: (environmentId) =>
    appAtomRegistry.get(primaryEnvironmentIdAtom) === environmentId,
  environmentLabel: (environmentId) =>
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.entry.target
      .label ?? "this machine",
  remoteEditors: getRemoteCapableEditors,
  openRemoteUrl: openRemoteEditorUrl,
  openInEditor: (value) =>
    runAtomCommand(appAtomRegistry, shellEnvironment.openInEditor, value, {
      reportFailure: false,
    }),
};

const isEditorId = Schema.is(EditorId);

export function createEditorClientProvider(
  deps: ClientProviderDeps,
  launcher: EditorLauncher = environmentEditorLauncher,
): ClientLocalProvider {
  let preparedRemoteEditors: readonly EditorId[] | null = null;
  return {
    async invoke(call) {
      const installation = authorizeCaller(
        deps,
        call.caller,
        call.context,
        call.method === "getCapabilities" ? [] : [UI_EDITOR_OPEN],
      );
      if (call.method === "getCapabilities") {
        const remote = launcher.remoteState(deps.environmentId);
        const visible =
          (launcher.isPrimaryEnvironment?.(deps.environmentId) ?? true) ||
          remote.mode !== "local-exec";
        const available =
          remote.mode === "local-exec"
            ? launcher.availableEditors(deps.environmentId)
            : (preparedRemoteEditors = await launcher.remoteEditors());
        const allowed = installation.grants.capabilities.includes(UI_EDITOR_OPEN);
        return {
          adapter: "host.ui.editor",
          operations: {
            openPath:
              allowed && visible && remote.mode !== "remote-unavailable" && available.length > 0,
          },
          clients: [],
          editor: {
            visible: allowed && visible,
            editors: resolveEditorChoices(
              typeof navigator === "undefined" ? "" : navigator.platform,
              available,
            ),
            preferredEditor: resolvePreferredEditor(available),
            remoteHint:
              remote.mode === "remote-links" &&
              getLocalStorageItem("t3code:remote-open-hint-seen", Schema.Boolean) !== true
                ? `Opens over SSH. Needs your key on ${launcher.environmentLabel?.(deps.environmentId) ?? "this machine"}.`
                : null,
          },
        };
      }
      if (call.method !== "openPath")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown editor op ${call.method}`,
        );
      const input = readInputObject(call.input);
      if (input.workspace === true && input.cwd !== undefined)
        throw new ClientProviderOpError(
          "provider-rejected",
          "Workspace opens cannot also supply cwd.",
        );
      let cwd: string;
      if (input.workspace === true) {
        const projectId = call.context.resource.projectId;
        const threadId = call.context.resource.threadId;
        const thread = threadId
          ? readThreadShell(scopeThreadRef(deps.environmentId, ThreadId.make(threadId)))
          : null;
        if (
          !projectId ||
          !installation.grants.projectIds.some((id) => id === projectId) ||
          (threadId && thread?.projectId !== projectId)
        )
          throw new ClientProviderOpError(
            "client-target-denied",
            "Workspace is outside the caller's project scope.",
          );
        const project = readProject(scopeProjectRef(deps.environmentId, ProjectId.make(projectId)));
        const root = thread?.worktreePath ?? project?.workspaceRoot;
        if (!root)
          return {
            status: "refused",
            reason: "open-failed",
            message: "The workspace checkout is unavailable.",
          };
        cwd = root;
      } else {
        cwd = readInputString(input, "cwd")!;
      }
      // The native terminal's resolution: `~/` and relative links join the
      // cwd, and a `:line:column` suffix rides through to the editor.
      const targetPath = resolvePathLinkTarget(readInputString(input, "path")!, cwd);
      const remote =
        input.workspace === true
          ? launcher.remoteState(deps.environmentId)
          : { mode: "local-exec" as const };
      if (
        input.workspace === true &&
        remote.mode === "local-exec" &&
        launcher.isPrimaryEnvironment?.(deps.environmentId) === false
      )
        return {
          status: "refused",
          reason: "open-failed",
          message: "This environment does not offer an editor picker.",
        };
      const available =
        remote.mode === "local-exec"
          ? launcher.availableEditors(deps.environmentId)
          : (preparedRemoteEditors ?? (preparedRemoteEditors = await launcher.remoteEditors()));
      const requestedEditor = input.editor;
      if (
        requestedEditor !== undefined &&
        (!isEditorId(requestedEditor) || !available.includes(requestedEditor))
      )
        throw new ClientProviderOpError("provider-rejected", "The selected editor is unavailable.");
      const chosenEditor = requestedEditor as EditorId | undefined;
      if (remote.mode === "remote-unavailable")
        return {
          status: "refused",
          reason: "open-failed",
          message: "This remote environment has no SSH host for opening an editor.",
        };
      if (remote.mode === "remote-links") {
        const editor = chosenEditor ?? resolvePreferredEditor(available);
        if (!editor)
          return {
            status: "refused",
            reason: "no-editor",
            message: "No remote-capable editor is available on this client.",
          };
        const url = buildRemoteOpenUrl({
          editor,
          host: remote.host.host,
          absolutePath: splitFilePathPosition(targetPath).path,
        });
        try {
          if (url !== undefined && (await launcher.openRemoteUrl(url))) {
            persistPreferredEditor(editor);
            if (input.hintShown === true) markRemoteOpenHintSeen();
            return { status: "opened", path: targetPath, editor, url };
          }
        } catch {
          return {
            status: "refused",
            reason: "open-failed",
            message: "Remote editor URL was refused.",
          };
        }
        return {
          status: "refused",
          reason: "open-failed",
          message: "Remote editor URL was refused.",
        };
      }
      const result = await openInPreferredEditor(
        deps.environmentId,
        chosenEditor ? [chosenEditor] : available,
        targetPath,
        launcher.openInEditor,
      );
      if (result._tag === "Success")
        return { status: "opened", path: targetPath, editor: result.value };
      const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
      return {
        status: "refused",
        reason: Schema.is(PreferredEditorUnavailableError)(error) ? "no-editor" : "open-failed",
        message: (error instanceof Error ? error.message : "Unable to open path").slice(0, 1024),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Browser history — the native per-project store behind the preview's recents.

/**
 * `t3.browser/history` reads and writes the same store the native preview
 * uses, through the same thread-scoped entry points, so project keying,
 * pending buffering before the thread's project registers, loopback folding,
 * and the 50-entry cap are the native behavior rather than a copy of it.
 */
export function createBrowserHistoryClientProvider(
  deps: ClientProviderAuthDeps,
): ClientLocalProvider {
  return {
    invoke(call) {
      const read = call.method === "list";
      if (!read && !["record", "setTitle", "remove"].includes(call.method))
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown browser history op ${call.method}`,
        );
      // Writes answer with the whole list, so they need the read grant too.
      const installation = authorizeCaller(
        deps,
        call.caller,
        call.context,
        read ? [BROWSER_READ_HISTORY] : [BROWSER_READ_HISTORY, BROWSER_RECORD_HISTORY],
      );
      const threadId = call.context.resource.threadId;
      if (!threadId)
        throw new ClientProviderOpError(
          "client-target-denied",
          "Browser history requires a thread-scoped context",
        );
      const ref = scopeThreadRef(EnvironmentId.make(deps.environmentId), ThreadId.make(threadId));
      const shell = readThreadShell(ref);
      if (!shell?.projectId) throw new ClientProviderOpError("provider-rejected", "Unknown thread");
      if (!installation.grants.projectIds.some((id) => id === shell.projectId))
        throw new ClientProviderOpError("client-target-denied", "Thread outside granted scope");
      const input = readInputObject(call.input);
      if (call.method === "record") recordVisitForThread(ref, readInputString(input, "url")!);
      else if (call.method === "setTitle")
        setTitleForThreadUrl(
          ref,
          readInputString(input, "url")!,
          readInputString(input, "title")!,
          environmentHostnameFor(ref),
        );
      else if (call.method === "remove") removeUrlForThread(ref, readInputString(input, "url")!);
      // A full list of long URLs outgrows the envelope; answer with what fits.
      return fitBrowserHistoryList(readThreadHistory(ref));
    },
  };
}

// Navigation — route the caller's own client to a thread in its project.

/** Moves the app to a thread; injected so the provider never owns a router. */
export type ThreadNavigator = (ref: ScopedThreadRef) => Promise<void>;

const refused = (reason: UiNavigationRefusalReason): UiNavigationReceipt => ({
  status: "refused",
  reason,
});

const refusedFile = (reason: UiNavigationFileRefusalReason): UiNavigationFileReceipt => ({
  status: "refused",
  reason,
});

/** Opens a workspace file in the thread's preview browser; injected like the navigator. */
export type FilePreviewOpener = (
  ref: ScopedThreadRef,
  filePath: string,
  workspaceRoot: string,
) => Promise<"opened" | "browser-unavailable" | "open-failed">;

export function createNavigationClientProvider(
  deps: ClientProviderDeps,
  navigate: ThreadNavigator,
  opener: () => ExternalOpener | undefined = localExternalOpener,
  previewFile: FilePreviewOpener = openWorkspaceFileInPreview,
  previewSupported: () => boolean = isPreviewSupportedInRuntime,
): ClientLocalProvider {
  return {
    async invoke(
      call,
    ): Promise<
      | UiNavigationReceipt
      | UiNavigationSessionReceipt
      | UiNavigationFileReceipt
      | { readonly openFileInBrowser: boolean }
    > {
      // Native shows "Open file in preview browser" only where this client
      // has one; asking needs no grant, as the public getCapabilities does not.
      if (call.method === "getCapabilities") return { openFileInBrowser: previewSupported() };
      if (call.method === "openSession") {
        authorizeCaller(deps, call.caller, call.context, [UI_NAVIGATION_OPEN_SESSION]);
        // The adapter resolved this URL from the caller's own thread roster;
        // the client still refuses anything its external opener would.
        const input = readInputObject(call.input);
        const agentId = readInputString(input, "agentId")!;
        const checked = checkExternalUrl(readInputString(input, "url")!);
        if (!checked.ok) return { status: "refused", reason: "no-session" };
        const target = opener();
        if (!target) return { status: "refused", reason: "opener-refused" };
        try {
          await target.open(checked.url);
        } catch {
          return { status: "refused", reason: "opener-refused" };
        }
        return { status: "opened", agentId, opener: target.kind };
      }
      const installation = authorizeCaller(deps, call.caller, call.context, [UI_NAVIGATION_OPEN]);
      if (call.method === "openFile") {
        const input = readInputObject(call.input);
        const relativePath = readInputString(input, "relativePath")!;
        const line = typeof input.line === "number" ? input.line : undefined;
        if (!isWorkspaceFilePath(relativePath))
          return { status: "refused", reason: "invalid-path" } as UiNavigationFileReceipt;
        const threadId = call.context.resource.threadId;
        const ref = threadId ? scopeThreadRef(deps.environmentId, ThreadId.make(threadId)) : null;
        const shell = ref ? readThreadShell(ref) : null;
        if (!ref || !shell?.projectId) return refused("unknown-thread");
        if (
          shell.projectId !== call.context.resource.projectId ||
          !installation.grants.projectIds.some((id) => id === shell.projectId)
        )
          return refused("out-of-scope");
        if (input.openIn === "browser") {
          // Native's "Open file in preview browser": pages and PDFs only,
          // resolved against the thread's own checkout.
          if (!isBrowserPreviewFile(relativePath)) return refusedFile("not-previewable");
          const project = readProject(scopeProjectRef(deps.environmentId, shell.projectId));
          const root = shell.worktreePath ?? project?.workspaceRoot;
          if (!root) return refused("unknown-thread");
          const outcome = await previewFile(ref, resolvePathLinkTarget(relativePath, root), root);
          return outcome === "opened"
            ? ({ status: "opened", relativePath } as UiNavigationFileReceipt)
            : refusedFile(outcome);
        }
        // The native file-link path: the selected t3.file/presentation
        // provider presents the file once, with the panel's context, and the
        // file surface (SelectedApiPresentation) takes that view. A provider
        // that cannot present it fails the open here, for the caller to
        // report, rather than as a tab showing only the failure.
        const navigationId = randomUUID();
        await presentBeforeOpen(
          filePresentationRequest(relativePath, normalizeRevealLine(line), navigationId),
          rightPanelViewContext({
            environmentId: deps.environmentId,
            projectId: shell.projectId,
            threadId: ref.threadId,
            projectWorkspaceRoot:
              readProject(scopeProjectRef(deps.environmentId, shell.projectId))?.workspaceRoot ??
              null,
            threadWorktreePath: shell.worktreePath ?? null,
            client: deps.client,
          }),
          call.signal,
        );
        useRightPanelStore.getState().openFile(ref, relativePath, line, navigationId);
        return { status: "opened", relativePath } as UiNavigationFileReceipt;
      }
      if (call.method !== "openThread")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown navigation op ${call.method}`,
        );
      const input = readInputObject(call.input);
      const threadId = readInputString(input, "threadId")!;
      const surfaceId = readInputString(input, "surfaceId", false);
      // The server adapter already scoped the target; the client owns the final say.
      const ref = scopeThreadRef(deps.environmentId, ThreadId.make(threadId));
      const shell = readThreadShell(ref);
      if (!shell?.projectId) return refused("unknown-thread");
      if (
        shell.projectId !== call.context.resource.projectId ||
        !installation.grants.projectIds.some((id) => id === shell.projectId)
      )
        return refused("out-of-scope");
      if (surfaceId !== undefined) {
        // Only the caller's own thread-scoped side-panel surfaces, as the
        // right panel is where a thread's session view lives.
        const surface = installation.package.manifest.surfaces.find(
          (candidate) => candidate.id === surfaceId,
        );
        const project = readProject(scopeProjectRef(deps.environmentId, shell.projectId));
        if (
          !surface ||
          surface.scope !== "thread" ||
          !surface.placements.includes("side-panel") ||
          !surface.clients.includes(deps.client)
        )
          return refused("surface-not-found");
        if (!project) return refused("unknown-thread");
        // Opened before routing so the thread renders with its panel in place.
        if (
          !openInstalledSurface(deps, ref, installation.id, surface, "side-panel", {
            projectId: shell.projectId,
            workspaceRoot: project.workspaceRoot,
            worktreePath: shell.worktreePath ?? null,
          })
        )
          return refused("surface-not-found");
      }
      await navigate(ref);
      return { status: "opened", threadId, ...(surfaceId === undefined ? {} : { surfaceId }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Pull-request handoff — native's checkout and resolve-conflicts flows, run for a pack.

/** The native steps a handoff runs; injected so tests can substitute fakes. */
export interface PrHandoffHost {
  /**
   * Native's new-thread action: opens a draft thread on the project and navigates to it, or
   * points it at a workspace. Null when no thread could be opened.
   */
  readonly openThread: (
    projectRef: ScopedProjectRef,
    workspace?: {
      readonly branch: string;
      readonly worktreePath: string | null;
      readonly envMode: DraftThreadEnvMode;
    },
  ) => Promise<{ readonly draftId: DraftId; readonly threadId: ThreadId } | null>;
  /** Native's checkout; the project's setup script runs for `threadId`. */
  readonly prepare: (input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly reference: string;
    readonly mode: (typeof CLIENT_PR_HANDOFF_MODES)[number];
    readonly threadId: ThreadId;
  }) => Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly branch: string;
          readonly worktreePath: string | null;
          readonly isOnPullRequestHead: boolean;
          readonly isTrackingPullRequestHead?: boolean;
        };
      }
    | { readonly ok: false; readonly detail: string | null }
  >;
}

export const nativePrHandoffPrepare: PrHandoffHost["prepare"] = async ({
  environmentId,
  ...input
}) => {
  const result = await runAtomCommand(
    appAtomRegistry,
    gitEnvironment.preparePullRequestThread,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { ok: true, value: result.value };
  const failure = squashAtomCommandFailure(result);
  return { ok: false, detail: pullRequestCheckoutErrorDetail(failure) };
};

const PR_HANDOFF_KEYS = new Set(["target", "task", "mode", "pullRequest"]);
const PR_HANDOFF_PULL_REQUEST_KEYS = new Set(["number", "url", "headBranch", "baseBranch"]);

/** A host-resolved pull request, a closed task and a checkout mode — nothing else is accepted. */
function readPrHandoffInput(value: Json) {
  const input = readInputObject(value);
  const task = CLIENT_PR_HANDOFF_TASKS.find((kind) => kind === input.task);
  const mode = CLIENT_PR_HANDOFF_MODES.find((kind) => kind === input.mode);
  const pullRequest = readInputObject(input.pullRequest ?? null);
  if (
    task === undefined ||
    mode === undefined ||
    Object.keys(input).some((key) => !PR_HANDOFF_KEYS.has(key)) ||
    Object.keys(pullRequest).some((key) => !PR_HANDOFF_PULL_REQUEST_KEYS.has(key)) ||
    typeof pullRequest.number !== "number"
  )
    throw new ClientProviderOpError("provider-rejected", "Invalid pull-request handoff");
  return {
    task,
    mode,
    pullRequest: {
      number: pullRequest.number,
      url: readInputString(pullRequest, "url")!,
      headBranch: readInputString(pullRequest, "headBranch")!,
      baseBranch: readInputString(pullRequest, "baseBranch")!,
    },
  };
}

/**
 * Native's pull-request handoff for a pack: the pack names a task, and the host writes the prompt,
 * opens the thread, checks out, navigates and reports it in native's toasts exactly as the native
 * panel does. It only prepares a draft; the reader sends it.
 */
export function createPrHandoffClientProvider(
  deps: ClientProviderDeps,
  host: PrHandoffHost,
): ClientLocalProvider {
  return {
    async invoke(call): Promise<VcsActionHandoffResult> {
      if (call.method !== "start")
        throw new ClientProviderOpError(
          "client-provider-unavailable",
          `Unknown handoff op ${call.method}`,
        );
      const authorize = () => {
        const installation = authorizeCaller(deps, call.caller, call.context, [
          VCS_MUTATE,
          VCS_HANDOFF,
        ]);
        if (!installation.enabled)
          throw new ClientProviderOpError("client-target-denied", "Caller is disabled");
        return installation;
      };
      const installation = authorize();
      const { task, mode, pullRequest } = readPrHandoffInput(call.input);
      const projectId = installation.grants.projectIds.find(
        (id) => id === call.context.resource.projectId,
      );
      const project = projectId
        ? readProject(scopeProjectRef(deps.environmentId, projectId))
        : null;
      // Native offers no checkout without a project to check out into, and opens nothing; saying
      // a thread failed to open would name a step that never ran.
      if (!projectId || !project)
        throw new ClientProviderOpError("provider-rejected", "Unknown project");
      const prompt = task === "resolve-conflicts" ? buildResolveConflictsPrompt(pullRequest) : null;
      // Beside a thread, native hands a task to that thread's composer and checks nothing out.
      const threadId = call.context.resource.threadId;
      const beside = threadId ? scopeThreadRef(deps.environmentId, ThreadId.make(threadId)) : null;
      if (
        prompt !== null &&
        beside !== null &&
        (readThreadShell(beside)?.projectId ??
          useComposerDraftStore.getState().getDraftThread(beside)?.projectId) === projectId
      ) {
        writePullRequestTaskToComposer(beside, { prompt });
        showTaskAddedToComposerToast();
        return { status: "drafted" };
      }
      const projectRef = scopeProjectRef(deps.environmentId, projectId);
      // Global and posted before the thread opens, so it is still on screen on that thread.
      const toast = beginPullRequestCheckoutToast();
      // A cancelled call or a caller that lost its install or grants starts nothing further; what
      // already ran stays, as native leaves a partial checkout.
      const live = () => {
        try {
          if (call.signal.aborted)
            throw new ClientProviderOpError("client-target-denied", "Handoff cancelled");
          authorize();
        } catch (error) {
          toast.close();
          throw error;
        }
      };
      // A call cancelled or timed out while a host step runs fails at once, saying which step it
      // stopped in; the step itself is not undone, and nothing starts from what it later returns.
      const step = <A>(work: Promise<A>, stage: "thread" | "checkout" | "thread-move") =>
        new Promise<A>((resolve, reject) => {
          const abandon = () => {
            toast.settle({ kind: "stopped", stage });
            reject(new ClientProviderOpError("client-target-denied", "Handoff cancelled"));
          };
          if (call.signal.aborted) return abandon();
          call.signal.addEventListener("abort", abandon, { once: true });
          const done = () => call.signal.removeEventListener("abort", abandon);
          work.then(
            (value) => (done(), resolve(value)),
            (error: unknown) => (done(), reject(error)),
          );
        });
      // The thread is opened before the checkout because the project's setup script only runs
      // for a checkout that knows which thread it is for.
      const opened = await step(
        host.openThread(projectRef).catch(() => null),
        "thread",
      );
      live();
      if (opened === null) {
        toast.settle({ kind: "thread-failed" });
        return { status: "failed", stage: "thread" };
      }
      const prepared = await step(
        host.prepare({
          environmentId: deps.environmentId,
          cwd: project.workspaceRoot,
          reference: pullRequest.url,
          mode,
          threadId: opened.threadId,
        }),
        "checkout",
      );
      live();
      if (!prepared.ok) {
        toast.settle({ kind: "checkout-failed", detail: prepared.detail });
        return {
          status: "failed",
          stage: "checkout",
          ...(prepared.detail ? { detail: prepared.detail.slice(0, 2048) } : {}),
        };
      }
      const { branch, worktreePath, isOnPullRequestHead, isTrackingPullRequestHead } =
        prepared.value;
      const pointed = await step(
        host
          .openThread(projectRef, {
            branch,
            worktreePath,
            envMode: worktreePath === null ? "local" : "worktree",
          })
          .catch(() => null),
        "thread-move",
      );
      live();
      // Writing the task now would aim the agent at whatever the thread was already open on.
      if (pointed === null) {
        toast.settle({ kind: "thread-move-failed", branch });
        return { status: "failed", stage: "thread-move", branch };
      }
      if (prompt !== null) writePullRequestTaskToComposer(opened.draftId, { prompt });
      toast.settle({
        kind: "ready",
        mode,
        withTask: prompt !== null,
        isOnPullRequestHead,
        isTrackingPullRequestHead,
      });
      return { status: "ready", branch, worktreePath, isOnPullRequestHead };
    },
  };
}

// ---------------------------------------------------------------------------

/** All host-owned `t3.client/*` providers for one environment connection. */
export function createClientProviders(
  deps: ClientProviderDeps,
  navigate: ThreadNavigator,
  prHandoff: PrHandoffHost,
): ReadonlyMap<string, ClientLocalProvider> {
  return new Map<string, ClientLocalProvider>([
    ["t3.client/theme", createThemeClientProvider(deps)],
    ["t3.client/notifications", createNotificationsClientProvider(deps)],
    ["t3.client/keybindings", createKeybindingsClientProvider(deps)],
    ["t3.client/panels", createPanelsClientProvider(deps)],
    ["t3.client/composer", createComposerClientProvider(deps)],
    ["t3.client/terminal-appearance", createTerminalAppearanceClientProvider(deps)],
    ["t3.client/preferences", createPreferencesClientProvider(deps)],
    ["t3.client/external", createExternalClientProvider(deps)],
    ["t3.client/editor", createEditorClientProvider(deps)],
    ["t3.client/browser-history", createBrowserHistoryClientProvider(deps)],
    ["t3.client/navigation", createNavigationClientProvider(deps, navigate)],
    ["t3.client/pr-handoff", createPrHandoffClientProvider(deps, prHandoff)],
  ]);
}

// SDK version bumps require the matching client handler in the same change.
export const CLIENT_PROVIDER_DESCRIPTORS = [...CLIENT_PROVIDER_APIS.values()].map(
  ({ id, version }) => ({ id, version }),
);

export const CLIENT_PROVIDER_CLIENT_TAG = isElectron ? "desktop" : "web";
