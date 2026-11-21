import { describe, expect, it } from "vite-plus/test";

import { OrbitGatewayError, type OrbitGatewayEnvironment } from "./client.ts";
import * as DateTime from "effect/DateTime";

import { ConnectionBlockedError, ConnectionTransientError } from "../connection/model.ts";
import {
  ACCESS_PAIRING_RETRY_MS,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  EXPIRED_RENEWAL_RETRY_MS,
  EXPIRING_RENEWAL_RETRY_MS,
  forgetOrbitEnvironment,
  forgetPairingRevoked,
  isPairingRevoked,
  PAIRING_RETRY_MS,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  recordPairingRevoked,
  recordRenewal,
  SESSION_RENEW_BEFORE_MS,
  sessionRenewalReason,
  connectionRefusedCredential,
  createCredentialRefusalWatch,
  forgetRenewalFailure,
  GONE_CONFIRM_MS,
  readSessionRenewals,
  recordRenewalFailed,
  renewalFailureReason,
  renewalFailureText,
  type ManagedEnvironment,
  type OrbitEnvironmentState,
} from "./environmentProvider.ts";

const orbit = (
  id: string,
  status: OrbitGatewayEnvironment["status"] = "registered",
  instanceId: number | null = null,
) =>
  ({
    environmentId: id,
    label: id,
    url: `http://${id}`,
    serverVersion: null,
    registeredBy: null,
    registeredAt: "2026-11-09T14:48:58+00:00",
    status,
    instanceId,
    powerState: instanceId === null ? null : "running",
  }) as OrbitGatewayEnvironment;
const saved = (id: string, enabled = true): ManagedEnvironment => ({ environmentId: id, enabled });

/** Applies a plan to a saved list, the way a client does after pairing every requested server. */
function apply(list: ManagedEnvironment[], plan: ReturnType<typeof planEnvironmentProvider>) {
  let state = plan.state;
  const next = list.map((entry) =>
    plan.enable.includes(entry.environmentId)
      ? { ...entry, enabled: true }
      : plan.disable.includes(entry.environmentId)
        ? { ...entry, enabled: false }
        : entry,
  );
  for (const id of plan.pair) {
    next.push(saved(id));
    state = recordPaired(state, id);
  }
  return { list: next, state };
}

