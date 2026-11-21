import type { AuthSessionState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { SupervisorConnectionState } from "../connection/model.ts";

import {
  isReservedOrbitEnvironment,
  OrbitGatewayError,
  type OrbitGatewayEnvironment,
} from "./client.ts";

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/**
 * Where a client's environments come from. `default` is T3's own list: environments the user adds by
 * hand. `orbit` replaces it with the T3 servers registered on the Orbit Gateway, paired
 * automatically (Conn: clones only on request). The two lists never show together: switching to
 * Orbit turns the default environments off, and switching back turns them on again.
 */
export type EnvironmentProvider = "default" | "orbit";

/** What the client remembers between switches, so each switch restores the other side exactly. */
export interface OrbitEnvironmentState {
  /** Default environments Orbit turned off; switching back to `default` turns them on. */
  readonly disabledByOrbit: readonly string[];
  /** Environments Orbit paired; switching back to `default` turns them off, `orbit` on again. */
  readonly pairedByOrbit: readonly string[];
  /** Conn: when Orbit last paired a server again because its session could not manage access. */
  readonly accessPairedAt?: Readonly<Record<string, number>>;
  /** Conn: when Orbit last tried to pair a server this client has not saved yet. */
  readonly pairAttemptedAt?: Readonly<Record<string, number>>;
  /**
   * Conn: servers whose pairing T3 refused with a final error code, with the `registeredAt` they
   * had then. Orbit pairs such a server again only after it registers again.
   */
  readonly pairRefusedAt?: Readonly<Record<string, string>>;
  /** Conn: when Orbit last renewed a saved server's session that ends soon or has ended. */
  readonly renewedAt?: Readonly<Record<string, number>>;
  /**
   * Conn: servers whose renewal Orbit refused with `conn.pairing_revoked`, with the time of that
   * answer. They are never renewed again; only an explicit Connect (`forgetPairingRevoked`) pairs
   * them again.
   */
  readonly revokedAt?: Readonly<Record<string, number>>;
  /**
   * Conn: servers whose last renewal failed, with the time and the reason. The server's row shows
   * it with a Retry until a pairing with that server succeeds.
   */
  readonly renewalFailed?: Readonly<Record<string, RenewalFailure>>;
  /**
   * Conn: servers a Gateway list showed with an Orbit Instance, with its id (newest last, at most
   * `MAX_REMEMBERED_INSTANCE_SERVERS`). A gone server's record no longer says it was an Instance's.
   */
  readonly instanceServers?: Readonly<Record<string, number>>;
  /**
   * Conn: saved Instance servers a successful, non-empty Gateway list left out, with when a list
   * first did.
   */
  readonly missingFromGateway?: Readonly<Record<string, number>>;
}

/** Conn: how many Instance servers a device remembers (see `instanceServers`). */
const MAX_REMEMBERED_INSTANCE_SERVERS = 500;

/**
 * Conn: how long an Instance's server must stay out of the Gateway's lists before this device
 * removes it. A profile edit runs a second sync within seconds, so two lists alone are no proof.
 */
export const GONE_CONFIRM_MS = 2 * 60 * 1000;

/** Conn: a saved server whose Orbit Instance is gone, to remove from this device. */
export interface GoneInstanceServer {
  readonly environmentId: string;
  /** Null for a server known only from older records. */
  readonly instanceId: number | null;
}

/**
 * Conn: why a renewal failed, in the words the user reads. `session_ended`: Orbit's own session on
 * the server ended, so it cannot make a link. `unknown`: anything else; the row then says only
 * "Could not renew." and never shows a code.
 */
export type RenewalFailureReason =
  | "session_ended"
  | "revoked"
  | "orbit_unreachable"
  | "server_unreachable"
  | "link_refused"
  | "unknown";

export interface RenewalFailure {
  readonly at: number;
  readonly reason: RenewalFailureReason;
}

const RENEWAL_FAILURE_REASONS: readonly RenewalFailureReason[] = [
  "session_ended",
  "revoked",
  "orbit_unreachable",
  "server_unreachable",
  "link_refused",
  "unknown",
];

/** Conn: Gateway error codes of a pairing, by the reason the user reads. */
const RENEWAL_FAILURE_CODES: Readonly<Record<string, RenewalFailureReason>> = {
  "conn.session_expired": "session_ended",
  "conn.session_rejected": "session_ended",
  "conn.pairing_revoked": "revoked",
  "gateway.unreachable": "orbit_unreachable",
  "operation.timeout": "orbit_unreachable",
  "conn.server_unreachable": "server_unreachable",
  "conn.request_refused": "link_refused",
  "conn.response_invalid": "link_refused",
};

/**
 * Conn: the reason of a failed renewal. A Gateway error maps by its code. A failure to use the new
 * link on this device: a transient connection error means the server did not answer, a blocked
 * one that it refused the link.
 */
export function renewalFailureReason(error: unknown): RenewalFailureReason {
  if (isOrbitGatewayError(error)) return RENEWAL_FAILURE_CODES[error.code] ?? "unknown";
  const tag =
    typeof error === "object" && error !== null ? (error as { _tag?: unknown })._tag : undefined;
  if (tag === "ConnectionTransientError") return "server_unreachable";
  if (tag === "ConnectionBlockedError") return "link_refused";
  return "unknown";
}

const RENEWAL_FAILURE_TEXT: Readonly<Record<RenewalFailureReason, string>> = {
  session_ended: "Could not renew: Orbit's session on this server ended.",
  revoked: "Could not renew: revoked in Orbit.",
  orbit_unreachable: "Could not renew: Orbit is not reachable.",
  server_unreachable: "Could not renew: the server is not reachable.",
  link_refused: "Could not renew: the server refused the link.",
  unknown: "Could not renew.",
};

/** Conn: the sentence a server row shows for a failed renewal. */
export function renewalFailureText(reason: RenewalFailureReason): string {
  return RENEWAL_FAILURE_TEXT[reason];
}

export const EMPTY_ORBIT_ENVIRONMENT_STATE: OrbitEnvironmentState = {
  disabledByOrbit: [],
  pairedByOrbit: [],
};

/** Conn: how long to wait before pairing a server again whose session still lacks `access:write`. */
export const ACCESS_PAIRING_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Conn: how long to wait before pairing a new server again after an attempt that did not save it.
 * Each attempt mints a link on the server, so a failure must not repeat on every sync.
 */
export const PAIRING_RETRY_MS = 5 * 60 * 1000;

/** Conn: a saved server's session is renewed once it ends within this time. */
export const SESSION_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
/** Conn: the wait between renewals of a session that has ended (each one mints a link). */
export const EXPIRED_RENEWAL_RETRY_MS = 5 * 60 * 1000;
/** Conn: the wait between renewals of a session that still works but ends soon. */
export const EXPIRING_RENEWAL_RETRY_MS = 6 * 60 * 60 * 1000;

/** Conn: why a saved server's session needs a renewal. */
export type SessionRenewalReason = "expired" | "expiring";

/** Conn: a saved Orbit server whose session ends soon or has ended. */
export interface SessionRenewal {
  readonly environmentId: string;
  readonly reason: SessionRenewalReason;
}

/**
 * Conn: whether a saved server's session needs a renewal. `expired` when the server refused the
 * credential (its session reads `authenticated: false`, or the connection is blocked on
 * authentication); `expiring` when the session ends within `SESSION_RENEW_BEFORE_MS`. A session
 * the client has not read yet, or one without an end, needs nothing.
 */
export function sessionRenewalReason(input: {
  readonly authenticationRefused: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "expiresAt"> | null;
  readonly now: number;
}): SessionRenewalReason | null {
  if (input.authenticationRefused) return "expired";
  const session = input.session;
  if (session === null) return null;
  if (!session.authenticated) return "expired";
  if (session.expiresAt === undefined) return null;
  const endsAt = DateTime.toEpochMillis(session.expiresAt);
  if (endsAt <= input.now) return "expired";
  return endsAt - input.now < SESSION_RENEW_BEFORE_MS ? "expiring" : null;
}

/**
 * Conn: whether the server refused this connection's credential and no attempt has connected
 * since. Bringing the app to the front moves a blocked connection back to `connecting` while it
 * keeps that failure, so the phase alone misses a refusal exactly when the app refreshes.
 */
export function connectionRefusedCredential(
  connection: Pick<SupervisorConnectionState, "phase" | "lastFailure"> | null,
): boolean {
  return (
    connection !== null &&
    connection.phase !== "connected" &&
    connection.lastFailure?._tag === "ConnectionBlockedError" &&
    connection.lastFailure.reason === "authentication"
  );
}

/**
 * Conn: the saved servers whose session needs a renewal (see `sessionRenewalReason`). The desktop
 * and the phone read the same two facts per server: its connection and its session.
 */
export function readSessionRenewals(input: {
  readonly environmentIds: readonly string[];
  readonly readConnection: (
    environmentId: string,
  ) => Pick<SupervisorConnectionState, "phase" | "lastFailure"> | null;
  readonly readSession: (
    environmentId: string,
  ) => Pick<AuthSessionState, "authenticated" | "expiresAt"> | null;
  readonly now: number;
}): SessionRenewal[] {
  return input.environmentIds.flatMap((environmentId) => {
    const reason = sessionRenewalReason({
      authenticationRefused: connectionRefusedCredential(input.readConnection(environmentId)),
      session: input.readSession(environmentId),
      now: input.now,
    });
    return reason === null ? [] : [{ environmentId, reason }];
  });
}

/**
 * Conn: watches the connection of each saved Orbit server and calls `onRefused` once each time a
 * server starts refusing its credential. A refusal arrives seconds after the refresh that the
 * app's return to the front started (the connection retries at the same moment), so that refresh
 * cannot see it; the watch lets the app run one more at once.
 */
export function createCredentialRefusalWatch(input: {
  readonly subscribe: (
    environmentId: string,
    listener: (connection: Pick<SupervisorConnectionState, "phase" | "lastFailure"> | null) => void,
  ) => () => void;
  readonly onRefused: (environmentId: string) => void;
}): { readonly watch: (environmentIds: readonly string[]) => void } {
  const watches = new Map<string, () => void>();
  return {
    watch(environmentIds) {
      const wanted = new Set(environmentIds);
      for (const [environmentId, unsubscribe] of watches) {
        if (wanted.has(environmentId)) continue;
        unsubscribe();
        watches.delete(environmentId);
      }
      for (const environmentId of wanted) {
        if (watches.has(environmentId)) continue;
        let refused = false;
        const unsubscribe = input.subscribe(environmentId, (connection) => {
          const next = connectionRefusedCredential(connection);
          if (next && !refused) input.onRefused(environmentId);
          refused = next;
        });
        watches.set(environmentId, unsubscribe);
      }
    },
  };
}

/** A saved environment the provider manages. The desktop's own local backend is never passed in. */
export interface ManagedEnvironment {
  readonly environmentId: string;
  readonly enabled: boolean;
}

export interface EnvironmentProviderPlan {
  readonly enable: readonly string[];
  readonly disable: readonly string[];
  /**
   * Registered Orbit servers this client has not saved yet, and (Conn) saved ones to pair again
   * because their session lacks `access:write`. Record each success with `recordPaired`, each
   * attempt at the first kind with `recordPairingAttempt`, and at the second with
   * `recordAccessPairing`.
   */
  readonly pair: readonly string[];
  /**
   * Conn: the part of `pair` that renews a saved server's session. Pair these one after another
   * with `renew: true`, and record each attempt with `recordRenewal`.
   */
  readonly renew: readonly string[];
  /**
   * Conn: saved servers of Orbit Instances that successful, non-empty Gateway lists left out for
   * `GONE_CONFIRM_MS`, two lists at least: the Instance is gone. Remove each from this device as the Orbit panel does when the
   * user removes an Instance, and forget it with `forgetOrbitEnvironment`.
   */
  readonly remove: readonly GoneInstanceServer[];
  readonly state: OrbitEnvironmentState;
}

/**
 * The changes that bring the saved environments in line with the provider. `orbit` is the Gateway's
 * server list, or null when it could not be read; without it Orbit mode changes nothing, because it
 * cannot tell an Orbit server from a default environment.
 */
export function planEnvironmentProvider(input: {
  readonly provider: EnvironmentProvider;
  readonly saved: readonly ManagedEnvironment[];
  readonly orbit: readonly OrbitGatewayEnvironment[] | null;
  readonly state: OrbitEnvironmentState;
  /** Conn: saved Orbit servers whose session is known to lack `access:write`. */
  readonly lacksAccess?: readonly string[];
  /**
   * Conn: Instances whose server a thread start pairs with itself. Their servers are left alone, so
   * the device pairs with each once.
   */
  readonly heldInstanceIds?: readonly number[];
  /**
   * Conn: unsaved Instance servers (clones) the user asked to connect. Every other unsaved clone
   * is listed but left unpaired, so a new clone does not get a pairing from every device.
   */
  readonly requestedEnvironmentIds?: readonly string[];
  /** Conn: saved Orbit servers whose session ends soon or has ended (`sessionRenewalReason`). */
  readonly renew?: readonly SessionRenewal[];
  /** Conn: more servers this device knows ran in an Orbit Instance (beside `instanceServers`). */
  readonly knownInstanceServers?: readonly string[];
  readonly now?: number;
}): EnvironmentProviderPlan {
  const { saved, state } = input;
  const disabledByOrbit = new Set(state.disabledByOrbit);
  const pairedByOrbit = new Set(state.pairedByOrbit);
  const enable: string[] = [];
  const disable: string[] = [];

  if (input.provider === "default") {
    for (const environment of saved) {
      if (disabledByOrbit.has(environment.environmentId)) {
        if (!environment.enabled) enable.push(environment.environmentId);
      } else if (pairedByOrbit.has(environment.environmentId) && environment.enabled) {
        disable.push(environment.environmentId);
      }
    }
    return {
      enable,
      disable,
      pair: [],
      renew: [],
      remove: [],
      // Conn: a server Orbit mode saw missing is counted again from the next switch back.
      state: {
        ...state,
        disabledByOrbit: [],
        pairedByOrbit: [...pairedByOrbit],
        missingFromGateway: {},
      },
    };
  }

  if (input.orbit === null) return { enable, disable, pair: [], renew: [], remove: [], state };

  const orbitIds = new Set(input.orbit.map((environment) => environment.environmentId));
  const savedIds = new Set(saved.map((environment) => environment.environmentId));
  // Conn: a server is an Instance's when a list showed it with one. An empty list is never taken
  // as the truth (a Gateway can briefly list nothing), so it removes nothing and changes no mark.
  const listed = input.orbit.length > 0;
  const instanceServers = rememberInstanceServers(
    state.instanceServers ?? {},
    input.orbit.flatMap((environment) =>
      environment.instanceId === null ? [] : [[environment.environmentId, environment.instanceId]],
    ),
  );
  const known = new Set(input.knownInstanceServers ?? []);
  const wasMissing = state.missingFromGateway ?? {};
  const missingFromGateway: Record<string, number> = {};
  const remove: GoneInstanceServer[] = [];
  const now = input.now ?? 0;
  const held = new Set(input.heldInstanceIds ?? []);
  for (const environment of saved) {
    const id = environment.environmentId;
    if (orbitIds.has(id)) {
      // An Orbit server Orbit turned off on an earlier switch to `default` comes back.
      if (!environment.enabled && pairedByOrbit.has(id)) enable.push(id);
      continue;
    }
    // Conn: an Instance's server that lists leave out for `GONE_CONFIRM_MS` is gone: its Instance
    // was destroyed, and Orbit may give its address to a new Instance. Removal costs a pairing
    // that only an explicit Connect makes again, so one list, or two within seconds, is not enough.
    const instanceId = instanceServers[id] ?? null;
    const isInstanceServer = instanceId !== null || known.has(id);
    // A clone a thread start is pairing with belongs to that start.
    if (isInstanceServer && !(instanceId !== null && held.has(instanceId))) {
      const since = wasMissing[id];
      if (!listed) {
        if (since !== undefined) missingFromGateway[id] = since;
      } else if (since !== undefined && now - since >= GONE_CONFIRM_MS) {
        remove.push({ environmentId: id, instanceId });
        continue;
      } else {
        missingFromGateway[id] = since ?? now;
      }
    }
    if (environment.enabled) {
      disable.push(id);
      // A server that left the Gateway stays Orbit's; anything else is a default environment.
      if (!pairedByOrbit.has(id)) disabledByOrbit.add(id);
    }
  }
  const removed = new Set(remove.map((server) => server.environmentId));
  const lacksAccess = new Set(input.lacksAccess ?? []);
  const requested = new Set(input.requestedEnvironmentIds ?? []);
  const renewals = new Map(
    (input.renew ?? []).map((renewal) => [renewal.environmentId, renewal.reason]),
  );
  const renew: string[] = [];
  const pair = input.orbit
    .filter((environment) => {
      if (environment.status !== "registered" || isReservedOrbitEnvironment(environment))
        return false;
      if (environment.instanceId !== null && held.has(environment.instanceId)) return false;
      // An asleep Instance's server cannot mint a pairing link.
      if (environment.powerState === "stopped") return false;
      const id = environment.environmentId;
      if (!savedIds.has(id)) {
        if (environment.instanceId !== null && !requested.has(id)) return false;
        const refusedAt = state.pairRefusedAt?.[id];
        if (refusedAt !== undefined && refusedAt === environment.registeredAt) return false;
        const lastAttempt = state.pairAttemptedAt?.[id];
        return lastAttempt === undefined || now - lastAttempt >= PAIRING_RETRY_MS;
      }
      // Conn: a revoked pairing is never renewed; only an explicit Connect pairs it again.
      if (state.revokedAt?.[id] !== undefined) return false;
      // Conn: a session that ends soon or has ended is renewed, unless T3 refused this
      // registration's pairing for good (it is tried again once the server registers again).
      const reason = renewals.get(id);
      if (reason !== undefined) {
        const refusedAt = state.pairRefusedAt?.[id];
        if (refusedAt !== undefined && refusedAt === environment.registeredAt) return false;
        const lastRenewal = state.renewedAt?.[id];
        const wait = reason === "expired" ? EXPIRED_RENEWAL_RETRY_MS : EXPIRING_RENEWAL_RETRY_MS;
        if (lastRenewal !== undefined && now - lastRenewal < wait) return false;
        renew.push(id);
        return true;
      }
      // Conn: pair again so the session can manage linked environments (see FORK.md, "Orbit").
      const lastTry = state.accessPairedAt?.[id];
      return (
        lacksAccess.has(id) && (lastTry === undefined || now - lastTry >= ACCESS_PAIRING_RETRY_MS)
      );
    })
    .map((environment) => environment.environmentId);

  return {
    enable,
    disable,
    pair,
    renew,
    remove,
    state: {
      ...state,
      disabledByOrbit: [...disabledByOrbit].filter((id) => !removed.has(id)),
      pairedByOrbit: [...pairedByOrbit].filter((id) => !removed.has(id)),
      instanceServers,
      missingFromGateway,
    },
  };
}

/** Conn: adds servers at the end (newest last) and keeps the newest `MAX_REMEMBERED_INSTANCE_SERVERS`. */
function rememberInstanceServers(
  current: Readonly<Record<string, number>>,
  seen: ReadonlyArray<readonly [string, number]>,
): Record<string, number> {
  const added = new Set(seen.map(([id]) => id));
  const entries = [...Object.entries(current).filter(([id]) => !added.has(id)), ...seen];
  return Object.fromEntries(
    entries.slice(Math.max(0, entries.length - MAX_REMEMBERED_INSTANCE_SERVERS)),
  );
}

/** Conn: records an attempt to renew a saved server's session, successful or not. */
export function recordRenewal(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, renewedAt: { ...state.renewedAt, [environmentId]: now } };
}

