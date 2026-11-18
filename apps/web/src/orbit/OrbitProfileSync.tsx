import {
  APPEARANCE_SECTION,
  createOrbitGatewayClient,
  createOrbitProfileLive,
  createProfileSync,
  isJsonObject,
  PROFILE_REJECTED_RETRY_MS,
  SIDEBAR_HIDDEN_THREADS_SECTION,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type ProfileSyncState,
  type OrbitGatewayWorkspace,
  type ProfileBinding,
  type ProfileSectionName,
} from "@t3tools/client-runtime/orbit-gateway";
import { useEffect } from "react";
import { create } from "zustand";

import { useWorkspaceStore } from "../workspaceStore";
import { WORKSPACE_COLORS, type Workspace, type WorkspaceColor } from "../workspaces.logic";
import {
  onOrbitCredentialRefused,
  reconcileEnvironmentProvider,
  useEnvironmentProvider,
} from "./environmentProvider";
import {
  clearAttachedServers,
  recordAttachedServers,
  watchAttachedServersRecord,
} from "./attachedServers";
import { pruneWorkspaceCloneRefs } from "./cloneWorkspaceRefs";
import { desktopOrbitGatewayTransport } from "./desktopOrbitGateway";
import { OrbitAppearanceSync } from "./OrbitAppearanceSync";
import { getProfileSyncChannels, onLocalProfileChange } from "./profileSyncRegistry";
import {
  forgetRemovedProfileSyncKeys,
  loadSectionState,
  saveSectionState,
} from "./profileSyncStorage";
import { registerOrbitSleepClient } from "./orbitInstanceSleep";
import { createProviderRunGuard } from "./providerRunGuard";
import {
  bindSidebarHiddenProfile,
  classifySidebarEnvironments,
  sidebarHiddenThreadsChannel,
  watchSidebarHiddenThreads,
} from "./sidebarHiddenThreads";
import { createSerialRunner } from "./serialRunner";
import { trackNonUserThemeChanges } from "./themeOrigin";
import {
  hasWorkspaceChanges,
  parseWorkspaceProfileSyncState,
  syncWorkspaceProfile,
  type WorkspaceProfileSyncPorts,
  type WorkspaceProfileSyncState,
} from "./workspaceProfileSync";

const STATE_STORAGE_KEY = "t3code:orbit-profile-sync:v1";
const HIDDEN_THREADS_STATE_KEY = "t3code:orbit-profile-hidden-threads:v1";
/**
 * Environment cadence: the server list, credential renewal, clone references and the attached set
 * about every 15 s while the window has focus, every 30 s otherwise. Profile changes no longer
 * ride on it: they arrive as `conn.profile.updated` notices (see createOrbitProfileLive).
 */
const FOCUSED_PROBE_MS = 15_000;
const BACKGROUND_PROBE_MS = 30_000;
const LOCAL_EDIT_DEBOUNCE_MS = 1_500;

export interface OrbitProfileSyncStatus {
  readonly phase: "off" | "unbound" | "synced" | "error";
  readonly profileName: string | null;
  readonly error: string | null;
  readonly syncedAt: number | null;
  /**
   * Appearance and device settings. "unsupported" means the Gateway predates profile sections;
   * workspaces still sync.
   */
  readonly sections: "unknown" | "supported" | "unsupported";
  readonly sectionsError: string | null;
  /** Conn: why the hidden sidebar threads did not sync; they stay hidden on this device. */
  readonly hiddenThreadsError?: string | null;
}

const INITIAL_STATUS: OrbitProfileSyncStatus = {
  phase: "off",
  profileName: null,
  error: null,
  syncedAt: null,
  sections: "unknown",
  sectionsError: null,
};

/** What the profile sync last did, for Settings. */
export const useOrbitProfileSyncStatus = create<OrbitProfileSyncStatus>(() => INITIAL_STATUS);

let requestSync: (() => Promise<void>) | null = null;
let beforeRebind: ((phase: "before" | "after") => void) | null = null;

