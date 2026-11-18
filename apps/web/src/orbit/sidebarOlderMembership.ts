import type { OlderSettled } from "@t3tools/client-runtime/state/threads";
import { isOlderSettledThreadShell } from "@t3tools/contracts";
import { create } from "zustand";

import { readSidebarThreadInventory } from "./sidebarInventory";

interface OlderMembership {
  /** The cut the rows were read for; a new cut needs a new read. */
  readonly older: OlderSettled;
  readonly rows: ReadonlyArray<{ readonly id: string; readonly projectId: string }>;
}

/**
 * Conn: older settled rows of environments whose hidden marks might cover every unloaded older
 * thread of a project, from one full read each. The project list and scope menu wait for it.
 */
export const useSidebarOlderMembership = create<{
  readonly byEnvironment: ReadonlyMap<string, OlderMembership>;
  /** The read in flight per environment, retrying after failures. */
  readonly reading: ReadonlyMap<string, { readonly older: OlderSettled }>;
}>(() => ({ byEnvironment: new Map(), reading: new Map() }));

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** Retains inventory reads only while the sidebar still needs them. */
export function syncSidebarOlderMembership(
  requests: ReadonlyArray<{ readonly environmentId: string; readonly older: OlderSettled }>,
): void {
  const store = useSidebarOlderMembership;
  const { reading } = store.getState();
  const wanted = new Map(requests.map(({ environmentId, older }) => [environmentId, older]));
  const needed = new Map(reading);
  for (const [environmentId, request] of reading) {
    if (wanted.get(environmentId) !== request.older) needed.delete(environmentId);
  }
  if (needed.size !== reading.size) store.setState({ reading: needed });
  for (const [environmentId, older] of wanted) readOlderMembership(environmentId, older);
}

function readOlderMembership(environmentId: string, older: OlderSettled): void {
  const store = useSidebarOlderMembership;
  const state = store.getState();
  if (state.reading.has(environmentId)) return;
  if (state.byEnvironment.get(environmentId)?.older === older) return;
  const token = { older };
  store.setState({ reading: new Map(state.reading).set(environmentId, token) });
  const current = () => store.getState().reading.get(environmentId) === token;
  let failures = 0;
  const read = async (): Promise<void> => {
    if (!current()) return;
    const threads = await readSidebarThreadInventory(environmentId).catch(() => null);
    if (!current()) return;
    if (threads === null) {
      setTimeout(() => void read(), RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
      failures += 1;
      return;
    }
    const rows = threads.flatMap((thread) =>
      isOlderSettledThreadShell(thread, older.beforeMs)
        ? [{ id: String(thread.id), projectId: String(thread.projectId) }]
        : [],
    );
    const { byEnvironment, reading } = store.getState();
    const nextReading = new Map(reading);
    nextReading.delete(environmentId);
    store.setState({
      byEnvironment: new Map(byEnvironment).set(environmentId, { older, rows }),
      reading: nextReading,
    });
  };
  void read();
}
