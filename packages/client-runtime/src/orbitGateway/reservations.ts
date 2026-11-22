import * as Schema from "effect/Schema";

import { waitForOperationRead, type OrbitOperationNotices } from "./operationNotices.ts";
import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayPairing,
  type OrbitGatewayReservation,
} from "./client.ts";

/**
 * Conn: a clone reserved while the prompt box of a new Instance is open, paired once ready, taken
 * by the send (which finalizes it) or released on close. Nothing shows on screen: a reservation
 * that is not usable at send leaves the start to the normal create.
 */

/**
 * A preparing reservation is read at each notice of its create Operation over Reverb, or every
 * 500 ms without them; a ready one still without its pairing link every 500 ms (a read is cheap);
 * a paired one every 60 s so it stays held.
 */
export const RESERVATION_PREPARING_POLL_MS = 500;
export const RESERVATION_KEEPALIVE_MS = 60_000;
const PAIRING_CLEANUP_RETRY_MS = 2_000;
/**
 * How long ready reads may come without the Gateway's pairing link (it is minted after `ready`)
 * before the read that pairs explicitly.
 */
const ISSUED_PAIRING_WAIT_MS = 4_000;
/** Orbit holds at most 3 per caller and releases the oldest for a fourth; Conn does it first. */
export const MAX_OPEN_RESERVATIONS = 3;

export type OrbitReservationClient = Pick<
  OrbitGatewayClient,
  "reserve" | "reservation" | "releaseReservation" | "pair" | "operationNotices"
>;

export interface OrbitReservationPorts {
  readonly client: OrbitReservationClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Whether the device saved this server already. */
  readonly isSaved: (environmentId: string) => boolean;
  /** Opens a one-time pairing link and saves the server, as for any clone. */
  readonly connect: (environmentId: string, pairingUrl: string, installId: string) => Promise<void>;
  /** False if the start that took the reservation was dismissed. */
  readonly hasTakenStart?: (reservationId: string, environmentId: string) => boolean;
  /** Removes a released clone's saved server from the device. */
  readonly forget: (environmentId: string, installId: string) => Promise<void> | void;
  readonly promote: (environmentId: string, installId: string) => Promise<void> | void;
  /** The ids of reservations this device holds, kept across an app restart so the next start releases them. */
  readonly load: () => readonly string[] | Promise<readonly string[]>;
  readonly store: (reservationIds: readonly string[]) => void;
  /** A new Idempotency-Key for a reserve. */
  readonly newKey: () => string;
}

/** A reservation the send hands to the start, which finalizes it. */
export interface TakenOrbitReservation {
  readonly reservationId: string;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
}

type ReservationDetails = Omit<OrbitGatewayReservation, "pairing">;

interface Entry {
  readonly projectId: number;
  readonly openedAt: number;
  reservation: ReservationDetails | null;
  pending: Promise<void> | null;
  /** The device saved the clone's server for this reservation. */
  paired: boolean;
  /** When a ready read first came without the Gateway's pairing link (it is minted after `ready`). */
  readyWithoutPairingSince: number | null;
  /** Closed or taken: the loop stops; a reservation still being admitted is released when it arrives. */
  ended: "closed" | "taken" | null;
  /** The create Operation's notices while the reservation prepares. */
  notices: OrbitOperationNotices | null;
}

interface OwnedPairing {
  readonly environmentId: string;
  readonly installId: string;
  installing: Promise<void> | null;
  removing: Promise<void> | null;
  attempted: boolean;
  abandoned: boolean;
  retryScheduled: boolean;
}

export interface OrbitReservationPairing {
  readonly installPairing: (
    reservationId: string,
    environmentId: string,
    connect: (installId: string) => Promise<void>,
  ) => Promise<void>;
  readonly abandon: (reservationId: string) => Promise<void>;
  readonly commitPairing: (reservationId: string) => Promise<void>;
}