/**
 * Runs the profile sync now and settles once a run that started after this call has finished, so
 * a profile switch first sends this device's unsent edits to the profile it leaves. A no-op
 * outside the desktop app.
 */
export function syncOrbitProfileNow(): Promise<void> {
  return requestSync?.() ?? Promise.resolve();
}

/** Another window of this app bound a profile; only the main window runs the sync. */
const REBIND_STORAGE_KEY = "t3code:orbit-profile-rebind:v1";
/** Keeps announcements distinct, so each fires a storage event and pairs `before` with `after`. */
let rebindAnnouncements = 0;
let announcedRebind: string | null = null;

/**
 * Around this device's bind to another profile: drops the old binding's channel and reads. In a
 * window without the sync it tells the main window, which holds its reads from `before` until
 * `after` and then reads the new binding.
 */
export function orbitProfileRebinding(phase: "before" | "after"): void {
  if (beforeRebind) {
    beforeRebind(phase);
    return;
  }
  if (phase === "before" || announcedRebind === null) {
    rebindAnnouncements += 1;
    // Random, so two windows announcing in the same millisecond never share a hold.
    announcedRebind = `${Date.now().toString(36)}-${rebindAnnouncements}-${Math.random().toString(36).slice(2)}`;
  }
  window.localStorage.setItem(REBIND_STORAGE_KEY, `${phase}:${announcedRebind}`);
  if (phase === "after") announcedRebind = null;
}

// Conn: every window's sleep controller reads the Gateway through this window's client.
registerOrbitSleepClient(() => desktopOrbitGatewayClient());
// Conn: every window applies the attached set the main window stores (flag `connAttachedServers`).
watchAttachedServersRecord();
// Conn: every window hides the sidebar threads the main window's sync agreed on.
watchSidebarHiddenThreads();

/** The Gateway client over the desktop main process, or null outside the desktop app. */
export function desktopOrbitGatewayClient(): OrbitGatewayClient | null {
  const transport = desktopOrbitGatewayTransport();
  return transport ? createOrbitGatewayClient(transport) : null;
}

function toGateway(workspace: Workspace): OrbitGatewayWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    icon: workspace.icon,
    image: workspace.image ?? null,
    projectRefs: [...(workspace.projectRefs ?? [])],
    projectKeys: [...workspace.projectKeys],
  };
}

function toLocal(workspace: OrbitGatewayWorkspace): Workspace {
  const color = (WORKSPACE_COLORS as readonly string[]).includes(workspace.color)
    ? (workspace.color as WorkspaceColor)
    : "slate";
  return {
    id: workspace.id,
    name: workspace.name,
    color,
    icon: workspace.icon,
    image: workspace.image ?? null,
    projectRefs: [...(workspace.projectRefs ?? [])],
    projectKeys: [...(workspace.projectKeys ?? [])],
  };
}

function loadState(): WorkspaceProfileSyncState | null {
  try {
    const raw = window.localStorage.getItem(STATE_STORAGE_KEY);
    return raw === null ? null : parseWorkspaceProfileSyncState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveState(state: WorkspaceProfileSyncState | null): void {
  if (state === null) window.localStorage.removeItem(STATE_STORAGE_KEY);
  else window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
}

function loadHiddenThreadsState(): ProfileSyncState | null {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(HIDDEN_THREADS_STATE_KEY) ?? "null",
    );
    if (!isJsonObject(raw) || typeof raw.profileId !== "number") return null;
    const section = isJsonObject(raw.sections)
      ? raw.sections[SIDEBAR_HIDDEN_THREADS_SECTION]
      : undefined;
    return {
      profileId: raw.profileId,
      profileVersion: typeof raw.profileVersion === "number" ? raw.profileVersion : -1,
      sections:
        isJsonObject(section) && typeof section.version === "number"
          ? {
              [SIDEBAR_HIDDEN_THREADS_SECTION]: {
                version: section.version,
                base: isJsonObject(section.base) ? section.base : null,
                remote: isJsonObject(section.remote) ? section.remote : null,
              },
            }
          : {},
      ignored: {},
    };
  } catch {
    return null;
  }
}

