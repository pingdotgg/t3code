import {
  EMPTY_ORBIT_THREAD_INDEX_STATE,
  nextOrbitThreadIndexState,
  orbitThreadInputsWithIndex,
  readOrbitThreadIndex,
  type OrbitGatewayClient,
  type OrbitInstanceThreadInput,
  type OrbitThreadIndexState,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readAttachedServersFlag } from "./attachedServersSeed";

/**
 * Conn (thread-index plan, C3), flag `connAttachedServers`: the Orbit list's threads of servers
 * this window holds off, from the Gateway's index. Read with the list (page open, Reload), never on
 * a timer of its own. Flag off: no read, no Gateway call, the store stays empty.
 */

export interface OrbitThreadIndexStore {
  readonly index: OrbitThreadIndexState;
  /** Environments that hold a park reason in this window's registry, as last read. */
  readonly held: ReadonlySet<string>;
}

export const useOrbitThreadIndexStore = create<OrbitThreadIndexStore>(() => ({
  index: EMPTY_ORBIT_THREAD_INDEX_STATE,
  held: new Set(),
}));

export interface OrbitThreadIndexPorts {
  readonly enabled: () => boolean;
  /** The environments with at least one park reason now. */
  readonly heldNow: () => Promise<ReadonlySet<string>>;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

export function createOrbitThreadIndex(ports: OrbitThreadIndexPorts) {
  // Only the newest load writes; an older answer could still change which servers are listed.
  let generation = 0;
  /** Re-reads which servers are held off; with the flag off it forgets them. */
  const refreshHeld = async (): Promise<ReadonlySet<string>> => {
    const held = ports.enabled() ? await ports.heldNow() : new Set<string>();
    if (!sameSet(useOrbitThreadIndexStore.getState().held, held)) {
      useOrbitThreadIndexStore.setState({ held });
    }
    return held;
  };

  /** One index read beside the list read. Flag off or nothing held: no call. */
  const load = async (client: Pick<OrbitGatewayClient, "threads"> | null): Promise<void> => {
    if (!ports.enabled()) {
      if (useOrbitThreadIndexStore.getState().held.size > 0) await refreshHeld();
      return;
    }
    const mine = ++generation;
    const held = await refreshHeld();
    if (client === null) return;
    const answer = await readOrbitThreadIndex({
      enabled: true,
      held,
      threads: () => client.threads(),
    });
    if (mine !== generation) return;
    // Merged into the state as it is now, so the `read_at` check runs against the kept rows.
    const current = useOrbitThreadIndexStore.getState().index;
    const index = nextOrbitThreadIndexState(current, answer);
    if (index !== current) useOrbitThreadIndexStore.setState({ index });
  };

  return { load, refreshHeld };
}

let appIndex: ReturnType<typeof createOrbitThreadIndex> | null = null;

function appOrbitThreadIndex(): ReturnType<typeof createOrbitThreadIndex> {
  appIndex ??= createOrbitThreadIndex({
    enabled: readAttachedServersFlag,
    heldNow: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.parkReasons,
        undefined,
        { reportFailure: false },
      );
      const held = new Set<string>();
      if (result._tag !== "Success") return held;
      for (const [environmentId, reasons] of result.value) {
        if (reasons.size > 0) held.add(environmentId);
      }
      return held;
    },
  });
  return appIndex;
}

/** With the Orbit list's read: the index of held-off servers (flag on only). */
export async function loadOrbitThreadIndex(
  client: Pick<OrbitGatewayClient, "threads"> | null,
): Promise<void> {
  await appOrbitThreadIndex().load(client);
}

/** After a park reason changed in this window: which servers the list shows from the index. */
export async function refreshOrbitThreadIndexHeld(): Promise<void> {
  await appOrbitThreadIndex().refreshHeld();
}

/**
 * The Orbit list's threads: `live` itself with the flag off; with it on, held-off servers from the
 * index (`orbitThreadInputsWithIndex`).
 */
export function orbitListThreadInputs(
  live: readonly OrbitInstanceThreadInput[],
  store: OrbitThreadIndexStore,
  enabled: boolean,
): readonly OrbitInstanceThreadInput[] {
  return orbitThreadInputsWithIndex({ enabled, live, index: store.index, held: store.held });
}
