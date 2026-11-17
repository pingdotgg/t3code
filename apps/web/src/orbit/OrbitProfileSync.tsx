import {
  APPEARANCE_SECTION,
  createOrbitGatewayClient,
  createProfileSync,
  type OrbitGatewayClient,
  type OrbitGatewayWorkspace,
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
import { createSerialRunner } from "./serialRunner";
import { trackNonUserThemeChanges } from "./themeOrigin";
import {
  parseWorkspaceProfileSyncState,
  syncWorkspaceProfile,
  type WorkspaceProfileSyncPorts,
  type WorkspaceProfileSyncState,
} from "./workspaceProfileSync";

const STATE_STORAGE_KEY = "t3code:orbit-profile-sync:v1";
/** Probe cadence: GET /me about every 15 s while the window has focus, every 30 s otherwise. */
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

/**
 * Runs the profile sync now and settles once a run that started after this call has finished, so
 * a profile switch first sends this device's unsent edits to the profile it leaves. A no-op
 * outside the desktop app.
 */
export function syncOrbitProfileNow(): Promise<void> {
  return requestSync?.() ?? Promise.resolve();
}

// Conn: every window's sleep controller reads the Gateway through this window's client.
registerOrbitSleepClient(() => desktopOrbitGatewayClient());
// Conn: every window applies the attached set the main window stores (flag `connAttachedServers`).
watchAttachedServersRecord();

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

function writeLocal(workspaces: readonly OrbitGatewayWorkspace[]): void {
  const next = workspaces.map(toLocal);
  useWorkspaceStore.setState((state) => ({
    workspaces: next,
    activeWorkspaceId: next.some((workspace) => workspace.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : null,
  }));
}

interface ProfileSyncController {
  readonly trigger: () => Promise<void>;
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
  const client = desktopOrbitGatewayClient();
  if (!client) return null;
  forgetRemovedProfileSyncKeys();
  const ports: WorkspaceProfileSyncPorts = {
    client,
    readLocal: () => useWorkspaceStore.getState().workspaces.map(toGateway),
    writeLocal,
    loadState,
    saveState,
  };
  const sections = createProfileSync({
    client,
    channels: getProfileSyncChannels,
    loadState: loadSectionState,
    saveState: saveSectionState,
  });

  const runOnce = async (): Promise<void> => {
    try {
      const listed = await reconcileEnvironmentProvider(client);
      const { provider } = useEnvironmentProvider.getState();
      // Everything syncs only while Orbit provides the environments.
      if (provider !== "orbit") {
        useOrbitProfileSyncStatus.setState(INITIAL_STATUS);
        await clearAttachedServers();
        return;
      }
      pruneWorkspaceCloneRefs(provider, listed);
      const me = await client.me();
      // Conn: flag `connAttachedServers` only; a failure here must not stop the sync.
      if (listed !== null) {
        await recordAttachedServers(client, me, listed).catch((error: unknown) => {
          console.warn("Conn could not apply the attached set.", error);
        });
      }
      const result = await syncWorkspaceProfile(ports, me);
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
      if (result.kind === "unbound") return;
      // A failure in the sections must not hide that the workspaces synced.
      try {
        const synced = await sections.run(me);
        if (synced.kind === "unsupported") {
          useOrbitProfileSyncStatus.setState({ sections: "unsupported", sectionsError: null });
        } else if (synced.kind === "synced") {
          useOrbitProfileSyncStatus.setState({ sections: "supported", sectionsError: null });
        }
      } catch (error) {
        useOrbitProfileSyncStatus.setState({
          sectionsError: error instanceof Error ? error.message : String(error),
        });
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

  controller = {
    trigger: createSerialRunner(runOnce),
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the profile sync engine to store changes, focus and a poll timer while mounted
  useEffect(() => {
    const sync = profileSyncController();
    if (!sync) return;
    const run = (): void => void sync.trigger();

    const unsubscribeProvider = useEnvironmentProvider.subscribe((state, previous) => {
      if (state.provider !== previous.provider) run();
    });
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEditSync = (): void => {
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(run, LOCAL_EDIT_DEBOUNCE_MS);
    };
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (state.workspaces !== previous.workspaces) scheduleEditSync();
    });
    const unsubscribeLocalChange = onLocalProfileChange(scheduleEditSync);
    // Conn: a server that starts refusing this device's credential is renewed now, not at the
    // next poll.
    const unsubscribeRefused = onOrbitCredentialRefused(run);
    // A theme the environment pushed is not the user's pick: it stays on this device.
    const unsubscribeDefaultTheme = trackNonUserThemeChanges(() =>
      sync.beginNonUserChange(APPEARANCE_SECTION),
    );
    requestSync = sync.trigger;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      if (document.hasFocus() || ticks % (BACKGROUND_PROBE_MS / FOCUSED_PROBE_MS) === 0) run();
    }, FOCUSED_PROBE_MS);
    window.addEventListener("focus", run);
    run();

    return () => {
      requestSync = null;
      unsubscribeProvider();
      unsubscribe();
      unsubscribeLocalChange();
      unsubscribeRefused();
      unsubscribeDefaultTheme();
      clearInterval(interval);
      if (editTimer) clearTimeout(editTimer);
      window.removeEventListener("focus", run);
    };
  }, []);
  return available ? <OrbitAppearanceSync /> : null;
}
