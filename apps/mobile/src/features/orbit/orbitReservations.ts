import {
  createOrbitReservations,
  dismissedOrbitReservationIds,
  type OrbitReservations,
  type TakenOrbitReservation,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { writeFileAtomically } from "../../lib/atomic-file";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orbitGatewayClient } from "./orbitGatewayClient";
import { recordOrbitThreadStartPaired } from "./orbitGatewayStore";
import { orbitThreadStartStore } from "./orbitThreadStartStore";

/**
 * Conn: the phone reserves a clone while the Orbit project screen is open (`createOrbitReservations`)
 * and hides the servers of reserved clones in every list until they are finalized.
 */
const RESERVATIONS_FILE = "orbit-reservations.json";

async function reservationsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, RESERVATIONS_FILE);
}

/** The file is written in order; a failed write only means Orbit expires the reservation itself. */
let writing: Promise<void> = Promise.resolve();

async function settlePairing(environmentId: string, installId: string, keep: boolean) {
  const result = await runAtomCommand(
    appAtomRegistry,
    environmentCatalog.settleProvisionalPairing,
    { environmentId: EnvironmentId.make(environmentId), installId, keep },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/** Set by `connect` in the start runtime, which owns pairing on the phone. */
let connectClone:
  | ((environmentId: string, pairingUrl: string, installId: string) => Promise<void>)
  | null = null;

const isSaved = (environmentId: string) =>
  appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.has(EnvironmentId.make(environmentId));

export const orbitReservations: OrbitReservations = createOrbitReservations({
  client: orbitGatewayClient,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  isSaved,
  connect: async (environmentId, pairingUrl, installId) => {
    if (connectClone === null) throw new Error("Pairing is not ready.");
    await connectClone(environmentId, pairingUrl, installId);
  },
  hasTakenStart: (reservationId) =>
    orbitThreadStartStore
      .starts()
      .some((row) => row.reservationId === reservationId && row.environmentId === null),
  forget: async (environmentId, installId) => {
    await settlePairing(environmentId, installId, false);
  },
  promote: async (environmentId, installId) => {
    if (await settlePairing(environmentId, installId, true)) {
      await recordOrbitThreadStartPaired(environmentId);
    }
  },
  load: async () => {
    try {
      const file = await reservationsFile();
      const value: unknown = file.exists ? JSON.parse(await file.text()) : [];
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
  store: (ids) => {
    const text = JSON.stringify(ids);
    writing = writing
      .then(async () => writeFileAtomically(await reservationsFile(), text))
      .catch(() => {});
  },
  newKey: () => `conn-reservation:${uuidv4()}`,
});

/** Wires the reservations to the app: pairing, hidden servers, and a release of the last run's. */
export function installOrbitReservations(connect: NonNullable<typeof connectClone>): () => void {
  connectClone = connect;
  let previous = orbitThreadStartStore.starts();
  const unsubscribe = orbitThreadStartStore.subscribe(() => {
    const starts = orbitThreadStartStore.starts();
    const dismissed = dismissedOrbitReservationIds(previous, starts);
    previous = starts;
    for (const id of dismissed) void orbitReservations.abandon(id);
  });
  // A restart leaves no prompt open: release what the last run held.
  void orbitReservations.releaseLeftovers();
  return () => {
    unsubscribe();
    orbitReservations.closeAll();
  };
}

/** Start: the Project's reservation, or null to create as before. */
export function takeOrbitReservation(projectId: number): TakenOrbitReservation | null {
  return orbitReservations.take(projectId);
}

/** Holds a reservation while the screen shows the Project; null holds none. */
export function useOrbitReservation(projectId: number | null, enabled: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a Gateway reservation while the screen shows the Project
  useEffect(() => {
    if (projectId === null || !enabled) return;
    orbitReservations.open(projectId);
    return () => orbitReservations.close(projectId);
  }, [enabled, projectId]);
}
