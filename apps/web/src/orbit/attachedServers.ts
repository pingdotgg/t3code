import {
  ATTACHED_SERVERS_FLAG_KEY,
  planAttachedServers,
  type StoredAttachedServers,
} from "@t3tools/client-runtime/connection";
import {
  attachedServersNeedSettings,
  nextStoredAttachedServers,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { refreshOrbitThreadIndexHeld } from "./orbitThreadIndex";
import {
  ATTACHED_SERVERS_RECORD_KEY,
  loadAttachedServersRecord,
  readAttachedServersFlag,
  saveAttachedServersRecord,
} from "./attachedServersSeed";

/**
 * Conn, flag `connAttachedServers`: a container server connects only while an attached thread lives
 * on it. The main window's profile sync stores the set; every window applies it (storage event).
 * Flag off: nothing here reads, writes or calls anything.
 */

export interface AttachedServersPorts {
  readonly enabled: () => boolean;
  readonly load: () => StoredAttachedServers | null;
  readonly save: (record: StoredAttachedServers | null) => void;
  /** The environments that hold the `not-attached` reason now. */
  readonly heldNow: () => Promise<ReadonlySet<string>>;
  readonly setHeld: (environmentId: string, held: boolean) => Promise<void>;
}

export function createAttachedServers(ports: AttachedServersPorts) {
  let heldAny = false;
  // One registry change at a time, so two storage events cannot apply stale plans.
  let queue: Promise<void> = Promise.resolve();
  const serial = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };

  /** Brings the registry's `not-attached` reasons to the stored record. */
  const apply = (): Promise<void> =>
    serial(async () => {
      if (!ports.enabled()) return;
      const current = await ports.heldNow();
      const plan = planAttachedServers({ enabled: true, stored: ports.load(), current });
      // Release first, so a server that became attached connects before the others drop.
      for (const environmentId of plan.release) await ports.setHeld(environmentId, false);
      for (const environmentId of plan.hold) await ports.setHeld(environmentId, true);
      // Seeded holds count too: they are in `current`.
      heldAny = current.size - plan.release.length + plan.hold.length > 0;
    });

  /**
   * After a Gateway list read in Orbit mode: keeps the profile's attached set and the container
   * servers on the device and applies them. Reads the profile's settings only when its version
   * moved since the last read.
   */
  const record = async (
    client: Pick<OrbitGatewayClient, "settings">,
    me: OrbitGatewayNode,
    environments: readonly OrbitGatewayEnvironment[],
  ): Promise<void> => {
    if (!ports.enabled()) return;
    const profile = me.profile;
    if (profile === null) {
      // No profile, no attached set: nothing is held off.
      ports.save(null);
      await apply();
      return;
    }
    const previous = ports.load();
    const settings = attachedServersNeedSettings(previous, profile.id, profile.settingsVersion)
      ? await client.settings(profile.id)
      : null;
    ports.save(
      nextStoredAttachedServers({
        previous,
        profileId: profile.id,
        profileVersion: profile.settingsVersion,
        settings,
        environments,
      }),
    );
    await apply();
  };

  /** Outside Orbit mode no attached set applies. */
  const clear = async (): Promise<void> => {
    if (!ports.enabled()) return;
    if (ports.load() !== null) ports.save(null);
    await apply();
  };

  /** With the flag off, drops every `not-attached` reason (today's connections come back). */
  const releaseIfOff = async (): Promise<void> => {
    if (ports.enabled()) {
      await apply();
      return;
    }
    await serial(async () => {
      for (const environmentId of await ports.heldNow()) await ports.setHeld(environmentId, false);
      heldAny = false;
    });
  };

  /** Whether this window held a server off since its last release. */
  const heldAnything = (): boolean => heldAny;

  return { apply, record, clear, releaseIfOff, heldAnything };
}

let attachedServers: ReturnType<typeof createAttachedServers> | null = null;

function appAttachedServers(): ReturnType<typeof createAttachedServers> {
  attachedServers ??= createAttachedServers({
    enabled: readAttachedServersFlag,
    load: loadAttachedServersRecord,
    save: saveAttachedServersRecord,
    heldNow: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.parkReasons,
        undefined,
        {
          reportFailure: false,
        },
      );
      const held = new Set<string>();
      if (result._tag !== "Success") return held;
      for (const [environmentId, reasons] of result.value) {
        if (reasons.has("not-attached")) held.add(environmentId);
      }
      return held;
    },
    setHeld: async (environmentId, held) => {
      await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.setParkReason,
        { environmentId: environmentId as EnvironmentId, reason: "not-attached", held },
        { reportFailure: false },
      );
      // The Orbit list shows a held-off server from the index, a released one live (C3).
      await refreshOrbitThreadIndexHeld();
    },
  });
  return attachedServers;
}

export async function recordAttachedServers(
  client: Pick<OrbitGatewayClient, "settings">,
  me: OrbitGatewayNode,
  environments: readonly OrbitGatewayEnvironment[],
): Promise<void> {
  if (!readAttachedServersFlag()) return releaseAfterFlagOff();
  await appAttachedServers().record(client, me, environments);
}

export async function clearAttachedServers(): Promise<void> {
  if (!readAttachedServersFlag()) return releaseAfterFlagOff();
  await appAttachedServers().clear();
}

/** The flag went off in this window after it held servers: let them connect again. */
async function releaseAfterFlagOff(): Promise<void> {
  if (attachedServers?.heldAnything() === true) await attachedServers.releaseIfOff();
}

let storageWatched = false;
/** Another window of this app stored a new record: apply it to this window's registry. */
export function watchAttachedServersRecord(): void {
  if (storageWatched || typeof window === "undefined") return;
  storageWatched = true;
  window.addEventListener("storage", (event) => {
    if (event.key === ATTACHED_SERVERS_RECORD_KEY) void appAttachedServers().apply();
    // The flag switched off in another window: let every held-off server connect again.
    else if (event.key === ATTACHED_SERVERS_FLAG_KEY) void appAttachedServers().releaseIfOff();
  });
}