/** Conn: records a failed renewal; the server's row shows it until a pairing succeeds. */
export function recordRenewalFailed(
  state: OrbitEnvironmentState,
  environmentId: string,
  failure: RenewalFailure,
): OrbitEnvironmentState {
  return { ...state, renewalFailed: { ...state.renewalFailed, [environmentId]: failure } };
}

/** Conn: a pairing with the server succeeded, so no failed renewal describes it any more. */
export function forgetRenewalFailure(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  if (state.renewalFailed?.[environmentId] === undefined) return state;
  const { [environmentId]: _renewed, ...renewalFailed } = state.renewalFailed;
  return { ...state, renewalFailed };
}

/** Conn: records that Orbit refused a renewal because this Node's pairing there is revoked. */
export function recordPairingRevoked(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, revokedAt: { ...state.revokedAt, [environmentId]: now } };
}

/** Conn: an explicit Connect lifts the revoked state, so the server pairs (and renews) again. */
export function forgetPairingRevoked(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  if (state.revokedAt?.[environmentId] === undefined) return state;
  const { [environmentId]: _lifted, ...revokedAt } = state.revokedAt;
  return { ...state, revokedAt };
}

/** Conn: whether Orbit revoked this device's pairing with the server (see `recordPairingRevoked`). */
export function isPairingRevoked(state: OrbitEnvironmentState, environmentId: string): boolean {
  return state.revokedAt?.[environmentId] !== undefined;
}

