import {
  listOrbitInstances,
  type OrbitInstanceListRow,
} from "@t3tools/client-runtime/orbit-gateway";
import { create } from "zustand";

import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import { loadOrbitThreadIndex } from "./orbitThreadIndex";

export type OrbitInstanceListState =
  | { readonly status: "loading" }
  | { readonly status: "unreachable" }
  | { readonly status: "loaded"; readonly rows: ReadonlyArray<OrbitInstanceListRow> };

export const useOrbitInstanceListStore = create<{
  readonly state: OrbitInstanceListState;
  readonly generation: number;
}>(() => ({ state: { status: "loading" }, generation: 0 }));

/**
 * Conn: the Orbit panel's Instances. A refresh keeps showing the last good list; a later answer
 * replaces an earlier one.
 */
export async function loadOrbitInstanceList(): Promise<void> {
  const { state, generation } = useOrbitInstanceListStore.getState();
  const current = generation + 1;
  useOrbitInstanceListStore.setState({
    generation: current,
    state: state.status === "loaded" ? state : { status: "loading" },
  });
  const client = desktopOrbitGatewayClient();
  // Conn (flag `connAttachedServers` only): the threads of held-off servers, read with the list.
  // Not awaited: the list never waits for the index.
  void loadOrbitThreadIndex(client).catch(() => {});
  let next: OrbitInstanceListState;
  try {
    if (client === null) throw new Error("The Orbit Gateway is not available here.");
    next = { status: "loaded", rows: await listOrbitInstances(client) };
  } catch {
    next = { status: "unreachable" };
  }
  if (useOrbitInstanceListStore.getState().generation === current) {
    useOrbitInstanceListStore.setState({ state: next });
  }
}