describe("planEnvironmentProvider", () => {
  it("turns default environments off and pairs the Orbit servers on a switch to Orbit", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("laptop"), saved("old", false), saved("beast")],
      orbit: [orbit("beast"), orbit("mini"), orbit("expired", "session_expired")],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
    });
    expect(plan.disable).toEqual(["laptop"]);
    expect(plan.enable).toEqual([]);
    expect(plan.pair).toEqual(["mini"]);
    // An environment the user had already switched off is not Orbit's to switch back on.
    expect(plan.state.disabledByOrbit).toEqual(["laptop"]);
  });

  it("leaves the server of an Instance that a thread start pairs with itself, and an asleep one", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [],
      orbit: [
        orbit("clone", "registered", 41),
        orbit("other-clone", "registered", 42),
        { ...orbit("asleep-clone", "registered", 43), powerState: "stopped" },
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      heldInstanceIds: [41],
      requestedEnvironmentIds: ["clone", "other-clone", "asleep-clone"],
    });
    // An asleep clone cannot mint a pairing link, so pairing it would only fail again on each run.
    expect(plan.pair).toEqual(["other-clone"]);
  });

  it("leaves reserved servers to the reservation's pairing flow", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("saved-reservation")],
      orbit: [
        { ...orbit("reserved", "registered", 41), reservationId: "r41" },
        { ...orbit("saved-reservation", "registered", 42), reservationId: "r42" },
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      requestedEnvironmentIds: ["reserved"],
      renew: [{ environmentId: "saved-reservation", reason: "expired" }],
    });
    expect(plan.pair).toEqual([]);
    expect(plan.renew).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("pairs a host server at once but a clone only when the user asks for it", () => {
    const input = {
      provider: "orbit" as const,
      saved: [saved("saved-clone")],
      orbit: [
        orbit("host"),
        orbit("clone", "registered", 41),
        orbit("requested-clone", "registered", 42),
        orbit("saved-clone", "registered", 43),
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      requestedEnvironmentIds: ["requested-clone"],
    };
    expect(planEnvironmentProvider(input).pair).toEqual(["host", "requested-clone"]);
    // A clone paired earlier still pairs again when its session cannot manage access.
    expect(planEnvironmentProvider({ ...input, lacksAccess: ["saved-clone"] }).pair).toEqual([
      "host",
      "requested-clone",
      "saved-clone",
    ]);
    // A clone this device started is paired by the start; the sync leaves it alone.
    expect(
      planEnvironmentProvider({
        ...input,
        heldInstanceIds: [42],
      }).pair,
    ).toEqual(["host"]);
  });

  it("changes nothing in Orbit mode while the Gateway cannot be read", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: ["laptop"], pairedByOrbit: ["mini"] };
    expect(
      planEnvironmentProvider({
        provider: "orbit",
        saved: [saved("laptop", false)],
        orbit: null,
        state,
      }),
    ).toEqual({ enable: [], disable: [], pair: [], renew: [], remove: [], state });
  });

  it("removes a saved Instance server once lists leave it out for GONE_CONFIRM_MS", () => {
    const state: OrbitEnvironmentState = {
      disabledByOrbit: [],
      pairedByOrbit: ["host", "clone"],
    };
    const list = [saved("host"), saved("clone")];
    const others = [orbit("host"), orbit("other", "registered", 9)];
    // Listed: remembered as Instance 1846's server.
    const seen = planEnvironmentProvider({
      provider: "orbit",
      saved: list,
      orbit: [...others, orbit("clone", "registered", 1846)],
      state,
      now: 1_000,
    });
    expect(seen.remove).toEqual([]);
    // The Instance was destroyed outside Conn: the first list without it switches it off.
    const first = planEnvironmentProvider({
      provider: "orbit",
      saved: list,
      orbit: others,
      state: seen.state,
      now: 2_000,
    });
    expect(first.remove).toEqual([]);
    expect(first.disable).toEqual(["clone"]);
    const afterMiss = [saved("host"), saved("clone", false)];
    // A second list seconds later (a profile edit's sync) is no proof yet.
    const soon = planEnvironmentProvider({
      provider: "orbit",
      saved: afterMiss,
      orbit: others,
      state: first.state,
      now: 5_000,
    });
    expect(soon.remove).toEqual([]);
    // A list GONE_CONFIRM_MS after the first miss removes it from this device.
    const later = planEnvironmentProvider({
      provider: "orbit",
      saved: afterMiss,
      orbit: others,
      state: soon.state,
      now: 2_000 + GONE_CONFIRM_MS,
    });
    expect(later.remove).toEqual([{ environmentId: "clone", instanceId: 1846 }]);
    expect(later.disable).toEqual([]);
    expect(later.state.pairedByOrbit).toEqual(["host"]);
    expect(later.state.missingFromGateway).toEqual({});
  });

  it("removes nothing while the Gateway is out, or lists nothing", () => {
    const state: OrbitEnvironmentState = {
      disabledByOrbit: [],
      pairedByOrbit: ["clone"],
      instanceServers: { clone: 1846 },
      missingFromGateway: { clone: 0 },
    };
    const list = [saved("clone", false)];
    const now = GONE_CONFIRM_MS * 10;
    const failed = planEnvironmentProvider({
      provider: "orbit",
      saved: list,
      orbit: null,
      state,
      now,
    });
    expect(failed.remove).toEqual([]);
    expect(failed.state).toBe(state);
    // An empty list (a Gateway that briefly lists nothing) is no proof either; the mark holds.
    const empty = planEnvironmentProvider({
      provider: "orbit",
      saved: list,
      orbit: [],
      state,
      now,
    });
    expect(empty.remove).toEqual([]);
    expect(empty.state.missingFromGateway).toEqual({ clone: 0 });
    // Back in the list: the mark is dropped.
    const back = planEnvironmentProvider({
      provider: "orbit",
      saved: list,
      orbit: [orbit("clone", "registered", 1846)],
      state,
      now,
    });
    expect(back.remove).toEqual([]);
    expect(back.state.missingFromGateway).toEqual({});
    // A switch to Default drops the marks, so a later switch back counts again.
    expect(
      planEnvironmentProvider({ provider: "default", saved: list, orbit: null, state }).state
        .missingFromGateway,
    ).toEqual({});
  });

  it("never removes a host server, which only switches off", () => {
    let state: OrbitEnvironmentState = { disabledByOrbit: [], pairedByOrbit: ["host"] };
    let list = [saved("host")];
    for (let run = 0; run < 3; run++) {
      const plan = planEnvironmentProvider({
        provider: "orbit",
        saved: list,
        orbit: [orbit("other-host"), orbit("clone", "registered", 7)],
        state,
        now: run * GONE_CONFIRM_MS,
      });
      expect(plan.remove).toEqual([]);
      state = plan.state;
      list = [saved("host", false)];
    }
    expect(state.missingFromGateway).toEqual({});
  });

  it("leaves the server of a clone a thread start holds", () => {
    const state: OrbitEnvironmentState = {
      disabledByOrbit: [],
      pairedByOrbit: ["clone"],
      instanceServers: { clone: 41 },
      missingFromGateway: { clone: 0 },
    };
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("clone")],
      orbit: [orbit("host")],
      state,
      heldInstanceIds: [41],
      now: GONE_CONFIRM_MS * 10,
    });
    expect(plan.remove).toEqual([]);
  });

  it("removes a switched-off clone this device knew before it remembered Instance servers", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: [], pairedByOrbit: ["instance-1846"] };
    const input = {
      provider: "orbit" as const,
      saved: [saved("instance-1846", false)],
      orbit: [orbit("instance-2764", "registered", 2764)],
      knownInstanceServers: ["instance-1846"],
    };
    const first = planEnvironmentProvider({ ...input, state, now: 0 });
    expect(first.remove).toEqual([]);
    expect(
      planEnvironmentProvider({ ...input, state: first.state, now: GONE_CONFIRM_MS }).remove,
    ).toEqual([{ environmentId: "instance-1846", instanceId: null }]);
  });

  it("restores exactly the earlier list on each switch, back and forth", () => {
    const servers = [orbit("beast"), orbit("mini")];
    let list = [saved("laptop"), saved("tunnel"), saved("old", false)];
    let state = EMPTY_ORBIT_ENVIRONMENT_STATE;

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "orbit", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "beast",
      "mini",
    ]);

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "default", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "laptop",
      "tunnel",
    ]);

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "orbit", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "beast",
      "mini",
    ]);
    expect(list).toHaveLength(5);
  });

  it("keeps a server that left the Gateway as Orbit's, so Default does not turn it on", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: [], pairedByOrbit: ["gone"] };
    const orbitPlan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("gone")],
      orbit: [],
      state,
    });
    expect(orbitPlan.disable).toEqual(["gone"]);
    expect(orbitPlan.state.disabledByOrbit).toEqual([]);
    const defaultPlan = planEnvironmentProvider({
      provider: "default",
      saved: [saved("gone", false)],
      orbit: [],
      state: orbitPlan.state,
    });
    expect(defaultPlan.enable).toEqual([]);
  });

  it("leaves an environment that is both saved by hand and on the Gateway enabled", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("nick")],
      orbit: [orbit("nick")],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
    });
    expect(plan).toMatchObject({ enable: [], disable: [], pair: [] });
  });

  it("pairs a saved server again when its session cannot manage access, at most every few hours", () => {
    const now = 1_000_000_000;
    const input = {
      provider: "orbit" as const,
      saved: [saved("mini"), saved("beast")],
      orbit: [orbit("mini"), orbit("beast")],
      lacksAccess: ["mini"],
      now,
    };
    const first = planEnvironmentProvider({ ...input, state: EMPTY_ORBIT_ENVIRONMENT_STATE });
    expect(first.pair).toEqual(["mini"]);

    const tried = recordAccessPairing(first.state, "mini", now);
    expect(planEnvironmentProvider({ ...input, state: tried }).pair).toEqual([]);
    expect(
      planEnvironmentProvider({ ...input, state: tried, now: now + ACCESS_PAIRING_RETRY_MS }).pair,
    ).toEqual(["mini"]);
  });

  it("waits before pairing a new server again after an attempt that did not save it", () => {
    const now = 1_000_000_000;
    const input = { provider: "orbit" as const, saved: [], orbit: [orbit("spike")], now };
    const first = planEnvironmentProvider({ ...input, state: EMPTY_ORBIT_ENVIRONMENT_STATE });
    expect(first.pair).toEqual(["spike"]);

    const tried = recordPairingAttempt(first.state, "spike", now);
    expect(planEnvironmentProvider({ ...input, state: tried, now: now + 15_000 }).pair).toEqual([]);
    expect(
      planEnvironmentProvider({ ...input, state: tried, now: now + PAIRING_RETRY_MS }).pair,
    ).toEqual(["spike"]);
  });

  it("keeps pairing attempt times across a reload", () => {
    const state = recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", 42);
    expect(parseOrbitEnvironmentState(JSON.parse(JSON.stringify(state))).pairAttemptedAt).toEqual({
      spike: 42,
    });
    expect(parseOrbitEnvironmentState({ pairAttemptedAt: { spike: "x" } }).pairAttemptedAt).toEqual(
      {},
    );
  });

  it("pairs a server T3 refused only after it registers again", () => {
    const now = 1_000_000_000;
    const input = { provider: "orbit" as const, saved: [], now: now + PAIRING_RETRY_MS };
    const refused = recordPairingRefused(
      recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", now),
      orbit("spike"),
    );
    expect(
      planEnvironmentProvider({ ...input, orbit: [orbit("spike")], state: refused }).pair,
    ).toEqual([]);
    const registeredAgain = { ...orbit("spike"), registeredAt: "2026-11-10T08:00:00+00:00" };
    expect(
      planEnvironmentProvider({ ...input, orbit: [registeredAgain], state: refused }).pair,
    ).toEqual(["spike"]);
  });

  it("keeps the pairing backoff across a switch to Default and back", () => {
    const tried = recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", 42);
    const toDefault = planEnvironmentProvider({
      provider: "default",
      saved: [],
      orbit: null,
      state: tried,
    });
    expect(toDefault.state.pairAttemptedAt).toEqual({ spike: 42 });
  });

  it("forgets a destroyed Instance's server everywhere and keeps the others' records", () => {
    const both = (state: OrbitEnvironmentState, id: string) =>
      recordPairingRefused(
        recordPairingAttempt(recordAccessPairing(recordPaired(state, id), id, 1), id, 2),
        { environmentId: id, registeredAt: "2026-11-12T08:00:00+00:00" },
      );
    const state = both(
      both({ ...EMPTY_ORBIT_ENVIRONMENT_STATE, disabledByOrbit: ["gone"] }, "gone"),
      "kept",
    );
    const forgotten = forgetOrbitEnvironment(state, "gone");
    expect(JSON.stringify(forgotten)).not.toContain("gone");
    expect(forgotten).toEqual({
      disabledByOrbit: [],
      pairedByOrbit: ["kept"],
      accessPairedAt: { kept: 1 },
      pairAttemptedAt: { kept: 2 },
      pairRefusedAt: { kept: "2026-11-12T08:00:00+00:00" },
    });
  });

  it("forgets a destroyed Instance's renewal and revoke records too", () => {
    const state = recordPairingRevoked(
      recordRenewal(recordPaired(EMPTY_ORBIT_ENVIRONMENT_STATE, "gone"), "gone", 1),
      "gone",
      2,
    );
    expect(JSON.stringify(forgetOrbitEnvironment(state, "gone"))).not.toContain("gone");
  });
});

