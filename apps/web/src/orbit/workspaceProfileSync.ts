import {
  mergeWorkspaces,
  OrbitGatewayError,
  sameWorkspaces,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewayClient,
  type OrbitGatewayNode,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Schema from "effect/Schema";

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/**
 * Syncs the workspace list (not the selection) with the Orbit profile. `state` holds the version
 * and list this device last agreed on: a differing local list is unsent edits, a differing profile
 * version is another device's edits, and both at once merge with mergeWorkspaces.
 */

export interface WorkspaceProfileSyncState {
  readonly profileId: number;
  readonly version: number;
  readonly base: readonly OrbitGatewayWorkspace[];
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGatewayWorkspace(value: unknown): value is OrbitGatewayWorkspace {
  if (typeof value !== "object" || value === null) return false;
  const workspace = value as Record<string, unknown>;
  return (
    typeof workspace.id === "string" &&
    typeof workspace.name === "string" &&
    typeof workspace.color === "string" &&
    (workspace.icon === null || typeof workspace.icon === "string") &&
    (workspace.image === undefined ||
      workspace.image === null ||
      typeof workspace.image === "string") &&
    (workspace.projectRefs === undefined || isStringArray(workspace.projectRefs)) &&
    (workspace.projectKeys === undefined || isStringArray(workspace.projectKeys))
  );
}

/**
 * Reads a stored sync snapshot. Anything of the wrong shape is null, so the next run is a first
 * sync instead of a merge against a `base` this device never agreed on.
 */
export function parseWorkspaceProfileSyncState(value: unknown): WorkspaceProfileSyncState | null {
  if (typeof value !== "object" || value === null) return null;
  const { profileId, version, base } = value as Record<string, unknown>;
  if (typeof profileId !== "number" || typeof version !== "number") return null;
  if (!Array.isArray(base) || !base.every(isGatewayWorkspace)) return null;
  return { profileId, version, base };
}

export interface WorkspaceProfileSyncPorts {
  readonly client: OrbitGatewayClient;
  readonly readLocal: () => readonly OrbitGatewayWorkspace[];
  readonly writeLocal: (workspaces: readonly OrbitGatewayWorkspace[]) => void;
  readonly loadState: () => WorkspaceProfileSyncState | null;
  readonly saveState: (state: WorkspaceProfileSyncState | null) => void;
}

export type WorkspaceProfileSyncResult =
  | { readonly kind: "unbound" }
  | { readonly kind: "unchanged"; readonly profileName: string }
  | { readonly kind: "pulled"; readonly profileName: string }
  | { readonly kind: "pushed"; readonly profileName: string }
  | { readonly kind: "merged"; readonly profileName: string };

/** Attempts at a replace before giving up on a run, when other devices keep writing in between. */
const MAX_REPLACE_ATTEMPTS = 3;

/** `knownMe` is the caller's node when the caller just read it, so one run probes the Gateway once. */
export async function syncWorkspaceProfile(
  ports: WorkspaceProfileSyncPorts,
  knownMe?: OrbitGatewayNode,
): Promise<WorkspaceProfileSyncResult> {
  const me = knownMe ?? (await ports.client.me());
  if (me.profile === null) {
    ports.saveState(null);
    return { kind: "unbound" };
  }
  const { id: profileId, name: profileName } = me.profile;
  const state = ports.loadState();
  const local = ports.readLocal();

  if (state === null || state.profileId !== profileId) {
    // First sync with this profile. An empty profile takes this device's workspaces; otherwise the
    // profile's list replaces the local one, as when a second device joins.
    const remote = await ports.client.settings(profileId);
    if (remote.workspaces.length === 0 && local.length > 0) {
      const saved = await replace(ports, profileId, remote.version, [], local);
      return { kind: saved.merged ? "merged" : "pushed", profileName };
    }
    adopt(ports, profileId, remote.version, remote.workspaces);
    return sameWorkspaces(local, remote.workspaces)
      ? { kind: "unchanged", profileName }
      : { kind: "pulled", profileName };
  }

  const dirty = !sameWorkspaces(local, state.base);
  const remoteChanged = me.profile.settingsVersion !== state.version;
  if (!dirty && !remoteChanged) return { kind: "unchanged", profileName };
  if (!dirty) {
    const remote = await ports.client.settings(profileId);
    const edited = ports.readLocal();
    if (!sameWorkspaces(edited, local) && !sameWorkspaces(edited, remote.workspaces)) {
      // The user edited during the read: send that edit against the base it started from, so
      // the version conflict merges it with the newer profile instead of overwriting it.
      const saved = await replace(ports, profileId, state.version, state.base, edited);
      return { kind: saved.merged ? "merged" : "pushed", profileName };
    }
    adopt(ports, profileId, remote.version, remote.workspaces);
    return { kind: "pulled", profileName };
  }
  const saved = await replace(ports, profileId, state.version, state.base, local);
  return { kind: saved.merged ? "merged" : "pushed", profileName };
}

/** Whether the device's workspaces differ from what it last synced (or it never synced). */
export function hasWorkspaceChanges(
  ports: Pick<WorkspaceProfileSyncPorts, "readLocal" | "loadState">,
): boolean {
  const state = ports.loadState();
  return state === null || !sameWorkspaces(ports.readLocal(), state.base);
}

function adopt(
  ports: WorkspaceProfileSyncPorts,
  profileId: number,
  version: number,
  workspaces: readonly OrbitGatewayWorkspace[],
): void {
  if (!sameWorkspaces(ports.readLocal(), workspaces)) ports.writeLocal(workspaces);
  ports.saveState({ profileId, version, base: workspaces });
}

/**
 * Sends `local`; on a version conflict merges it with the profile's newer list and tries again.
 * An edit the user makes during any request is merged on top, never overwritten by the answer.
 */
async function replace(
  ports: WorkspaceProfileSyncPorts,
  profileId: number,
  version: number,
  base: readonly OrbitGatewayWorkspace[],
  local: readonly OrbitGatewayWorkspace[],
): Promise<{ merged: boolean }> {
  let sendVersion = version;
  let sendBase = base;
  let candidate = local;
  let merged = false;
  /** The device list `candidate` already contains. */
  let sent = local;
  /** Version conflicts so far; an edit during a write is sent again without counting. */
  let conflicts = 0;
  for (;;) {
    const now = ports.readLocal();
    if (!sameWorkspaces(now, sent)) {
      candidate = mergeWorkspaces(sent, now, candidate);
      sent = now;
    }
    // After a conflict read: nothing left to send when the merge equals the profile's list.
    if (conflicts > 0 && sameWorkspaces(candidate, sendBase)) {
      adopt(ports, profileId, sendVersion, sendBase);
      return { merged };
    }
    try {
      const saved = await ports.client.replaceWorkspaces(profileId, sendVersion, candidate);
      const after = ports.readLocal();
      if (!sameWorkspaces(after, sent)) {
        // Edited while the write was in flight: keep that edit on top of what landed and send
        // it in this run, so a profile switch waiting on the run does not leave it behind. The
        // run ends once a write lands with no newer edit.
        const edited = mergeWorkspaces(sent, after, saved.workspaces);
        ports.writeLocal(edited);
        ports.saveState({ profileId, version: saved.version, base: saved.workspaces });
        candidate = edited;
        sent = ports.readLocal();
        sendBase = saved.workspaces;
        sendVersion = saved.version;
        continue;
      }
      adopt(ports, profileId, saved.version, saved.workspaces);
      return { merged };
    } catch (error) {
      if (
        !isOrbitGatewayError(error) ||
        error.code !== SETTINGS_VERSION_CONFLICT ||
        conflicts + 1 >= MAX_REPLACE_ATTEMPTS
      ) {
        throw error;
      }
      conflicts += 1;
      const remote = await ports.client.settings(profileId);
      candidate = mergeWorkspaces(sendBase, candidate, remote.workspaces);
      sendBase = remote.workspaces;
      sendVersion = remote.version;
      merged = true;
    }
  }
}
