/**
 * Desktop renderer side of the private browser engine host contract.
 *
 * `BrowserEngineHostConnection` registers this window as the engine host of
 * the desktop's own environment. Each hosted webview then claims its guest
 * under the guest's webContents id and reports page status through
 * `usePreviewBridge`; the server executes `t3.browser/sessions` page commands
 * by sending them here. Web and mobile clients never mount any of this.
 */
import {
  BROWSER_ENGINE_FAVICON_MAX_LENGTH,
  BROWSER_ENGINE_IMPORT_SOURCE_MAX,
  BROWSER_ENGINE_IMPORT_SOURCE_PROFILE_MAX,
  BROWSER_ENGINE_PROFILE_LIST_MAX,
  BrowserImportFailureReason,
  type BrowserEngineCommand,
  type BrowserEngineProfileCommand,
  type BrowserProfile,
  type BrowserEngineHostCommandResultInput,
  type BrowserEngineHostProfilesInput,
  type BrowserEngineHostStreamEvent,
  type BrowserEnginePageStatus,
  type DesktopPreviewBridge,
  type DesktopPreviewTabState,
  type EnvironmentId,
  PREVIEW_ZOOM_LEVELS,
  type PreviewNavStatus,
  type PreviewZoomFactor,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { create } from "zustand";

import { previewRuntimeTabId } from "./previewRuntimeTabId";

const TITLE_MAX_LENGTH = 512;

interface BrowserEngineHostStoreState {
  /** Absent before registration; null once registration failed or ended. */
  readonly hostConnectionIdByEnvironment: Record<string, string | null>;
  readonly setHostConnectionId: (environmentId: string, hostConnectionId: string | null) => void;
  readonly failedClaimByTabId: Record<
    string,
    { readonly hostConnectionId: string; readonly serverEpoch: string }
  >;
  readonly setClaimFailure: (
    runtimeTabId: string,
    claim: { readonly hostConnectionId: string; readonly serverEpoch: string } | null,
  ) => void;
}

export const useBrowserEngineHostStore = create<BrowserEngineHostStoreState>()((set) => ({
  hostConnectionIdByEnvironment: {},
  failedClaimByTabId: {},
  setHostConnectionId: (environmentId, hostConnectionId) =>
    set((state) => {
      const current = state.hostConnectionIdByEnvironment[environmentId];
      if (current === hostConnectionId) return state;
      return {
        hostConnectionIdByEnvironment: {
          ...state.hostConnectionIdByEnvironment,
          [environmentId]: hostConnectionId,
        },
      };
    }),
  setClaimFailure: (runtimeTabId, claim) =>
    set((state) => {
      if (claim === null && state.failedClaimByTabId[runtimeTabId] === undefined) return state;
      const { [runtimeTabId]: _previous, ...rest } = state.failedClaimByTabId;
      return { failedClaimByTabId: claim === null ? rest : { ...rest, [runtimeTabId]: claim } };
    }),
}));

export function isHostedEngineClaimPending(
  environmentId: string,
  runtimeTabId?: string,
  serverEpoch?: string,
): boolean {
  const state = useBrowserEngineHostStore.getState();
  const hostConnectionId = state.hostConnectionIdByEnvironment[environmentId];
  if (hostConnectionId === null) return false;
  const failure = runtimeTabId ? state.failedClaimByTabId[runtimeTabId] : undefined;
  return (
    failure === undefined ||
    failure.hostConnectionId !== hostConnectionId ||
    failure.serverEpoch !== serverEpoch
  );
}

/**
 * Latest observed state of each guest this window renders, keyed by runtime
 * tab id. Commands are checked against it so a command fenced on a replaced
 * guest is refused instead of landing on its successor.
 */
const hostedTabs = new Map<string, DesktopPreviewTabState>();

export function recordHostedTabState(runtimeTabId: string, state: DesktopPreviewTabState): void {
  hostedTabs.set(runtimeTabId, state);
}

export function forgetHostedTab(runtimeTabId: string): void {
  hostedTabs.delete(runtimeTabId);
  useBrowserEngineHostStore.getState().setClaimFailure(runtimeTabId, null);
}

/** The engine generation of a guest is its serialized webContents id. */
export function engineGenerationOf(state: DesktopPreviewTabState): string | null {
  return state.webContentsId === null ? null : String(state.webContentsId);
}

function closestZoomStep(factor: number): number {
  let closest = 0;
  for (let index = 1; index < PREVIEW_ZOOM_LEVELS.length; index += 1) {
    if (
      Math.abs(PREVIEW_ZOOM_LEVELS[index]! - factor) <
      Math.abs(PREVIEW_ZOOM_LEVELS[closest]! - factor)
    ) {
      closest = index;
    }
  }
  return closest;
}

function projectNavStatus(status: DesktopPreviewTabState["navStatus"]): PreviewNavStatus {
  if (status.kind === "Idle") return { _tag: "Idle" };
  const title = status.title.slice(0, TITLE_MAX_LENGTH);
  if (status.kind === "LoadFailed") {
    return {
      _tag: "LoadFailed",
      url: status.url,
      title,
      code: status.code,
      description: status.description,
    };
  }
  return { _tag: status.kind, url: status.url, title };
}

/** Projects observed desktop state into the bounded engine report. */
export function toEnginePageStatus(state: DesktopPreviewTabState): BrowserEnginePageStatus {
  const favicon =
    state.favicon && state.favicon.dataUrl.length <= BROWSER_ENGINE_FAVICON_MAX_LENGTH
      ? { dataUrl: state.favicon.dataUrl, pageUrl: state.favicon.pageUrl }
      : null;
  return {
    navStatus: projectNavStatus(state.navStatus),
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    zoomFactor: PREVIEW_ZOOM_LEVELS[closestZoomStep(state.zoomFactor)] as PreviewZoomFactor,
    appearance: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    devToolsOpen: state.devToolsOpen,
    pictureInPicture: state.pictureInPicture,
    favicon,
  };
}

/**
 * The next owner report for an observed desktop state, or null when it would
 * repeat the last one sent. Desktop state events fire for changes the server
 * does not project, so only a changed projection is worth a report.
 */
export function nextEnginePageReport(
  lastStatusKey: string | null,
  state: DesktopPreviewTabState,
): { readonly status: BrowserEnginePageStatus; readonly statusKey: string } | null {
  const status = toEnginePageStatus(state);
  const statusKey = JSON.stringify(status);
  return statusKey === lastStatusKey ? null : { status, statusKey };
}

type CommandResult = BrowserEngineHostCommandResultInput["result"];

type EngineCommandBridge = Pick<
  DesktopPreviewBridge,
  | "navigate"
  | "goBack"
  | "goForward"
  | "refresh"
  | "hardReload"
  | "setZoomFactor"
  | "setColorScheme"
  | "setAudioMuted"
  | "openDevTools"
  | "closeDevTools"
  | "pictureInPicture"
>;

const rejected = (reason: Extract<CommandResult, { outcome: "rejected" }>["reason"]) =>
  ({ outcome: "rejected", reason }) as const;

/** Runs one server-issued page command on the guest it is fenced to. */
export async function executeEngineCommand(
  bridge: EngineCommandBridge,
  runtimeTabId: string,
  engineGeneration: string,
  command: BrowserEngineCommand,
): Promise<CommandResult> {
  const state = hostedTabs.get(runtimeTabId);
  if (state === undefined) return rejected("session-not-found");
  if (engineGenerationOf(state) !== engineGeneration) return rejected("stale-generation");
  try {
    switch (command._tag) {
      case "navigate":
        // The same desktop load the native address bar performs.
        await bridge.navigate(runtimeTabId, command.url);
        break;
      case "back":
        if (!state.canGoBack) return rejected("not-applicable");
        await bridge.goBack(runtimeTabId);
        break;
      case "forward":
        if (!state.canGoForward) return rejected("not-applicable");
        await bridge.goForward(runtimeTabId);
        break;
      case "reload":
        await bridge.refresh(runtimeTabId);
        break;
      case "hardReload":
        await bridge.hardReload(runtimeTabId);
        break;
      case "zoom":
        await bridge.setZoomFactor(runtimeTabId, command.zoomFactor);
        break;
      case "setAppearance":
        await bridge.setColorScheme(runtimeTabId, command.appearance);
        break;
      case "setAudioMuted":
        await bridge.setAudioMuted(runtimeTabId, command.muted);
        break;
      case "setDevToolsOpen": {
        // A desktop shell older than this renderer may lack the IPC; the
        // server names that refusal engine-unsupported.
        const toggle = command.open ? bridge.openDevTools : bridge.closeDevTools;
        if (typeof toggle !== "function") return rejected("not-applicable");
        await toggle(runtimeTabId);
        break;
      }
      case "setPictureInPicture":
        // Already in the requested state: nothing to open or close.
        if (state.pictureInPicture === command.open) break;
        if (command.open) await bridge.pictureInPicture.open(runtimeTabId);
        else await bridge.pictureInPicture.close(runtimeTabId);
        break;
    }
  } catch {
    return rejected("failed");
  }
  return { outcome: "applied" };
}

type ProfileCommandBridge = Pick<
  DesktopPreviewBridge,
  "clearCookies" | "clearCache" | "listBrowserImportSources" | "importBrowserCookies"
>;

export interface ProfileCommandDeps {
  readonly environmentId: EnvironmentId;
  readonly bridge: Partial<ProfileCommandBridge>;
  /** The hydrated profile list and the profile new tabs open under. */
  readonly profiles: () => Promise<{
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  }>;
  /**
   * Asks the user at this desktop; `false` when refused, dismissed by
   * `signal`, or no prompt could show.
   */
  readonly confirm: (message: string, signal: AbortSignal) => Promise<boolean>;
  /** Aborted when the server cancels this command. */
  readonly signal: AbortSignal;
  /**
   * Import only: reports the confirmation and resolves once the server
   * revalidated the caller — `true` to proceed, `false` when cancelled.
   */
  readonly proceed: () => Promise<boolean>;
}

/** The list as the server takes it: ids and names only, bounded. */
async function hostProfileList(profiles: ProfileCommandDeps["profiles"]) {
  const { profiles: list, defaultProfileId } = await profiles();
  return {
    profiles: list
      .slice(0, BROWSER_ENGINE_PROFILE_LIST_MAX)
      .map((profile) => ({ id: profile.id, name: profile.name })),
    defaultProfileId,
  };
}

/**
 * Publishes this host's profile list for `t3.browser/profiles`' `changes`
 * stream: once now, then after each settings change that alters it. A
 * settings change elsewhere (zoom, viewport…) sends nothing. Returns the stop
 * function; a registration publishes under its own host id only.
 */
export function publishHostProfiles(input: {
  readonly hostConnectionId: string;
  readonly profiles: ProfileCommandDeps["profiles"];
  /** Calls `listener` whenever the underlying settings may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly send: (input: BrowserEngineHostProfilesInput) => unknown;
}): () => void {
  let stopped = false;
  let read = 0;
  let last: string | null = null;
  const publish = () => {
    const current = ++read;
    void hostProfileList(input.profiles).then(
      (list) => {
        // Only the newest read may land; an older one is an older list.
        if (stopped || current !== read) return;
        const key = JSON.stringify(list);
        if (key === last) return;
        last = key;
        input.send({ hostConnectionId: input.hostConnectionId, ...list });
      },
      // Unreadable settings publish nothing; the list reads still answer.
      () => undefined,
    );
  };
  const unsubscribe = input.subscribe(publish);
  publish();
  return () => {
    stopped = true;
    unsubscribe();
  };
}

const IMPORT_LABEL_MAX = 128;
/**
 * Firefox names an unnamed profile after its directory, which may be an
 * absolute custom path; such a label never leaves this machine.
 */
const importProfileLabel = (name: string, index: number) =>
  /[\\/]/.test(name) ? `Profile ${index + 1}` : name.slice(0, IMPORT_LABEL_MAX);
const importHandle = (index: number) => `p${index}`;
const importIndex = (handle: string) => {
  const match = /^p(\d{1,2})$/.exec(handle);
  return match ? Number(match[1]) : -1;
};

/** The desktop bridge flattens import errors to their message; the reason rides in it. */
const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

/**
 * Runs one server-issued `t3.browser/profiles` command against this desktop's
 * partitions. A clear or import always names a known profile — the bridge's
 * "no profile means every partition" form is never reached. Import asks the
 * user here before any source browser is read.
 */
export async function executeProfileCommand(
  deps: ProfileCommandDeps,
  command: BrowserEngineProfileCommand,
): Promise<CommandResult> {
  const { bridge, environmentId } = deps;
  try {
    if (command._tag === "listProfiles") {
      return { outcome: "profiles", ...(await hostProfileList(deps.profiles)) };
    }
    if (command._tag === "listImportSources") {
      if (!bridge.listBrowserImportSources) return rejected("not-applicable");
      const sources = await bridge.listBrowserImportSources();
      return {
        outcome: "import-sources",
        sources: sources.slice(0, BROWSER_ENGINE_IMPORT_SOURCE_MAX).map((source) => ({
          id: source.id,
          name: source.name.slice(0, IMPORT_LABEL_MAX),
          ...(source.unavailable === undefined ? {} : { unavailable: source.unavailable }),
          profiles: source.profiles
            .slice(0, BROWSER_ENGINE_IMPORT_SOURCE_PROFILE_MAX)
            .map((profile, index) => ({
              handle: importHandle(index),
              name: importProfileLabel(profile.name, index),
              ...(profile.cookieCount === undefined || profile.cookieCount < 0
                ? {}
                : { cookieCount: profile.cookieCount }),
            })),
        })),
      };
    }
    const { profiles } = await deps.profiles();
    const target = profiles.find((profile) => profile.id === command.profileId);
    if (target === undefined) return rejected("unknown-profile");
    switch (command._tag) {
      case "clearCookies":
        if (!bridge.clearCookies) return rejected("not-applicable");
        await bridge.clearCookies(environmentId, target.id);
        return { outcome: "applied" };
      case "clearCache":
        if (!bridge.clearCache) return rejected("not-applicable");
        await bridge.clearCache(environmentId, target.id);
        return { outcome: "applied" };
      case "importCookies": {
        if (!bridge.listBrowserImportSources || !bridge.importBrowserCookies) {
          return rejected("not-applicable");
        }
        // Re-listed here so the handle resolves against what is installed now.
        const source = (await bridge.listBrowserImportSources()).find(
          (candidate) => candidate.id === command.sourceId,
        );
        if (source === undefined) return { outcome: "import-failed", reason: "unknownSource" };
        if (source.unavailable !== undefined) {
          return { outcome: "import-failed", reason: source.unavailable };
        }
        const index = importIndex(command.sourceProfile);
        const sourceProfile = source.profiles[index];
        if (sourceProfile === undefined) {
          return { outcome: "import-failed", reason: "unknownSourceProfile" };
        }
        const confirmed = await deps.confirm(
          `${command.requester} wants to import cookies from ${source.name} (${importProfileLabel(sourceProfile.name, index)}) into the "${target.name}" browser profile. Sites signed in there will be signed in here too.`,
          deps.signal,
        );
        if (deps.signal.aborted) return rejected("cancelled");
        if (!confirmed) return { outcome: "declined" };
        // Nothing is read until the server has rechecked the caller.
        if (!(await deps.proceed())) return rejected("cancelled");
        try {
          const result = await bridge.importBrowserCookies({
            environmentId,
            sourceId: source.id,
            sourceProfileDirectory: sourceProfile.directory,
            targetProfileId: target.id,
          });
          return { outcome: "imported", imported: result.imported, skipped: result.skipped };
        } catch (cause) {
          return { outcome: "import-failed", reason: importFailureReason(cause) };
        }
      }
    }
  } catch {
    return rejected("failed");
  }
}

/** Command ids already executed; a resubscribed stream must never replay one. */
export const HANDLED_COMMANDS_LIMIT = 256;

/**
 * Consumes one environment's host registration stream: tracks the registered
 * host id in the store, runs each command once on its fenced guest, and
 * answers with the outcome. A failed registration clears the host id, so
 * hosted tabs stop claiming until the stream registers again.
 */
export function createEngineHostEventHandler(input: {
  readonly environmentId: EnvironmentId;
  readonly bridge: (EngineCommandBridge & Partial<ProfileCommandBridge>) | null;
  readonly sendResult: (result: BrowserEngineHostCommandResultInput) => unknown;
  readonly profiles: ProfileCommandDeps["profiles"];
  readonly confirm: ProfileCommandDeps["confirm"];
  /** Told the registered host id, or null once the registration is lost. */
  readonly onRegistration?: (hostConnectionId: string | null) => void;
}): (result: AsyncResult.AsyncResult<BrowserEngineHostStreamEvent, unknown>) => void {
  const { environmentId, bridge, sendResult } = input;
  const handled = new Set<string>();
  /** Running profile commands, cancellable by the server until they settle. */
  const running = new Map<
    string,
    { readonly abort: AbortController; proceed?: (proceed: boolean) => void }
  >();
  return (result) => {
    const { setHostConnectionId } = useBrowserEngineHostStore.getState();
    // A lost or replaced registration can no longer receive proceed.
    const cancelRunning = () => {
      for (const entry of running.values()) {
        entry.abort.abort();
        entry.proceed?.(false);
      }
      running.clear();
    };
    if (AsyncResult.isFailure(result)) {
      cancelRunning();
      setHostConnectionId(environmentId, null);
      input.onRegistration?.(null);
      return;
    }
    if (!AsyncResult.isSuccess(result)) return;
    const event = result.value;
    if (event.type === "registered") {
      cancelRunning();
      setHostConnectionId(environmentId, event.hostConnectionId);
      input.onRegistration?.(event.hostConnectionId);
      return;
    }
    if (event.type === "profile-command-proceed" || event.type === "profile-command-cancel") {
      const entry = running.get(event.commandId);
      if (event.type === "profile-command-cancel") entry?.abort.abort();
      entry?.proceed?.(event.type === "profile-command-proceed");
      return;
    }
    const hostConnectionId =
      useBrowserEngineHostStore.getState().hostConnectionIdByEnvironment[environmentId];
    if (!bridge || hostConnectionId == null || handled.has(event.commandId)) return;
    handled.add(event.commandId);
    if (handled.size > HANDLED_COMMANDS_LIMIT) {
      handled.delete(handled.values().next().value!);
    }
    if (event.type === "profile-command") {
      const { commandId } = event;
      const entry: { abort: AbortController; proceed?: (proceed: boolean) => void } = {
        abort: new AbortController(),
      };
      running.set(commandId, entry);
      const proceed = () =>
        new Promise<boolean>((resolve) => {
          if (entry.abort.signal.aborted) return resolve(false);
          entry.proceed = resolve;
          sendResult({ hostConnectionId, commandId, result: { outcome: "confirmed" } });
        });
      void executeProfileCommand(
        {
          environmentId,
          bridge,
          profiles: input.profiles,
          confirm: input.confirm,
          signal: entry.abort.signal,
          proceed,
        },
        event.command,
      ).then((outcome) => {
        running.delete(commandId);
        sendResult({ hostConnectionId, commandId, result: outcome });
      });
      return;
    }
    const runtimeTabId = previewRuntimeTabId(
      { environmentId, threadId: event.target.threadId },
      event.target.serverEpoch,
      event.target.tabId,
    );
    void executeEngineCommand(bridge, runtimeTabId, event.engineGeneration, event.command).then(
      (outcome) => sendResult({ hostConnectionId, commandId: event.commandId, result: outcome }),
    );
  };
}