describe("session renewal", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => DateTime.makeUnsafe(ms);

  describe("sessionRenewalReason", () => {
    it("renews a session that ends within seven days, or has ended", () => {
      const reason = (session: Parameters<typeof sessionRenewalReason>[0]["session"]) =>
        sessionRenewalReason({ authenticationRefused: false, session, now });
      expect(reason({ authenticated: true, expiresAt: at(now + 30 * day) })).toBeNull();
      expect(reason({ authenticated: true, expiresAt: at(now + SESSION_RENEW_BEFORE_MS) })).toBe(
        null,
      );
      expect(reason({ authenticated: true, expiresAt: at(now + 6 * day) })).toBe("expiring");
      expect(reason({ authenticated: true, expiresAt: at(now - 1) })).toBe("expired");
      expect(reason({ authenticated: false })).toBe("expired");
      // A session without an end (a cookie session) or not read yet needs nothing.
      expect(reason({ authenticated: true })).toBeNull();
      expect(reason(null)).toBeNull();
    });

    it("counts a connection blocked on its credential as an ended session", () => {
      expect(sessionRenewalReason({ authenticationRefused: true, session: null, now })).toBe(
        "expired",
      );
    });
  });

  const input = (state: OrbitEnvironmentState, extra: Record<string, unknown> = {}) => ({
    provider: "orbit" as const,
    saved: [saved("beast"), saved("mini"), saved("shark"), saved("nick")],
    orbit: [orbit("beast"), orbit("mini"), orbit("shark"), orbit("nick")],
    state,
    renew: [
      { environmentId: "beast", reason: "expired" as const },
      { environmentId: "mini", reason: "expired" as const },
      { environmentId: "shark", reason: "expiring" as const },
    ],
    now,
    ...extra,
  });

  it("renews every saved server whose session ends soon or has ended, in one plan", () => {
    const plan = planEnvironmentProvider(input(EMPTY_ORBIT_ENVIRONMENT_STATE));
    expect(plan.pair).toEqual(["beast", "mini", "shark"]);
    expect(plan.renew).toEqual(["beast", "mini", "shark"]);
  });

  it("backs off 5 minutes after renewing an ended session, 6 hours for one that ends soon", () => {
    let state = EMPTY_ORBIT_ENVIRONMENT_STATE;
    for (const id of ["beast", "mini", "shark"]) state = recordRenewal(state, id, now);
    expect(planEnvironmentProvider(input(state, { now: now + 60_000 })).pair).toEqual([]);
    expect(
      planEnvironmentProvider(input(state, { now: now + EXPIRED_RENEWAL_RETRY_MS })).renew,
    ).toEqual(["beast", "mini"]);
    expect(
      planEnvironmentProvider(input(state, { now: now + EXPIRING_RENEWAL_RETRY_MS })).renew,
    ).toEqual(["beast", "mini", "shark"]);
  });

  it("never renews a server whose pairing Orbit revoked, until an explicit Connect", () => {
    const revoked = recordPairingRevoked(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", now);
    expect(isPairingRevoked(revoked, "beast")).toBe(true);
    const later = input(revoked, { now: now + 365 * day });
    expect(planEnvironmentProvider(later).renew).toEqual(["mini", "shark"]);
    // Nor does the access re-pair bring it back.
    expect(planEnvironmentProvider({ ...later, renew: [], lacksAccess: ["beast"] }).pair).toEqual(
      [],
    );
    const connected = forgetPairingRevoked(revoked, "beast");
    expect(isPairingRevoked(connected, "beast")).toBe(false);
    expect(planEnvironmentProvider(input(connected)).renew).toEqual(["beast", "mini", "shark"]);
  });

  it("keeps the revoked state across a reload and a switch to Default", () => {
    const revoked = recordRenewal(
      recordPairingRevoked(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", 7),
      "mini",
      9,
    );
    const reloaded = parseOrbitEnvironmentState(JSON.parse(JSON.stringify(revoked)));
    expect(reloaded.revokedAt).toEqual({ beast: 7 });
    expect(reloaded.renewedAt).toEqual({ mini: 9 });
    const toDefault = planEnvironmentProvider({
      provider: "default",
      saved: [],
      orbit: null,
      state: reloaded,
    });
    expect(isPairingRevoked(toDefault.state, "beast")).toBe(true);
  });

  it("never renews a removed Instance's server, and waits for a stopped one", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("removed-clone"), saved("asleep-clone"), saved("expired-admin")],
      // A removed Instance's server has left the Gateway's list.
      orbit: [
        { ...orbit("asleep-clone", "registered", 43), powerState: "stopped" },
        orbit("expired-admin", "session_expired", 44),
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      renew: ["removed-clone", "asleep-clone", "expired-admin"].map((environmentId) => ({
        environmentId,
        reason: "expired" as const,
      })),
      now,
    });
    expect(plan.pair).toEqual([]);
    expect(plan.disable).toEqual(["removed-clone"]);
  });

  it("renews a server T3 refused for good only after it registers again", () => {
    const refused = recordPairingRefused(
      recordRenewal(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", now),
      orbit("beast"),
    );
    const later = input(refused, { now: now + day });
    expect(planEnvironmentProvider(later).renew).toEqual(["mini", "shark"]);
    const registeredAgain = { ...orbit("beast"), registeredAt: "2026-11-13T08:00:00+00:00" };
    expect(
      planEnvironmentProvider({
        ...later,
        orbit: [registeredAgain, orbit("mini"), orbit("shark")],
      }).renew,
    ).toEqual(["beast", "mini", "shark"]);
  });

  it("leaves the clone a thread start pairs itself", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("clone")],
      orbit: [orbit("clone", "registered", 41)],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      renew: [{ environmentId: "clone", reason: "expired" }],
      heldInstanceIds: [41],
      now,
    });
    expect(plan.pair).toEqual([]);
  });

  // Conn: on a return to the front the connection retries at once and reads `connecting` while it
  // keeps the server's refusal; the phase alone missed it (seen in the iOS simulator, 2026-11-13).
  describe("connectionRefusedCredential", () => {
    const refused = new ConnectionBlockedError({
      reason: "authentication",
      detail: "The environment credential is invalid.",
    });
    it("reads a refusal while blocked and while the next attempt runs", () => {
      expect(connectionRefusedCredential({ phase: "blocked", lastFailure: refused })).toBe(true);
      expect(connectionRefusedCredential({ phase: "connecting", lastFailure: refused })).toBe(true);
    });
    it("ignores a connected server, other failures and a missing state", () => {
      expect(connectionRefusedCredential({ phase: "connected", lastFailure: refused })).toBe(false);
      expect(
        connectionRefusedCredential({
          phase: "connecting",
          lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "Slow." }),
        }),
      ).toBe(false);
      expect(
        connectionRefusedCredential({
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({ reason: "permission", detail: "Scope." }),
        }),
      ).toBe(false);
      expect(connectionRefusedCredential(null)).toBe(false);
    });
  });
});

