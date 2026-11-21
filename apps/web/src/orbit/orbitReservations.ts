import {
  createOrbitGatewayClient,
  createOrbitReservations,
  dismissedOrbitReservationIds,
  type OrbitReservations,
  type TakenOrbitReservation,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isAdditionalDesktopWindow } from "../lib/desktopWindowContext";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { desktopOrbitGatewayTransport } from "./desktopOrbitGateway";
import { recordOrbitPaired, useEnvironmentProvider } from "./environmentProvider";
import { readStored, useOrbitThreadStarts } from "./orbitThreadStartStore";
import { connectOrbitClone, isOrbitServerSaved } from "./orbitThreadStarts";

/**
 * Conn: the main window reserves a clone while the prompt box of a new Instance is open
 * (`createOrbitReservations`); other windows start as before.
 */
const OPEN_KEY = "conn:orbit-reservations:v1";

function readStoredIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredIds(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage off: the reservations stay held in memory; Orbit expires them after 10 minutes.
  }
}

async function settlePairing(environmentId: string, installId: string, keep: boolean) {
  const result = await runAtomCommand(
    appAtomRegistry,
    environmentCatalog.settleProvisionalPairing,
    { environmentId: environmentId as EnvironmentId, installId, keep },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

let manager: OrbitReservations | null = null;

export function getOrbitReservations(): OrbitReservations | null {
  if (manager !== null) return manager;
  const transport = isAdditionalDesktopWindow() ? null : desktopOrbitGatewayTransport();
  if (transport === null) return null;
  const created = createOrbitReservations({
    client: createOrbitGatewayClient(transport),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    isSaved: isOrbitServerSaved,
    connect: connectOrbitClone,
    hasTakenStart: (reservationId) =>
      readStored().some((row) => row.reservationId === reservationId && row.environmentId === null),
    forget: async (environmentId, installId) => {
      await settlePairing(environmentId, installId, false);
    },
    promote: async (environmentId, installId) => {
      if (await settlePairing(environmentId, installId, true)) recordOrbitPaired(environmentId);
    },
    load: () => readStoredIds(OPEN_KEY),
    store: (ids) => writeStoredIds(OPEN_KEY, ids),
    newKey: () => `conn-reservation:${randomUUID()}`,
  });
  manager = created;
  useOrbitThreadStarts.subscribe(({ starts }, previous) => {
    for (const id of dismissedOrbitReservationIds(previous.starts, starts)) {
      void created.abandon(id);
    }
  });
  // A restart leaves no prompt box open: release what the last run held.
  void created.releaseLeftovers();
  window.addEventListener("pagehide", () => created.closeAll());
  return created;
}

/** The send of a new Instance: the Project's reservation, or null to create as before. */
export function takeOrbitReservation(projectId: number): TakenOrbitReservation | null {
  return manager?.take(projectId) ?? null;
}

/**
 * Holds a reservation while the prompt box of a new Instance in the Project shows; null holds
 * none. Leaving the prompt box without a send releases it.
 */
export function useOrbitReservation(projectId: number | null): void {
  const orbit = useEnvironmentProvider((store) => store.provider === "orbit");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a Gateway reservation while the prompt box shows
  useEffect(() => {
    if (projectId === null || !orbit) return;
    const current = getOrbitReservations();
    if (current === null) return;
    current.open(projectId);
    return () => current.close(projectId);
  }, [orbit, projectId]);
}
