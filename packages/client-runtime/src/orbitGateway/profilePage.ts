// @effect-diagnostics globalDate:off - The page reads the wall clock for "Last synced", outside an Effect runtime.
import type { OrbitGatewayClient, OrbitGatewayNode } from "./client.ts";

/**
 * The Orbit profile page's logic, shared by the clients: switching a device to a profile and what
 * the page says about the sync. A profile is one set of settings; there is nothing to choose per
 * part and nothing to resolve.
 */

export type OrbitProfileChoice = { readonly id: number } | { readonly name: string };

export interface OrbitProfileSwitchPorts {
  readonly client: Pick<OrbitGatewayClient, "createProfile" | "bindProfile">;
  /** Runs the profile sync and settles once that run has finished. */
  readonly sync: () => Promise<void>;
  /**
   * `before` the bind and `after` it answered (also when it failed): the old binding's channel
   * and any read started in between must not apply to the new one.
   */
  readonly rebinding?: (phase: "before" | "after") => void;
}

/**
 * Moves this device to another profile, or to a new one by name. Unsent edits go to the profile
 * the device leaves first, so they stay there; then the sync copies the chosen profile's
 * settings to this device. A new profile starts with what this device has.
 */
export async function switchOrbitProfile(
  ports: OrbitProfileSwitchPorts,
  choice: OrbitProfileChoice,
): Promise<OrbitGatewayNode> {
  await ports.sync();
  const id = "id" in choice ? choice.id : (await ports.client.createProfile(choice.name)).id;
  ports.rebinding?.("before");
  let node: OrbitGatewayNode;
  try {
    node = await ports.client.bindProfile(id);
  } catch (error) {
    // The old binding still holds: follow it again before the caller shows the error.
    ports.rebinding?.("after");
    await ports.sync();
    throw error;
  }
  ports.rebinding?.("after");
  await ports.sync();
  return node;
}

/** The name for a new profile, or null while it is blank. */
export function newOrbitProfileName(input: string): string | null {
  const name = input.trim();
  return name === "" ? null : name;
}

export const ORBIT_PROFILE_PARTS = [
  {
    key: "workspaces",
    label: "Workspaces",
    description: "Your workspaces and their projects.",
  },
  {
    key: "appearance",
    label: "Appearance",
    description: "Theme, light or dark mode, contrast and custom themes.",
  },
  {
    key: "desktop",
    label: "Desktop settings",
    description:
      "Fonts, text sizes, chat width, glass, motion, diff and timestamp options. Phones keep their own.",
  },
] as const;
export type OrbitProfilePart = (typeof ORBIT_PROFILE_PARTS)[number]["key"];

export interface OrbitProfileSyncView {
  readonly phase: "off" | "unbound" | "synced" | "error";
  readonly error: string | null;
  readonly syncedAt: number | null;
  /** Appearance and desktop settings; "unsupported" is a Gateway that predates profile sections. */
  readonly sections: "unknown" | "supported" | "unsupported";
  readonly sectionsError: string | null;
  /** Conn: the hidden sidebar threads' own sync. */
  readonly hiddenThreadsError?: string | null;
}

export interface OrbitProfileSummary {
  readonly description: string;
  /** A failure of the appearance and desktop settings while the workspaces still sync. */
  readonly problem: string | null;
  readonly synced: Readonly<Record<OrbitProfilePart, boolean>>;
}

function relativeSyncTime(at: number | null, now: number): string {
  if (at === null) return "not yet";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export function orbitProfileSummary(
  view: OrbitProfileSyncView,
  profileName: string | null,
  now: number = Date.now(),
): OrbitProfileSummary {
  const workspaces = profileName !== null && view.phase === "synced";
  const settings = workspaces && view.sections === "supported" && view.sectionsError === null;
  const description =
    view.phase === "error"
      ? (view.error ?? "Sync failed.")
      : profileName === null
        ? "Choose a profile to sync workspaces, appearance and settings."
        : view.sections === "unsupported"
          ? `Gateway doesn't support profile sync yet. Workspaces still sync with ${profileName}.`
          : view.phase === "synced"
            ? `Synced with ${profileName}. Last synced ${relativeSyncTime(view.syncedAt, now)}.`
            : "Waiting for the first sync.";
  return {
    description,
    problem:
      profileName === null || view.phase === "error"
        ? null
        : view.sectionsError !== null
          ? `Appearance and settings: ${view.sectionsError}`
          : view.hiddenThreadsError
            ? `Hidden sidebar threads: ${view.hiddenThreadsError}`
            : null,
    synced: { workspaces, appearance: settings, desktop: settings },
  };
}