export interface OrbitReservations extends OrbitReservationPairing {
  /** The prompt box of a new Instance in the Project opened: reserve a clone (once per Project). */
  readonly open: (projectId: number) => void;
  /** The prompt box closed without a send: release the Project's reservation. */
  readonly close: (projectId: number) => void;
  /**
   * The send: hands over the Project's reservation, or null when it is not there (not admitted
   * yet, failed, expired, released by Orbit). The start then creates as before.
   */
  readonly take: (projectId: number) => TakenOrbitReservation | null;
  /** Finishes a read or install already in flight when the start took the reservation. */
  readonly waitForPairing: (reservationId: string) => Promise<void> | undefined;
  /** Releases what an earlier run of the app left open. */
  readonly releaseLeftovers: () => Promise<void>;
  /** The servers of reserved clones, which no list shows. */
  readonly hiddenEnvironmentIds: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Releases every open reservation (app quit). */
  readonly closeAll: () => void;
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** The reservation is no longer there for this caller. */
function isGone(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 404 || error.status === 410 || error.code.startsWith("reservation."))
  );
}

/** States a send can still finalize. */
const USABLE_STATES: ReadonlySet<OrbitGatewayReservation["state"]> = new Set([
  "preparing",
  "ready",
]);

/** The ready reads waited long enough for the Gateway's link: the start pairs explicitly. */
function waitedForIssuedPairing(entry: Entry, now: number): boolean {
  return (
    entry.readyWithoutPairingSince !== null &&
    now - entry.readyWithoutPairingSince >= ISSUED_PAIRING_WAIT_MS
  );
}