/** Conn: records an attempt to pair a saved server again for access, successful or not. */
export function recordAccessPairing(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, accessPairedAt: { ...state.accessPairedAt, [environmentId]: now } };
}

/** Conn: records an attempt to pair a server this client has not saved, successful or not. */
export function recordPairingAttempt(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, pairAttemptedAt: { ...state.pairAttemptedAt, [environmentId]: now } };
}

/**
 * Conn: records that T3 refused a new server's pairing with a final error code. It is paired
 * again once its registration changes. Without a known registration time it only backs off.
 */
export function recordPairingRefused(
  state: OrbitEnvironmentState,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): OrbitEnvironmentState {
  if (environment.registeredAt === null) return state;
  return {
    ...state,
    pairRefusedAt: {
      ...state.pairRefusedAt,
      [environment.environmentId]: environment.registeredAt,
    },
  };
}

export function recordPaired(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  return state.pairedByOrbit.includes(environmentId)
    ? state
    : { ...state, pairedByOrbit: [...state.pairedByOrbit, environmentId] };
}

/** Conn: drops every record of a server Orbit removed, so no sync touches it again. */
export function forgetOrbitEnvironment(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  const without = <T>(record: Readonly<Record<string, T>> | undefined) =>
    record === undefined
      ? undefined
      : Object.fromEntries(Object.entries(record).filter(([id]) => id !== environmentId));
  const accessPairedAt = without(state.accessPairedAt);
  const pairAttemptedAt = without(state.pairAttemptedAt);
  const pairRefusedAt = without(state.pairRefusedAt);
  const renewedAt = without(state.renewedAt);
  const revokedAt = without(state.revokedAt);
  const renewalFailed = without(state.renewalFailed);
  return {
    disabledByOrbit: state.disabledByOrbit.filter((id) => id !== environmentId),
    pairedByOrbit: state.pairedByOrbit.filter((id) => id !== environmentId),
    // `instanceServers` keeps the id: a profile merge or a restore may bring the record back.
    ...(state.instanceServers === undefined ? {} : { instanceServers: state.instanceServers }),
    ...(state.missingFromGateway === undefined
      ? {}
      : { missingFromGateway: without(state.missingFromGateway) ?? {} }),
    ...(accessPairedAt === undefined ? {} : { accessPairedAt }),
    ...(pairAttemptedAt === undefined ? {} : { pairAttemptedAt }),
    ...(pairRefusedAt === undefined ? {} : { pairRefusedAt }),
    ...(renewedAt === undefined ? {} : { renewedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(renewalFailed === undefined ? {} : { renewalFailed }),
  };
}

export function parseEnvironmentProvider(value: unknown): EnvironmentProvider {
  return value === "orbit" ? "orbit" : "default";
}

export function parseOrbitEnvironmentState(value: unknown): OrbitEnvironmentState {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  const times = (value: unknown) => {
    const result: Record<string, number> = {};
    if (typeof value === "object" && value !== null) {
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === "number") result[id] = at;
      }
    }
    return result;
  };
  const texts = (value: unknown) => {
    const result: Record<string, string> = {};
    if (typeof value === "object" && value !== null) {
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === "string") result[id] = at;
      }
    }
    return result;
  };
  const failures = (value: unknown) => {
    const result: Record<string, RenewalFailure> = {};
    if (typeof value === "object" && value !== null) {
      for (const [id, entry] of Object.entries(value)) {
        if (typeof entry !== "object" || entry === null) continue;
        const { at, reason } = entry as { at?: unknown; reason?: unknown };
        if (typeof at !== "number") continue;
        result[id] = {
          at,
          reason: RENEWAL_FAILURE_REASONS.includes(reason as RenewalFailureReason)
            ? (reason as RenewalFailureReason)
            : "unknown",
        };
      }
    }
    return result;
  };
  return {
    disabledByOrbit: ids(record.disabledByOrbit),
    pairedByOrbit: ids(record.pairedByOrbit),
    accessPairedAt: times(record.accessPairedAt),
    pairAttemptedAt: times(record.pairAttemptedAt),
    pairRefusedAt: texts(record.pairRefusedAt),
    renewedAt: times(record.renewedAt),
    revokedAt: times(record.revokedAt),
    renewalFailed: failures(record.renewalFailed),
    instanceServers: times(record.instanceServers),
    missingFromGateway: times(record.missingFromGateway),
  };
}