function saveHiddenThreadsState(state: ProfileSyncState): void {
  try {
    window.localStorage.setItem(HIDDEN_THREADS_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the next run reads the profile again.
  }
}

function writeLocal(workspaces: readonly OrbitGatewayWorkspace[]): void {
  const next = workspaces.map(toLocal);
  useWorkspaceStore.setState((state) => ({
    workspaces: next,
    activeWorkspaceId: next.some((workspace) => workspace.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : null,
  }));
}

/** A Gateway call a profile read skips because a newer scope replaced it. */
const obsoleteRead = (): Promise<never> =>
  Promise.reject(new Error("The profile read is obsolete."));

interface ProfileSyncController {
  /** Environment work: servers, credentials, clone references and the attached set. */
  readonly refreshEnvironments: () => Promise<void>;
  /** Whether a local edit is waiting to go out (workspaces or a section). */
  readonly hasLocalChanges: () => boolean;
  /**
   * Whether a local-edit trigger needs a profile read: always while a read runs (its answer can
   * move the base under the edit), otherwise only when a change is waiting.
   */
  readonly editNeedsRead: () => boolean;
  /** Follows the bound profile; `reconcile()` runs one authoritative profile read. */
  readonly profile: ReturnType<typeof createOrbitProfileLive>;
  /** Around a bind: the old binding's channel, reads and environment record become obsolete. */
  readonly rebinding: (phase: "before" | "after") => void;
  /**
   * A bind in another window, by its id: profile reads stay obsolete from its `before` until
   * every pending bind reported `after` (each released after 60 s if it never does).
   */
  readonly otherWindowRebinding: (phase: "before" | "after", id: string) => void;
  readonly beginNonUserChange: (name: ProfileSectionName) => () => void;
}

let controller: ProfileSyncController | null = null;

/**
 * The one sync for this window. It lives outside the component on purpose: a component that
 * mounts twice (React StrictMode in dev, a remount) must not start a second engine or a second
 * run loop, because two runs in flight would both PATCH the same section versions.
 */
function profileSyncController(): ProfileSyncController | null {
  if (controller) return controller;
  const transport = desktopOrbitGatewayTransport();
  if (!transport) return null;
  const client = createOrbitGatewayClient(transport);
  forgetRemovedProfileSyncKeys();
  /**
   * The workspace sync for one read: once that read is obsolete it applies nothing here and sends
   * nothing more to the Gateway, also not a conflict retry.
   */
  const scopedClient = (isCurrent: () => boolean): OrbitGatewayClient => ({
    ...client,
    // Checked before the call and again on its answer, so nothing after it applies the answer.
    settings: async (profileId) => {
      if (!isCurrent()) return obsoleteRead();
      const answer = await client.settings(profileId);
      return isCurrent() ? answer : obsoleteRead();
    },
    replaceWorkspaces: async (...args) => {
      if (!isCurrent()) return obsoleteRead();
      const answer = await client.replaceWorkspaces(...args);
      return isCurrent() ? answer : obsoleteRead();
    },
  });
  const workspacePorts = (isCurrent: () => boolean): WorkspaceProfileSyncPorts => ({
    client: scopedClient(isCurrent),
    readLocal: () => useWorkspaceStore.getState().workspaces.map(toGateway),
    writeLocal: (workspaces) => {
      if (isCurrent()) writeLocal(workspaces);
    },
    loadState,
    saveState: (state) => {
      if (isCurrent()) saveState(state);
    },
  });
  const sections = createProfileSync({
    client,
    channels: getProfileSyncChannels,
    loadState: loadSectionState,
    saveState: saveSectionState,
  });

  // Conn: its own engine and PATCH, so a Gateway that refuses this section cannot hold back
  // appearance or device edits sent in the same request. The channel belongs to one profile.
  let hiddenThreadsChannel: ReturnType<typeof sidebarHiddenThreadsChannel> | null = null;
  const hiddenThreads = createProfileSync({
    client,
    channels: () => (hiddenThreadsChannel ? [hiddenThreadsChannel] : []),
    loadState: () => loadHiddenThreadsState(),
    saveState: (state) => saveHiddenThreadsState(state),
  });

  const providerRuns = createProviderRunGuard();
  // Conn: Orbit off unbinds the sidebar's marks at once; a queued run may never see the off spell.
  useEnvironmentProvider.subscribe((state, previous) => {
    if (state.provider !== previous.provider && state.provider !== "orbit") {
      bindSidebarHiddenProfile("off");
    }
  });

  // Both runs touch the attached set and the profile state: one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T,>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  const inOrbit = (): boolean => useEnvironmentProvider.getState().provider === "orbit";
  /** Binds other windows announced and have not finished, with their safety release. */
  const heldBinds = new Map<string, ReturnType<typeof setTimeout>>();
  /** The last reads each run shares with the other, so neither needs a second Gateway call. */
  let lastMe: OrbitGatewayNode | null = null;
  let lastListed: readonly OrbitGatewayEnvironment[] | null = null;
  /** Set while the follow-up read for an edit made during a read is queued. */
  let followUpQueued = false;
  /** Profile reads running now; an edit during one always gets a read after it. */
  let profileReads = 0;
  let hiddenRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const recordAttached = async (
    me: OrbitGatewayNode,
    listed: readonly OrbitGatewayEnvironment[],
    gateway: OrbitGatewayClient = client,
  ): Promise<void> => {
    // Conn: flag `connAttachedServers` only; a failure here must not stop the sync.
    await recordAttachedServers(gateway, me, listed).catch((error: unknown) => {
      console.warn("Conn could not apply the attached set.", error);
    });
  };

  const environmentsOnce = async (): Promise<void> => {
    const current = providerRuns.begin();
    try {
      const listed = await reconcileEnvironmentProvider(client);
      if (!current()) return;
      const { provider } = useEnvironmentProvider.getState();
      // Everything syncs only while Orbit provides the environments.
      if (provider !== "orbit") {
        lastMe = null;
        lastListed = null;
        bindSidebarHiddenProfile("off");
        useOrbitProfileSyncStatus.setState(INITIAL_STATUS);
        await clearAttachedServers();
        return;
      }
      pruneWorkspaceCloneRefs(provider, listed);
      if (listed !== null) classifySidebarEnvironments(listed.map((entry) => entry.environmentId));
      lastListed = listed;
      if (listed !== null && lastMe !== null) {
        // A later profile read or a switch away from Orbit makes this answer obsolete.
        const me = lastMe;
        await recordAttached(
          me,
          listed,
          scopedClient(() => inOrbit() && lastMe === me),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useOrbitProfileSyncStatus.setState((status) => ({
        ...status,
        phase: "error",
        error: message,
      }));
    }
  };

  /** One authoritative profile read and write-back; applies nothing once `isCurrent()` is false. */
  const profileOnce = async (
    isCurrent: () => boolean,
    observe: (channel: string | null) => void,
  ): Promise<ProfileBinding | null> => {
    if (!inOrbit()) return null;
    let me: OrbitGatewayNode;
    try {
      me = await client.me();
    } catch (error) {
      if (isCurrent()) {
        useOrbitProfileSyncStatus.setState((status) => ({
          ...status,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      throw error;
    }
    if (!isCurrent() || !inOrbit()) return null;
    observe(me.profileChannel ?? null);
    lastMe = me;
    // Conn: the sidebar's marks first, so rows the profile hides do not wait for other writes.
    bindSidebarHiddenProfile(me.profile?.id ?? null);
    const channel = me.profile ? sidebarHiddenThreadsChannel(me.profile.id) : null;
    hiddenThreadsChannel = channel;
    /** The document version the hidden-threads section counts as applied; -1 after a failure. */
    let hiddenApplied = Number.POSITIVE_INFINITY;
    const hiddenThreadsError = await hiddenThreads.run(me, isCurrent).then(
      (synced) => {
        if (synced.kind === "synced" || synced.kind === "idle") hiddenApplied = synced.version;
        return channel?.overflow()?.message ?? null;
      },
      (error: unknown) => {
        hiddenApplied = -1;
        return error instanceof Error ? error.message : String(error);
      },
    );
    // A refused hide waits out its cooldown; without the old poll, this read wakes for the retry.
    clearTimeout(hiddenRetryTimer);
    if (hiddenThreadsError !== null && hiddenThreads.hasLocalChanges()) {
      hiddenRetryTimer = setTimeout(() => {
        // Not for a binding or scope this read no longer belongs to.
        if (isCurrent()) void controller?.profile.reconcile();
      }, PROFILE_REJECTED_RETRY_MS + 1_000);
    }
    if (!isCurrent()) return null;
    useOrbitProfileSyncStatus.setState({ hiddenThreadsError });
    // An obsolete read never reaches the settings read, so it records no attached set.
    if (lastListed !== null) await recordAttached(me, lastListed, scopedClient(isCurrent));
    if (!isCurrent()) return null;
    try {
      const result = await syncWorkspaceProfile(workspacePorts(isCurrent), me);
      if (!isCurrent()) return null;
      useOrbitProfileSyncStatus.setState(
        result.kind === "unbound"
          ? { phase: "unbound", profileName: null, error: null, syncedAt: Date.now() }
          : {
              phase: "synced",
              profileName: result.profileName,
              error: null,
              syncedAt: Date.now(),
            },
      );
      if (result.kind === "unbound" || me.profile === null) return null;
    } catch (error) {
      if (!isCurrent()) return null;
      useOrbitProfileSyncStatus.setState((status) => ({
        ...status,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
    // A failure in the sections must not hide that the workspaces synced.
    let applied = Math.min(me.profile.settingsVersion, hiddenApplied);
    try {
      const synced = await sections.run(me, isCurrent);
      // A section the engine could not apply yet keeps the version it counts as read.
      if (synced.kind === "synced" || synced.kind === "idle") {
        applied = Math.min(applied, synced.version);
      }
      if (synced.kind === "superseded") return null;
      if (synced.kind === "unsupported") {
        useOrbitProfileSyncStatus.setState({ sections: "unsupported", sectionsError: null });
      } else if (synced.kind === "synced") {
        useOrbitProfileSyncStatus.setState({ sections: "supported", sectionsError: null });
      }
    } catch (error) {
      if (!isCurrent()) return null;
      useOrbitProfileSyncStatus.setState({
        sectionsError: error instanceof Error ? error.message : String(error),
      });
      // Not applied in full: the reconciler retries rather than count this version as read.
      throw error;
    }
    // An edit during this read can end equal to the old base (A, B, A while a PATCH is in
    // flight), so its debounce saw nothing; the read's answer made it dirty: send it now.
    // One follow-up at most, so a value that never settles cannot keep reading.
    if (isCurrent() && !followUpQueued && controller?.hasLocalChanges()) {
      followUpQueued = true;
      void controller.profile.reconcile();
    } else {
      followUpQueued = false;
    }
    return {
      profileId: me.profile.id,
      version: applied,
      channel: me.profileChannel ?? null,
    };
  };

  controller = {
    refreshEnvironments: createSerialRunner(() => exclusive(environmentsOnce)),
    profile: createOrbitProfileLive({
      transport,
      // Held while another window binds, so no read can apply the binding it leaves.
      scope: () => (inOrbit() && heldBinds.size === 0 ? "orbit" : null),
      refresh: (isCurrent, observe) =>
        exclusive(async () => {
          profileReads += 1;
          try {
            return await profileOnce(isCurrent, observe);
          } finally {
            profileReads -= 1;
          }
        }),
    }),
    editNeedsRead: () => profileReads > 0 || controller?.hasLocalChanges() === true,
    hasLocalChanges: () =>
      hasWorkspaceChanges({
        readLocal: () => useWorkspaceStore.getState().workspaces.map(toGateway),
        loadState,
      }) ||
      sections.hasLocalChanges() ||
      hiddenThreads.hasLocalChanges(),
    rebinding: (phase) => {
      // An environment run waiting on the old profile's settings fails its `lastMe` check.
      lastMe = null;
      clearTimeout(hiddenRetryTimer);
      controller?.profile.invalidate();
      if (phase === "after" && heldBinds.size === 0) void controller?.profile.reconcile();
    },
    otherWindowRebinding: (phase, id) => {
      clearTimeout(heldBinds.get(id));
      heldBinds.delete(id);
      if (phase === "before") {
        // A bind that never reports back releases its hold on its own.
        heldBinds.set(
          id,
          setTimeout(() => controller?.otherWindowRebinding("after", id), 60_000),
        );
      }
      controller?.rebinding(phase);
    },
    beginNonUserChange: sections.beginNonUserChange,
  };
  return controller;
}

/**
 * Applies the environment provider and, in Orbit mode, syncs workspaces, appearance and desktop
 * settings with the Orbit profile. Mounted once, in the main desktop window; the sync engine is a
 * module singleton, so a second mount adds only triggers.
 */
export function OrbitProfileSync() {
  const available = !!window.desktopBridge?.orbitGatewaySend;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the profile sync to store changes, focus, network and the environment timer while mounted
  useEffect(() => {
    const sync = profileSyncController();
    if (!sync) return;
    const refreshEnvironments = (): void => void sync.refreshEnvironments();
    const reconcileProfile = (): void => void sync.profile.reconcile();
    const refreshAll = (): void => {
      refreshEnvironments();
      reconcileProfile();
    };

    const unsubscribeProvider = useEnvironmentProvider.subscribe((state, previous) => {
      if (state.provider !== previous.provider) refreshAll();
    });
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEditSync = (): void => {
      if (editTimer) clearTimeout(editTimer);
      // Applying the profile's own change also lands here: read only for a real local edit.
      editTimer = setTimeout(() => {
        if (sync.editNeedsRead()) reconcileProfile();
      }, LOCAL_EDIT_DEBOUNCE_MS);
    };
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (state.workspaces !== previous.workspaces) scheduleEditSync();
    });
    const unsubscribeLocalChange = onLocalProfileChange(scheduleEditSync);
    // Conn: a server that starts refusing this device's credential is renewed now, not at the
    // next poll.
    const unsubscribeRefused = onOrbitCredentialRefused(refreshEnvironments);
    // A theme the environment pushed is not the user's pick: it stays on this device.
    const unsubscribeDefaultTheme = trackNonUserThemeChanges(() =>
      sync.beginNonUserChange(APPEARANCE_SECTION),
    );
    requestSync = () => sync.profile.reconcile();
    beforeRebind = sync.rebinding;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      if (document.hasFocus() || ticks % (BACKGROUND_PROBE_MS / FOCUSED_PROBE_MS) === 0) {
        refreshEnvironments();
      }
    }, FOCUSED_PROBE_MS);
    // Lifecycle: focus and a network that comes back read the profile again; the shared
    // subscription keeps its own low-frequency check against dropped notices.
    window.addEventListener("focus", refreshAll);
    window.addEventListener("online", refreshAll);
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== REBIND_STORAGE_KEY || event.newValue === null) return;
      const [phase, id] = event.newValue.split(":");
      if ((phase === "before" || phase === "after") && id) sync.otherWindowRebinding(phase, id);
    };
    window.addEventListener("storage", onStorage);
    refreshEnvironments();
    void sync.profile.resume();

    return () => {
      requestSync = null;
      beforeRebind = null;
      sync.profile.pause();
      unsubscribeProvider();
      unsubscribe();
      unsubscribeLocalChange();
      unsubscribeRefused();
      unsubscribeDefaultTheme();
      clearInterval(interval);
      if (editTimer) clearTimeout(editTimer);
      window.removeEventListener("focus", refreshAll);
      window.removeEventListener("online", refreshAll);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return available ? <OrbitAppearanceSync /> : null;
}