export function createOrbitReservations(ports: OrbitReservationPorts): OrbitReservations {
  const entries = new Map<number, Entry>();
  const handedOff = new Map<string, Promise<void>>();
  // A start row can disappear while its pairing is still being saved.
  const ownedPairings = new Map<string, OwnedPairing>();
  const releasing = new Map<string, Promise<number | null>>();
  const listeners = new Set<() => void>();
  let hidden: ReadonlySet<string> = new Set();

  const changed = () => {
    const next = new Set([...ownedPairings.values()].map((pairing) => pairing.environmentId));
    for (const entry of entries.values()) {
      const environmentId = entry.reservation?.environmentId;
      if (environmentId) next.add(environmentId);
    }
    const persisted = [...entries.values()].flatMap((entry) =>
      entry.reservation === null ? [] : [entry.reservation.id],
    );
    ports.store(persisted);
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return;
    hidden = next;
    for (const listener of listeners) listener();
  };

  const installPairing: OrbitReservationPairing["installPairing"] = async (
    reservationId,
    environmentId,
    connect,
  ) => {
    let pairing = ownedPairings.get(reservationId);
    if (
      releasing.has(reservationId) ||
      pairing?.abandoned ||
      (pairing && pairing.environmentId !== environmentId)
    )
      return;
    if (pairing?.installing) return pairing.installing;
    if (ports.isSaved(environmentId)) return;
    pairing ??= {
      environmentId,
      installId: ports.newKey(),
      installing: null,
      removing: null,
      attempted: false,
      abandoned: false,
      retryScheduled: false,
    };
    const owned = pairing;
    const installing = Promise.resolve().then(async () => {
      if (owned.abandoned || ports.isSaved(environmentId)) return;
      owned.attempted = true;
      await connect(owned.installId);
    });
    owned.installing = installing;
    ownedPairings.set(reservationId, owned);
    changed();
    try {
      await installing;
    } finally {
      owned.installing = null;
    }
  };

  const discardPairing = (reservationId: string): Promise<void> => {
    const pairing = ownedPairings.get(reservationId);
    if (!pairing) return Promise.resolve();
    pairing.abandoned = true;
    pairing.removing ??= Promise.resolve().then(async () => {
      await pairing.installing?.catch(() => {});
      try {
        if (pairing.attempted) await ports.forget(pairing.environmentId, pairing.installId);
      } catch {
        pairing.removing = null;
        if (!pairing.retryScheduled) {
          pairing.retryScheduled = true;
          void ports.sleep(PAIRING_CLEANUP_RETRY_MS).then(() => {
            pairing.retryScheduled = false;
            if (ownedPairings.get(reservationId) === pairing) void discardPairing(reservationId);
          });
        }
        return;
      }
      ownedPairings.delete(reservationId);
      changed();
    });
    return pairing.removing;
  };

  const abandon = (reservationId: string) => {
    if (!releasing.has(reservationId) && !ownedPairings.get(reservationId)?.abandoned) {
      const release = ports.client.releaseReservation(reservationId).catch(() => null);
      releasing.set(reservationId, release);
      void release.then(() => releasing.delete(reservationId));
    }
    return discardPairing(reservationId);
  };

  const commitPairing = async (reservationId: string) => {
    const pairing = ownedPairings.get(reservationId);
    if (pairing && !pairing.abandoned) {
      await ports.promote(pairing.environmentId, pairing.installId);
      ownedPairings.delete(reservationId);
      changed();
    }
  };

  const stopNotices = (entry: Entry) => {
    entry.notices?.stop();
    entry.notices = null;
  };

  const drop = (entry: Entry) => {
    stopNotices(entry);
    if (entries.get(entry.projectId) === entry) entries.delete(entry.projectId);
    changed();
  };

  const pairOnce = async (
    entry: Entry,
    reservationId: string,
    environmentId: string,
    issued: OrbitGatewayPairing | null,
  ) => {
    const closed = () => entry.ended === "closed";
    if (entry.paired || closed() || (entry.ended === "taken" && issued === null)) return;
    if (ports.isSaved(environmentId)) {
      entry.paired = true;
      return;
    }
    try {
      const pairing = issued ?? (await ports.client.pair(environmentId));
      if (closed()) return;
      if (
        entry.ended === "taken" &&
        ports.hasTakenStart?.(reservationId, environmentId) === false
      ) {
        return;
      }
      await installPairing(reservationId, environmentId, (installId) =>
        ports.connect(environmentId, pairing.pairingUrl, installId),
      );
      entry.paired = true;
    } catch {
      // The start can pair explicitly if this install fails.
    }
  };

  const refresh = async (entry: Entry, current: ReservationDetails) => {
    let response: OrbitGatewayReservation;
    try {
      response = await ports.client.reservation(current.id);
    } catch (error) {
      if (entry.ended === null && isGone(error)) {
        void discardPairing(current.id);
        drop(entry);
      }
      return;
    }
    if (
      entry.ended === "closed" ||
      response.id !== current.id ||
      response.projectId !== entry.projectId
    ) {
      return;
    }
    const { pairing, ...details } = response;
    if (!USABLE_STATES.has(details.state)) {
      if (entry.ended !== null) return;
      if (details.state === "failed") void abandon(current.id);
      if (details.state === "expired" || details.state === "released") {
        void discardPairing(current.id);
      }
      if (details.state === "finalized") await commitPairing(current.id);
      drop(entry);
      return;
    }
    entry.reservation = details;
    if (entry.ended === null) changed();
    if (details.state === "ready" && details.environmentId !== null) {
      if (pairing === null && !entry.paired && !ports.isSaved(details.environmentId)) {
        entry.readyWithoutPairingSince ??= ports.now();
        if (!waitedForIssuedPairing(entry, ports.now())) return;
      }
      await pairOnce(entry, details.id, details.environmentId, pairing);
    }
  };

  const run = async (entry: Entry) => {
    let reservation: ReservationDetails;
    try {
      reservation = await ports.client.reserve(entry.projectId, ports.newKey());
    } catch {
      drop(entry);
      return;
    }
    if (reservation.projectId !== entry.projectId) {
      drop(entry);
      return;
    }
    if (entry.ended !== null) {
      void abandon(reservation.id);
      drop(entry);
      return;
    }
    if (!USABLE_STATES.has(reservation.state)) {
      if (reservation.state === "failed") void abandon(reservation.id);
      drop(entry);
      return;
    }
    entry.reservation = reservation;
    changed();
    // An already-ready POST still needs its first GET before pairing.
    let readNow = reservation.state === "ready";
    try {
      while (entries.get(entry.projectId) === entry) {
        const current = entry.reservation;
        if (!readNow) {
          const ready =
            current.state === "ready" &&
            current.environmentId !== null &&
            (entry.paired || waitedForIssuedPairing(entry, ports.now()));
          if (current.state === "preparing" && current.createOperationId !== null) {
            entry.notices ??= ports.client.operationNotices?.(current.createOperationId) ?? null;
          } else {
            stopNotices(entry);
          }
          await waitForOperationRead({
            notices: entry.notices,
            sequence: null,
            pollMs: ready ? RESERVATION_KEEPALIVE_MS : RESERVATION_PREPARING_POLL_MS,
            maxMs: Number.POSITIVE_INFINITY,
            sleep: ports.sleep,
          });
        }
        if (entry.ended !== null) return;
        readNow = false;
        const pending = refresh(entry, current);
        entry.pending = pending;
        await pending;
        entry.pending = null;
      }
    } finally {
      stopNotices(entry);
    }
  };

  const close = (projectId: number) => {
    const entry = entries.get(projectId);
    if (entry === undefined || entry.ended !== null) return;
    entry.ended = "closed";
    if (entry.reservation) void abandon(entry.reservation.id);
    drop(entry);
  };

  return {
    open: (projectId) => {
      if (entries.has(projectId)) return;
      // Orbit would release the oldest for a fourth; release it here so Conn knows it is gone.
      const open = [...entries.values()].sort((a, b) => a.openedAt - b.openedAt);
      while (open.length >= MAX_OPEN_RESERVATIONS) close(open.shift()!.projectId);
      const entry: Entry = {
        projectId,
        openedAt: ports.now(),
        reservation: null,
        pending: null,
        paired: false,
        readyWithoutPairingSince: null,
        ended: null,
        notices: null,
      };
      entries.set(projectId, entry);
      void run(entry);
    },
    close,
    take: (projectId) => {
      const entry = entries.get(projectId);
      if (entry === undefined) return null;
      const reservation = entry.reservation;
      if (reservation === null || !USABLE_STATES.has(reservation.state)) {
        // Not admitted yet: the send creates as before, and the late reservation is released.
        entry.ended = "closed";
        if (reservation) void abandon(reservation.id);
        drop(entry);
        return null;
      }
      entry.ended = "taken";
      stopNotices(entry);
      if (entry.pending !== null) {
        const pending = entry.pending;
        handedOff.set(reservation.id, pending);
        const clear = () => {
          if (handedOff.get(reservation.id) === pending) handedOff.delete(reservation.id);
        };
        void pending.then(clear, clear);
      }
      // The start holds the id now and hides the clone's server until it is finalized
      // (`orbitThreadStartHiddenEnvironmentId`).
      if (entries.get(projectId) === entry) entries.delete(projectId);
      changed();
      return {
        reservationId: reservation.id,
        instanceId: reservation.instanceId,
        environmentId: reservation.environmentId,
      };
    },
    waitForPairing: (reservationId) => handedOff.get(reservationId),
    installPairing,
    abandon,
    commitPairing,
    releaseLeftovers: async () => {
      const open = new Set(
        [...entries.values()].flatMap((entry) => (entry.reservation ? [entry.reservation.id] : [])),
      );
      const leftovers = (await ports.load()).filter((id) => !open.has(id));
      await Promise.all(
        leftovers.map((id) => ports.client.releaseReservation(id).catch(() => null)),
      );
      changed();
    },
    hiddenEnvironmentIds: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closeAll: () => {
      for (const projectId of Array.from(entries.keys())) close(projectId);
    },
  };
}