describe("session renewal, shared by desktop and phone", () => {
  const refused = new ConnectionBlockedError({
    reason: "authentication",
    detail: "The environment credential is invalid.",
  });
  const now = Date.parse("2026-12-13T10:00:00Z");
  const session = (endsAt: string) => ({
    authenticated: true,
    expiresAt: DateTime.makeUnsafe(Date.parse(endsAt)),
  });

  it("reads every server that needs a renewal, including a refusal while the next attempt runs", () => {
    // 12 Nov 2026: four servers ended at once. The desktop read a refusal only while "blocked",
    // so a window brought to the front (which moves it to "connecting") hid it.
    const connections: Record<
      string,
      { phase: "blocked" | "connecting" | "connected"; lastFailure: ConnectionBlockedError | null }
    > = {
      mini: { phase: "connecting", lastFailure: refused },
      beast: { phase: "blocked", lastFailure: refused },
      shark: { phase: "connected", lastFailure: null },
      nick: { phase: "connected", lastFailure: null },
    };
    const sessions: Record<string, ReturnType<typeof session> | null> = {
      mini: null,
      beast: null,
      shark: session("2026-12-15T10:00:00Z"),
      nick: session("2027-01-30T10:00:00Z"),
    };
    expect(
      readSessionRenewals({
        environmentIds: ["mini", "beast", "shark", "nick"],
        readConnection: (id) => connections[id] ?? null,
        readSession: (id) => sessions[id] ?? null,
        now,
      }),
    ).toEqual([
      { environmentId: "mini", reason: "expired" },
      { environmentId: "beast", reason: "expired" },
      { environmentId: "shark", reason: "expiring" },
    ]);
  });

  it("calls onRefused once per refusal, again after the server connected, and stops watching removed servers", () => {
    const listeners = new Map<
      string,
      (
        connection: {
          phase: "blocked" | "connecting" | "connected";
          lastFailure: ConnectionBlockedError | null;
        } | null,
      ) => void
    >();
    const refusals: string[] = [];
    const watch = createCredentialRefusalWatch({
      subscribe: (id, listener) => {
        listeners.set(id, listener);
        return () => listeners.delete(id);
      },
      onRefused: (id) => refusals.push(id),
    });
    watch.watch(["mini", "beast"]);
    listeners.get("mini")?.({ phase: "blocked", lastFailure: refused });
    listeners.get("mini")?.({ phase: "connecting", lastFailure: refused });
    listeners.get("beast")?.({ phase: "blocked", lastFailure: refused });
    listeners.get("mini")?.({ phase: "connected", lastFailure: null });
    listeners.get("mini")?.({ phase: "blocked", lastFailure: refused });
    expect(refusals).toEqual(["mini", "beast", "mini"]);
    watch.watch(["mini"]);
    expect([...listeners.keys()]).toEqual(["mini"]);
  });

  it("names each failure in plain words and never shows a code", () => {
    const gateway = (code: string) =>
      new OrbitGatewayError({ code, message: code, status: 409, details: {} });
    const reasons = [
      gateway("conn.session_expired"),
      gateway("conn.pairing_revoked"),
      gateway("gateway.unreachable"),
      gateway("conn.server_unreachable"),
      gateway("conn.request_refused"),
      new ConnectionTransientError({ reason: "network", detail: "no answer" }),
      refused,
      gateway("conn.something_new"),
      new Error("boom"),
    ].map(renewalFailureReason);
    expect(reasons).toEqual([
      "session_ended",
      "revoked",
      "orbit_unreachable",
      "server_unreachable",
      "link_refused",
      "server_unreachable",
      "link_refused",
      "unknown",
      "unknown",
    ]);
    expect(reasons.map(renewalFailureText)).toEqual([
      "Could not renew: Orbit's session on this server ended.",
      "Could not renew: revoked in Orbit.",
      "Could not renew: Orbit is not reachable.",
      "Could not renew: the server is not reachable.",
      "Could not renew: the server refused the link.",
      "Could not renew: the server is not reachable.",
      "Could not renew: the server refused the link.",
      "Could not renew.",
      "Could not renew.",
    ]);
  });

  it("keeps a failed renewal across a restart until a pairing succeeds or Orbit removes the server", () => {
    const failed = recordRenewalFailed(EMPTY_ORBIT_ENVIRONMENT_STATE, "mini", {
      at: now,
      reason: "orbit_unreachable",
    });
    const reloaded = parseOrbitEnvironmentState(JSON.parse(JSON.stringify(failed)));
    expect(reloaded.renewalFailed).toEqual({ mini: { at: now, reason: "orbit_unreachable" } });
    expect(
      parseOrbitEnvironmentState({
        renewalFailed: { a: { at: 1, reason: "new" }, b: { reason: "x" } },
      }).renewalFailed,
    ).toEqual({ a: { at: 1, reason: "unknown" } });
    expect(forgetRenewalFailure(reloaded, "mini").renewalFailed).toEqual({});
    expect(forgetOrbitEnvironment(reloaded, "mini").renewalFailed).toEqual({});
  });
});
