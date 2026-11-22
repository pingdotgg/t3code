import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";
import { BearerConnectionTarget } from "../connection/model.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  provisionalPairingsInCatalog,
  recoverProvisionalPairings,
  registerConnectionInCatalog,
  settleProvisionalPairingInCatalog,
} from "../platform/storageDocument.ts";

import {
  OrbitGatewayError,
  createOrbitGatewayClient,
  type OrbitGatewayOperation,
  type OrbitGatewayPairing,
  type OrbitGatewayRequest,
  type OrbitGatewayReservation,
} from "./client.ts";
import {
  MAX_OPEN_RESERVATIONS,
  RESERVATION_KEEPALIVE_MS,
  RESERVATION_PREPARING_POLL_MS,
  createOrbitReservations,
  type OrbitReservationClient,
} from "./reservations.ts";
import {
  createOrbitInstanceNameFits,
  newOrbitThreadStart,
  orbitThreadStartHiddenEnvironmentId,
  runOrbitThreadStart,
  type OrbitThreadStart,
} from "./threadStart.ts";

const reservation = (
  id: string,
  state: OrbitGatewayReservation["state"],
  extra: Partial<OrbitGatewayReservation> = {},
): OrbitGatewayReservation => ({
  id,
  projectId: 78,
  instanceId: 501,
  state,
  expiresAt: "2026-11-21T12:10:00Z",
  createOperationId: 300,
  environmentId: state === "preparing" ? null : `env-${id}`,
  finalizeOperationId: null,
  errorCode: null,
  pairing: null,
  ...extra,
});

const issued = (environmentId: string): OrbitGatewayPairing => ({
  environmentId,
  pairingUrl: "http://clone.test/pair#token=issued-once",
  expiresAt: "2026-11-21T12:05:00Z",
});

const gone = () =>
  new OrbitGatewayError({
    code: "reservation.not_found",
    message: "gone",
    status: 404,
    details: {},
  });

/** A step-by-step clock: each `sleep` resolves only when the test calls `tick`. */
function scheduler() {
  const waiting: Array<{ ms: number; resolve: () => void }> = [];
  let elapsed = 0;
  return {
    sleeps: waiting,
    /** The time the resolved sleeps added up to. */
    elapsed: () => elapsed,
    sleep: (ms: number) => new Promise<void>((resolve) => waiting.push({ ms, resolve })),
    async tick() {
      const next = waiting.shift();
      elapsed += next?.ms ?? 0;
      next?.resolve();
      await flush();
      return next?.ms;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(
  options: {
    reads?: Array<OrbitGatewayReservation | Error>;
    read?: (id: string) => Promise<OrbitGatewayReservation>;
    connect?: (environmentId: string, pairingUrl: string) => Promise<void>;
    forget?: (environmentId: string, installId: string) => Promise<void> | void;
    hasTakenStart?: (reservationId: string, environmentId: string) => boolean;
    reserve?: (projectId: number) => Promise<OrbitGatewayReservation>;
    saved?: (environmentId: string) => boolean;
    stored?: string[];
  } = {},
) {
  const calls: string[] = [];
  const reads = [...(options.reads ?? [])];
  let stored: readonly string[] = options.stored ?? [];
  const clock = scheduler();
  const client: OrbitReservationClient = {
    reserve: async (projectId) => {
      calls.push(`reserve ${projectId}`);
      return options.reserve
        ? options.reserve(projectId)
        : reservation(`r${projectId}`, "preparing", { projectId });
    },
    reservation: async (id) => {
      calls.push(`read ${id}`);
      if (options.read) return options.read(id);
      const next = reads.shift();
      if (next === undefined) return reservation(id, "ready");
      if (next instanceof Error) throw next;
      return next;
    },
    releaseReservation: async (id) => {
      calls.push(`release ${id}`);
      return null;
    },
    pair: async (environmentId) => {
      calls.push(`pair ${environmentId}`);
      return { environmentId, pairingUrl: `https://pair/${environmentId}`, expiresAt: "" };
    },
  };
  let now = 0;
  const reservations = createOrbitReservations({
    client,
    sleep: clock.sleep,
    // Each read of the clock is a little later; a tick moves it by the sleep it resolved.
    now: () => clock.elapsed() + now++ / 1_000,
    isSaved: options.saved ?? (() => false),
    connect: async (environmentId, pairingUrl) => {
      calls.push(`connect ${environmentId}`);
      await options.connect?.(environmentId, pairingUrl);
    },
    ...(options.hasTakenStart ? { hasTakenStart: options.hasTakenStart } : {}),
    forget: (environmentId, installId) => {
      calls.push(`forget ${environmentId}`);
      return options.forget?.(environmentId, installId);
    },
    promote: () => {},
    load: () => stored,
    store: (ids) => {
      stored = ids;
    },
    newKey: () => "key",
  });
  return { calls, clock, reservations, stored: () => stored };
}

describe("createOrbitReservations", () => {
  it("reserves on open, polls every 2 s while preparing, pairs once ready, then reads every 60 s", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [
        reservation("r78", "preparing"),
        reservation("r78", "ready"),
        reservation("r78", "ready", { pairing: issued("env-r78") }),
      ],
    });
    reservations.open(78);
    reservations.open(78);
    await flush();
    expect(calls).toEqual(["reserve 78"]);
    expect(stored()).toEqual(["r78"]);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    // Ready before the Gateway minted its link: read again soon instead of pairing explicitly.
    expect(calls).toEqual(["reserve 78", "read r78", "read r78"]);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(calls).toEqual(["reserve 78", "read r78", "read r78", "read r78", "connect env-r78"]);
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r78"]));
    expect(clock.sleeps.map((entry) => entry.ms)).toEqual([RESERVATION_KEEPALIVE_MS]);
    await clock.tick();
    // Paired once; the keep-alive read only.
    expect(calls.slice(5)).toEqual(["read r78"]);
  });

  it("pairs explicitly when the Gateway delivers no link for 4 s of ready reads", async () => {
    const { calls, clock, reservations } = harness({
      reserve: async () => reservation("r78", "ready"),
    });
    reservations.open(78);
    await flush();
    expect(calls).toEqual(["reserve 78", "read r78"]);
    expect(RESERVATION_PREPARING_POLL_MS).toBe(500);
    // Read every 500 ms while the link is not there; the read 4 s after the first pairs explicitly.
    for (let tick = 0; tick < 8; tick++) {
      expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    }
    expect(calls).toEqual([
      "reserve 78",
      ...Array.from({ length: 9 }, () => "read r78"),
      "pair env-r78",
      "connect env-r78",
    ]);
    expect(clock.sleeps.map((entry) => entry.ms)).toEqual([RESERVATION_KEEPALIVE_MS]);
  });

  it("installs a link that comes 500 ms after ready without an explicit pairing", async () => {
    const pairing = issued("env-r78");
    const { calls, clock, reservations } = harness({
      reserve: async () => reservation("r78", "preparing"),
      reads: [reservation("r78", "ready"), reservation("r78", "ready", { pairing })],
    });
    reservations.open(78);
    await flush();
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(calls).toEqual(["reserve 78", "read r78", "read r78", "connect env-r78"]);
    expect(clock.sleeps.map((entry) => entry.ms)).toEqual([RESERVATION_KEEPALIVE_MS]);
  });

  it("installs the issued link from the first GET even if reserve already returned ready", async () => {
    const pairing = issued("env-r78");
    const install = Promise.withResolvers<void>();
    const urls: string[] = [];
    const { calls, clock, reservations, stored } = harness({
      reserve: async () => reservation("r78", "ready"),
      reads: [reservation("r78", "ready", { pairing }), reservation("r78", "ready")],
      connect: async (_id, url) => {
        urls.push(url);
        await install.promise;
      },
    });
    reservations.open(78);
    await flush();
    expect(calls).toEqual(["reserve 78", "read r78", "connect env-r78"]);
    expect(urls).toEqual([pairing.pairingUrl]);
    expect(clock.sleeps).toHaveLength(0);
    expect(stored()).toEqual(["r78"]);
    install.resolve();
    await flush();
    expect(await clock.tick()).toBe(RESERVATION_KEEPALIVE_MS);
    expect(calls).toEqual(["reserve 78", "read r78", "connect env-r78", "read r78"]);
  });

  it("ignores a link delivered by a read that finishes after close", async () => {
    const read = Promise.withResolvers<OrbitGatewayReservation>();
    const { calls, clock, reservations, stored } = harness({ read: () => read.promise });
    reservations.open(78);
    await flush();
    await clock.tick();
    reservations.close(78);
    read.resolve(reservation("r78", "ready", { pairing: issued("env-r78") }));
    await flush();
    expect(calls).toEqual(["reserve 78", "read r78", "release r78"]);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
    expect(stored()).toEqual([]);
  });

  it("releases on close and forgets the paired server", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [reservation("r78", "ready", { pairing: issued("env-r78") })],
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    reservations.close(78);
    await flush();
    expect(calls.slice(-2)).toEqual(["release r78", "forget env-r78"]);
    expect(stored()).toEqual([]);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
    await clock.tick();
    expect(calls.at(-1)).toBe("forget env-r78");
  });

  it("releases a reservation that Orbit admits after the prompt closed", async () => {
    let admit!: (value: OrbitGatewayReservation) => void;
    const { calls, reservations } = harness({
      reserve: () => new Promise((resolve) => (admit = resolve)),
    });
    reservations.open(78);
    reservations.close(78);
    admit(reservation("r78", "preparing"));
    await flush();
    expect(calls).toEqual(["reserve 78", "release r78"]);
  });

  it("hands a ready reservation to the send, and stops holding it", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [reservation("r78", "ready")],
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    expect(reservations.take(78)).toEqual({
      reservationId: "r78",
      instanceId: 501,
      environmentId: "env-r78",
    });
    expect(stored()).toEqual([]);
    await clock.tick();
    expect(calls).not.toContain("release r78");
    expect(calls.filter((call) => call === "read r78")).toHaveLength(1);
  });

  it("gives the send nothing while the reserve is unanswered, and releases it later", async () => {
    let admit!: (value: OrbitGatewayReservation) => void;
    const { calls, reservations } = harness({
      reserve: () => new Promise((resolve) => (admit = resolve)),
    });
    reservations.open(78);
    expect(reservations.take(78)).toBeNull();
    admit(reservation("r78", "preparing"));
    await flush();
    expect(calls).toEqual(["reserve 78", "release r78"]);
  });

  it("drops a reservation that failed, expired, or that Orbit released for a fourth", async () => {
    const failed = harness({ reads: [reservation("r78", "failed")] });
    failed.reservations.open(78);
    await flush();
    await failed.clock.tick();
    expect(failed.calls).toContain("release r78");
    expect(failed.reservations.take(78)).toBeNull();

    const released = harness({
      reads: [reservation("r78", "ready", { pairing: issued("env-r78") }), gone()],
    });
    released.reservations.open(78);
    await flush();
    await released.clock.tick();
    await released.clock.tick();
    expect(released.calls.slice(-1)).toEqual(["forget env-r78"]);
    expect(released.reservations.take(78)).toBeNull();
  });

  it("keeps a reservation through a short Gateway outage", async () => {
    const outage = new OrbitGatewayError({
      code: "gateway.unreachable",
      message: "",
      status: 0,
      details: {},
    });
    const { clock, reservations } = harness({ reads: [outage, reservation("r78", "ready")] });
    reservations.open(78);
    await flush();
    await clock.tick();
    await clock.tick();
    expect(reservations.take(78)?.reservationId).toBe("r78");
  });

  it(`holds at most ${MAX_OPEN_RESERVATIONS}: a fourth Project releases the oldest`, async () => {
    const { calls, reservations } = harness();
    for (const projectId of [1, 2, 3]) reservations.open(projectId);
    await flush();
    reservations.open(4);
    await flush();
    expect(calls).toEqual(["reserve 1", "reserve 2", "reserve 3", "release r1", "reserve 4"]);
  });

  it("does not pair or forget a server the device saved already", async () => {
    const { calls, clock, reservations } = harness({
      reads: [reservation("r78", "ready")],
      saved: () => true,
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    reservations.close(78);
    await flush();
    expect(calls).toEqual(["reserve 78", "read r78", "release r78"]);
  });

  function pairingCatalog() {
    const environmentId = EnvironmentId.make("env-r1");
    const json = Schema.fromJsonString(ConnectionCatalogDocument);
    const decode = Schema.decodeUnknownSync(json);
    const encode = Schema.encodeSync(json);
    let durable = encode(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    const read = () => decode(durable);
    const update = (transform: (doc: ConnectionCatalogDocument) => ConnectionCatalogDocument) => {
      durable = encode(transform(read()));
    };
    return {
      read,
      update,
      save(label: string, installId?: string) {
        const connectionId = installId ? `bearer:orbit-reservation:${installId}` : "independent";
        update((doc) =>
          registerConnectionInCatalog(
            doc,
            new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                connectionId,
                environmentId,
                label,
                ...(installId === undefined ? {} : { provisionalPairingId: installId }),
              }),
              profile: new BearerConnectionProfile({
                connectionId,
                environmentId,
                label,
                httpBaseUrl: "https://clone.test",
                wsBaseUrl: "wss://clone.test",
              }),
              credential: new BearerConnectionCredential({ token: label }),
            }),
          ),
        );
      },
      forget(installId: string) {
        update((doc) => settleProvisionalPairingInCatalog(doc, installId, false));
      },
      saved: (id: string) => read().targets.some((target) => target.environmentId === id),
    };
  }

  it("preserves an independent save while a dismissed install fails before writing", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const catalog = pairingCatalog();
    const { reservations } = harness({
      saved: catalog.saved,
      forget: (_id, installId) => catalog.forget(installId),
    });
    const installing = reservations.installPairing("r1", "env-r1", async () => {
      started.resolve();
      await finish.promise;
      throw new Error("Onboarding failed before saving");
    });
    await started.promise;
    catalog.save("independent");
    const independent = catalog.read();
    const dismissing = reservations.abandon("r1");
    finish.resolve();
    await Promise.allSettled([installing, dismissing]);
    expect(catalog.read()).toEqual(independent);
  });

  it("preserves an independent replacement written before a cleanup retry", async () => {
    const catalog = pairingCatalog();
    let fail = true;
    const { reservations, clock } = harness({
      saved: catalog.saved,
      forget: (_id, installId) => {
        if (fail) throw new Error("Catalog storage unavailable");
        catalog.forget(installId);
      },
    });
    await reservations.installPairing("r1", "env-r1", async (installId) => {
      catalog.save("provisional", installId);
    });
    await reservations.abandon("r1");
    catalog.save("replacement");
    const replacement = catalog.read();
    fail = false;
    await clock.tick();
    expect(catalog.read()).toEqual(replacement);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
  });

  it.effect("replays pending pairing removal after restart", () =>
    Effect.gen(function* () {
      const catalog = pairingCatalog();
      const old = harness({
        saved: catalog.saved,
        forget: () => {
          throw new Error("Catalog storage unavailable");
        },
      });
      yield* Effect.promise(() =>
        old.reservations.installPairing("r1", "env-r1", async (installId) => {
          catalog.save("provisional", installId);
        }),
      );
      yield* Effect.promise(() => old.reservations.abandon("r1"));
      expect(catalog.read().credentials).toHaveLength(1);
      yield* recoverProvisionalPairings({
        readStartupPairings: Effect.sync(() => provisionalPairingsInCatalog(catalog.read())),
        update: (transform) => Effect.sync(() => catalog.update(transform)),
      });
      expect(catalog.read()).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    }),
  );

  it("keeps failed cleanup hidden and shares a retry between repeat requests", async () => {
    const removal = Promise.withResolvers<void>();
    let attempts = 0;
    const { calls, clock, reservations } = harness({
      forget: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Credential storage unavailable");
        await removal.promise;
      },
    });
    await reservations.installPairing("r1", "env-r1", async () => {});
    await reservations.abandon("r1");
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r1"]));

    await clock.tick();
    const repeated = reservations.abandon("r1");
    expect(attempts).toBe(2);
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r1"]));
    removal.resolve();
    await repeated;
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
    expect(calls).toEqual(["release r1", "forget env-r1", "forget env-r1"]);
  });

  it("keeps a server hidden that is being saved at close, then forgets it", async () => {
    let finishConnect!: () => void;
    const calls: string[] = [];
    const clock = scheduler();
    const reservations = createOrbitReservations({
      client: {
        reserve: async () => reservation("r78", "ready"),
        reservation: async (id) =>
          reservation(id, "ready", { pairing: issued(id.replace("r", "env-r")) }),
        releaseReservation: async (id) => {
          calls.push(`release ${id}`);
          return null;
        },
        pair: async (environmentId) => ({ environmentId, pairingUrl: "u", expiresAt: "" }),
      },
      sleep: clock.sleep,
      now: () => 0,
      isSaved: () => false,
      connect: () => new Promise<void>((resolve) => (finishConnect = resolve)),
      forget: (environmentId) => {
        calls.push(`forget ${environmentId}`);
      },
      promote: () => {},
      load: () => [],
      store: () => {},
      newKey: () => "key",
    });
    reservations.open(78);
    await flush();
    reservations.close(78);
    await flush();
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r78"]));
    expect(calls).toEqual(["release r78"]);
    finishConnect();
    await flush();
    expect(calls).toEqual(["release r78", "forget env-r78"]);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
  });

  it("releases what an earlier run of the app left open", async () => {
    const { calls, reservations, stored } = harness({ stored: ["old-1", "old-2"] });
    await reservations.releaseLeftovers();
    expect(calls).toEqual(["release old-1", "release old-2"]);
    expect(stored()).toEqual([]);
  });
});

describe("reservation calls", () => {
  function client(answers: Array<{ status: number; body: unknown }>) {
    const requests: OrbitGatewayRequest[] = [];
    const gatewayClient = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      const answer = answers.shift()!;
      return { status: answer.status, body: answer.body === "" ? "" : JSON.stringify(answer.body) };
    });
    return { requests, gatewayClient };
  }
  const wire = {
    id: "0b6c1c2e-5d7a-4a8e-9a39-1f1c0f6f6e01",
    project_id: 78,
    instance_id: 501,
    state: "ready",
    expires_at: "2026-11-21T12:10:00Z",
    create_operation_id: 300,
    environment_id: "env-1",
    finalize_operation_id: null,
    error_code: null,
    pairing: null,
  };
  const wirePairing = {
    pairing: { environment_id: "env-1", expires_at: "2026-11-21T12:05:00Z" },
    pairing_url: issued("env-1").pairingUrl,
  };

  it("reserves, reads, finalizes and releases with the contract's paths", async () => {
    const { requests, gatewayClient } = client([
      { status: 202, body: { data: { ...wire, state: "preparing", environment_id: null } } },
      { status: 200, body: { data: wire } },
      {
        status: 202,
        body: { data: { id: 900, kind: "instance.finalize", status: "queued", target_id: 501 } },
      },
      {
        status: 202,
        body: { data: { ...wire, state: "released", destroy_operation_id: 901 } },
      },
      { status: 204, body: "" },
    ]);
    expect((await gatewayClient.reserve(78, "k1")).state).toBe("preparing");
    expect(await gatewayClient.reservation(wire.id)).toEqual({
      id: wire.id,
      projectId: 78,
      instanceId: 501,
      state: "ready",
      expiresAt: "2026-11-21T12:10:00Z",
      createOperationId: 300,
      environmentId: "env-1",
      finalizeOperationId: null,
      errorCode: null,
      pairing: null,
    });
    const finalize = await gatewayClient.finalizeReservation(wire.id, "fix-login", "k2", {
      mode: "new",
      from: "main",
    });
    expect(finalize.id).toBe(900);
    expect(await gatewayClient.releaseReservation(wire.id)).toBe(901);
    expect(await gatewayClient.releaseReservation(wire.id)).toBeNull();
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /projects/78/reservations",
      `GET /reservations/${wire.id}`,
      `POST /reservations/${wire.id}/finalize`,
      `DELETE /reservations/${wire.id}`,
      `DELETE /reservations/${wire.id}`,
    ]);
    expect(requests[0]).toMatchObject({ body: {}, idempotencyKey: "k1" });
    expect(requests[2]).toMatchObject({
      body: { name: "fix-login", branch: { mode: "new", from: "main" } },
      idempotencyKey: "k2",
    });
  });

  it("accepts a pairing only from a matching ready GET and handles later null or missing values", async () => {
    const { gatewayClient } = client([
      { status: 202, body: { data: { ...wire, pairing: wirePairing } } },
      { status: 200, body: { data: { ...wire, pairing: wirePairing } } },
      { status: 200, body: { data: wire } },
      { status: 200, body: { data: { ...wire, pairing: undefined } } },
      { status: 200, body: { data: { ...wire, state: "preparing", pairing: wirePairing } } },
      {
        status: 200,
        body: {
          data: {
            ...wire,
            pairing: {
              ...wirePairing,
              pairing: { ...wirePairing.pairing, environment_id: "other" },
            },
          },
        },
      },
      { status: 200, body: { data: { ...wire, id: "other", pairing: wirePairing } } },
    ]);

    expect((await gatewayClient.reserve(78)).pairing).toBeNull();
    expect((await gatewayClient.reservation(wire.id)).pairing).toEqual(issued("env-1"));
    for (const _ of [null, undefined, "preparing", "different environment"]) {
      expect((await gatewayClient.reservation(wire.id)).pairing).toBeNull();
    }
    await expect(gatewayClient.reservation(wire.id)).rejects.toMatchObject({
      code: "gateway.response_invalid",
    });
  });

  it("throws the Gateway's refusal code", async () => {
    const { gatewayClient } = client([
      { status: 410, body: { error: { code: "reservation.expired", message: "Expired." } } },
    ]);
    await expect(gatewayClient.finalizeReservation("r", "n", "k")).rejects.toMatchObject({
      code: "reservation.expired",
      status: 410,
    });
  });
});

function op(
  id: number,
  status: OrbitGatewayOperation["status"],
  targetId = 501,
): OrbitGatewayOperation {
  return {
    id,
    kind: "x",
    status,
    targetId,
    errorCode: status === "failed" ? "instance.finalize_failed" : null,
    pollAfterSeconds: 1,
  };
}

function startHarness(script: {
  reads?: Array<OrbitGatewayReservation | Error>;
  finalize?: () => Promise<OrbitGatewayOperation>;
  finalizeStatus?: OrbitGatewayOperation["status"];
  createReadyAfterMs?: number;
  /** Reads of the finalize that still find it running. */
  finalizeRunningReads?: number;
  nameLimit?: number;
  nameFits?: ReturnType<typeof createOrbitInstanceNameFits>;
  waitForPairing?: (reservationId: string) => Promise<void> | undefined;
  reservationPairing?: ReturnType<typeof createOrbitReservations>;
  dismissed?: () => boolean;
  save?: (start: OrbitThreadStart) => void;
  connect?: (environmentId: string, pairingUrl: string) => Promise<void>;
}) {
  const calls: string[] = [];
  const reads = [...(script.reads ?? [])];
  let clock = 0;
  let createStartedAt = 0;
  const createWaits: number[] = [];
  const finalizeWaits: number[] = [];
  let finalizeReads = 0;
  const client = {
    reservation: async (id: string) => {
      calls.push(`read ${id}`);
      const next = reads.shift() ?? reservation(id, "ready");
      if (next instanceof Error) throw next;
      return next;
    },
    finalizeReservation: async (id: string, name: string, _key: string, branch?: unknown) => {
      calls.push(`finalize ${id} ${name}${branch ? " branch" : ""}`);
      return script.finalize ? script.finalize() : op(900, "queued");
    },
    releaseReservation: async (id: string) => {
      calls.push(`release ${id}`);
      return null;
    },
    createThreadInstance: async (_projectId: number, name: string) => {
      calls.push(`create ${name}`);
      createStartedAt = clock;
      return op(100, "queued", 41);
    },
    checkInstanceName: async (_projectId: number, name: string) => {
      calls.push(`check ${name}`);
      const fits = script.nameLimit === undefined || name.length <= script.nameLimit;
      return { name, available: fits, reason: fits ? null : "domain_invalid", domain: null };
    },
    operation: async (id: number) => {
      calls.push(`operation ${id}`);
      if (id === 900) {
        if (finalizeReads++ < (script.finalizeRunningReads ?? 0)) return op(900, "running");
        return op(900, script.finalizeStatus ?? "succeeded");
      }
      if (id === 100 && script.createReadyAfterMs !== undefined) {
        if (clock - createStartedAt < script.createReadyAfterMs) {
          return op(id, "running", 41);
        }
        return { ...op(id, "succeeded", 41), result: { t3: { environment_id: "env-41" } } };
      }
      return op(id, "succeeded", 41);
    },
    environments: async () => {
      calls.push("environments");
      return [501, 41].map((instanceId) => ({
        environmentId: `env-${instanceId}`,
        label: "clone",
        url: "http://clone",
        serverVersion: null,
        registeredBy: null,
        registeredAt: null,
        status: "registered" as const,
        instanceId,
        powerState: "running" as const,
        projectId: 78,
        projectName: null,
        projectSlug: null,
        instanceName: null,
        nodeName: null,
        instanceUrl: null,
        reservationId: null,
      }));
    },
    startPairing: async (environmentId: string) => {
      calls.push(`pair ${environmentId}`);
      return op(200, "queued", 9);
    },
    readPairing: async (environmentId: string) => ({
      environmentId,
      pairingUrl: "u",
      expiresAt: "",
    }),
  };
  const saves: OrbitThreadStart[] = [];
  const sent: string[] = [];
  return {
    calls,
    createWaits,
    finalizeWaits,
    client,
    saves,
    sent,
    run: (start: OrbitThreadStart, saved: (environmentId: string) => boolean = () => false) =>
      runOrbitThreadStart(start, {
        client: client as never,
        save: (next) => {
          saves.push(next);
          script.save?.(next);
        },
        sleep: async (ms) => {
          if (calls.at(-1) === "operation 100") createWaits.push(ms);
          if (calls.at(-1) === "operation 900") finalizeWaits.push(ms);
          clock += ms;
        },
        now: () => clock,
        stopped: () => script.dismissed?.() ?? false,
        dismissed: script.dismissed,
        isSaved: saved,
        reservationPairing: script.reservationPairing,
        waitForReservationPairing: script.waitForPairing,
        nameFits: script.nameFits,
        connect: async (environmentId, pairingUrl) => {
          calls.push(`connect ${environmentId}`);
          await script.connect?.(environmentId, pairingUrl);
        },
        send: async (ready) => {
          sent.push(ready.environmentId);
        },
      }),
  };
}

const reservedStart = (branch = false) =>
  newOrbitThreadStart({
    id: "s1",
    project: { id: 78, slug: "orbit", nodeName: "beast" },
    message: "Fix login",
    suffix: "k3j9",
    threadId: "t1",
    messageId: "m1",
    commandId: "c1",
    now: 0,
    instanceName: "fix-login",
    reservation: { reservationId: "r1", instanceId: 501, environmentId: "env-501" },
    ...(branch ? { branch: { mode: "existing" as const, name: "feature" } } : {}),
  });

describe("runOrbitThreadStart with a reservation", () => {
  it("finalizes the pre-paired clone and sends the first message without a create or pairing", async () => {
    const harness = startHarness({});
    const start = reservedStart(true);
    expect(orbitThreadStartHiddenEnvironmentId(start)).toBe("env-501");
    expect(await harness.run(start, (id) => id === "env-501")).toBe(true);
    // Paired while typing: no reservation read before, no environment list after the finalize.
    expect(harness.calls).toEqual(["finalize r1 fix-login branch", "operation 900"]);
    expect(harness.sent).toEqual(["env-501"]);
    const last = harness.saves.at(-1)!;
    expect(last).toMatchObject({
      environmentId: "env-501",
      instanceId: 501,
      connected: true,
      error: null,
    });
    expect(orbitThreadStartHiddenEnvironmentId(last)).toBeNull();
  });

  it("waits for a preparing reservation to become ready", async () => {
    const harness = startHarness({
      reads: [reservation("r1", "preparing"), reservation("r1", "ready")],
    });
    expect(await harness.run(reservedStart(), () => false)).toBe(true);
    expect(harness.calls.slice(0, 3)).toEqual(["read r1", "read r1", "finalize r1 fix-login"]);
  });

  it("waits for a draft's in-flight GET and link install before reading the reservation", async () => {
    const read = Promise.withResolvers<OrbitGatewayReservation>();
    const install = Promise.withResolvers<void>();
    const pairing = issued("env-501");
    let saved = false;
    let hidden: string | null = null;
    const draft = harness({
      reserve: async () => reservation("r1", "preparing"),
      read: () => read.promise,
      hasTakenStart: (_id, environmentId) => {
        hidden = environmentId;
        return true;
      },
      connect: async (id, url) => {
        expect([id, url, hidden]).toEqual(["env-501", pairing.pairingUrl, "env-501"]);
        await install.promise;
        saved = true;
      },
    });
    draft.reservations.open(78);
    await flush();
    await draft.clock.tick();
    expect(draft.reservations.take(78)).toMatchObject({ reservationId: "r1" });

    const start = startHarness({
      reads: [reservation("r1", "ready", { environmentId: "env-501" })],
      waitForPairing: draft.reservations.waitForPairing,
    });
    const sending = start.run(reservedStart(), (id) => saved && id === "env-501");
    await flush();
    expect(start.calls).toEqual([]);
    read.resolve(reservation("r1", "ready", { environmentId: "env-501", pairing }));
    await flush();
    expect(draft.calls).toEqual(["reserve 78", "read r1", "connect env-501"]);
    expect(start.calls).toEqual([]);
    install.resolve();
    expect(await sending).toBe(true);
    // The install saved the server: the start finalizes without reading the reservation again.
    expect(start.calls).toEqual(["finalize r1 fix-login", "operation 900"]);
    expect(draft.reservations.waitForPairing("r1")).toBeUndefined();
    expect(draft.stored()).toEqual([]);
  });

  it.each([false, true])(
    "installs a link the start reads before finalize (install fails: %s)",
    async (fails) => {
      const pairing = issued("env-501");
      let saved = false;
      const urls: string[] = [];
      const harness = startHarness({
        reads: [
          reservation("r1", "preparing"),
          reservation("r1", "ready", { environmentId: "env-501", pairing }),
        ],
        connect: async (_id, url) => {
          urls.push(url);
          if (fails && url === pairing.pairingUrl) throw new Error(url);
          saved = true;
        },
      });
      expect(await harness.run(reservedStart(), () => saved)).toBe(true);
      expect(harness.calls.slice(0, 4)).toEqual([
        "read r1",
        "read r1",
        "connect env-501",
        "finalize r1 fix-login",
      ]);
      expect(urls).toEqual(fails ? [pairing.pairingUrl, "u"] : [pairing.pairingUrl]);
      expect(harness.calls.includes("pair env-501")).toBe(fails);
      expect(JSON.stringify(harness.saves)).not.toContain(pairing.pairingUrl);
    },
  );

  describe("abandoned pairing during a delayed install", () => {
    const old = "env-501";
    const replacement = "env-41";

    function fixture(handoff: boolean) {
      const installStarted = Promise.withResolvers<void>();
      const finishInstall = Promise.withResolvers<void>();
      const pendingRead = Promise.withResolvers<OrbitGatewayReservation>();
      const saved = new Set(["unrelated"]);
      const credentials = new Set(saved);
      const reveals: string[] = [];
      let dismissed = false;
      let hiddenByStart: string | null = handoff ? null : old;
      let installed = false;
      const sample = () => {
        if (
          saved.has(old) &&
          hiddenByStart !== old &&
          !draft.reservations.hiddenEnvironmentIds().has(old)
        ) {
          reveals.push(old);
        }
      };
      const connect = async (id: string) => {
        if (id === old) {
          installStarted.resolve();
          await finishInstall.promise;
          installed = true;
        }
        saved.add(id);
        credentials.add(id);
        sample();
      };
      const draft = harness({
        reserve: async () => reservation("r1", "preparing"),
        read: () => pendingRead.promise,
        connect,
        forget: (id) => {
          saved.delete(id);
          credentials.delete(id);
          sample();
        },
        saved: (id) => saved.has(id),
        hasTakenStart: (_id, env) => {
          if (dismissed) return false;
          hiddenByStart = env;
          sample();
          return true;
        },
      });
      draft.reservations.subscribe(sample);
      const ready = reservation("r1", "ready", { environmentId: old, pairing: issued(old) });

      return {
        draft,
        saved,
        credentials,
        reveals,
        ready,
        installed: () => installed,
        async start(options: Pick<Parameters<typeof startHarness>[0], "reads" | "finalize">) {
          if (handoff) {
            draft.reservations.open(78);
            await flush();
            await draft.clock.tick();
            expect(draft.reservations.take(78)?.reservationId).toBe("r1");
          }
          const start = startHarness({
            ...options,
            reservationPairing: draft.reservations,
            waitForPairing: draft.reservations.waitForPairing,
            dismissed: () => dismissed,
            save: (row) => {
              if (!dismissed) hiddenByStart = orbitThreadStartHiddenEnvironmentId(row);
              sample();
            },
            connect,
          });
          const sending = start.run(
            { ...reservedStart(), reservedEnvironmentId: hiddenByStart },
            (id) => saved.has(id),
          );
          if (handoff) pendingRead.resolve(ready);
          await installStarted.promise;
          return { start, sending };
        },
        dismiss: () => {
          dismissed = true;
          hiddenByStart = null;
          sample();
        },
        finishInstall: finishInstall.resolve,
      };
    }

    it.each(["start finalize 410", "handoff expired read", "handoff released read"] as const)(
      "keeps the old server hidden and removes its credential on %s",
      async (failure) => {
        const handoff = failure !== "start finalize 410";
        const flow = fixture(handoff);
        let expired = false;
        const { start, sending } = await flow.start({
          reads: handoff
            ? [reservation("r1", failure === "handoff expired read" ? "expired" : "released")]
            : [flow.ready],
          finalize: async () => {
            expect(expired).toBe(true);
            throw new OrbitGatewayError({
              code: "reservation.expired",
              message: "",
              status: 410,
              details: {},
            });
          },
        });
        expect(flow.saved.has(old)).toBe(false);
        expired = true;
        flow.finishInstall();
        expect(await sending).toBe(true);
        expect(start.sent).toEqual([replacement]);
        expect(flow.installed()).toBe(true);
        expect({
          revealed: flow.reveals,
          catalog: [...flow.saved],
          credentials: [...flow.credentials],
        }).toEqual({
          revealed: [],
          catalog: ["unrelated", replacement],
          credentials: ["unrelated", replacement],
        });
      },
    );

    it.each([false, true])(
      "keeps a dismissed start hidden until the late install is removed (handoff: %s)",
      async (handoff) => {
        const flow = fixture(handoff);
        const { start, sending } = await flow.start({ reads: [flow.ready] });
        flow.dismiss();
        flow.finishInstall();
        expect(await sending).toBe(false);
        expect(start.sent).toEqual([]);
        expect(flow.installed()).toBe(true);
        expect({
          revealed: flow.reveals,
          catalog: [...flow.saved],
          credentials: [...flow.credentials],
        }).toEqual({ revealed: [], catalog: ["unrelated"], credentials: ["unrelated"] });
      },
    );
  });

  it("uses ordinary pairing when the finalized server was not saved", async () => {
    const harness = startHarness({
      reads: [reservation("r1", "ready", { environmentId: "env-501" })],
    });
    expect(await harness.run(reservedStart())).toBe(true);
    expect(harness.calls).toContain("pair env-501");
    expect(harness.calls).not.toContain("create fix-login");
    expect(harness.sent).toEqual(["env-501"]);
  });

  it("fits the name derived from the prompt before finalizing", async () => {
    const harness = startHarness({ nameLimit: 20 });
    const start = {
      ...reservedStart(),
      message: "Please refactor the checkout payment flow handlers",
      nameSuffix: "k3j9",
    };
    expect(await harness.run(start)).toBe(true);
    expect(harness.calls).toContain("finalize r1 please-refac-k3j9");
    expect(harness.saves.at(-1)?.instanceName).toBe("please-refac-k3j9");
  });

  it("uses the name check that ran while the user typed, and checks again for another message", async () => {
    const message = "Please refactor the checkout payment flow handlers";
    const typed = startHarness({ nameLimit: 20 });
    const fits = createOrbitInstanceNameFits(typed.client as never);
    fits.prefetch(78, message, "k3j9");
    fits.prefetch(78, message, "k3j9");
    await fits.lookup(78, message, "k3j9");
    expect(typed.calls.filter((call) => call.startsWith("check"))).toHaveLength(3);

    const harness = startHarness({ nameLimit: 20, nameFits: fits });
    const start = { ...reservedStart(), message, nameSuffix: "k3j9" };
    expect(await harness.run(start)).toBe(true);
    expect(harness.calls.filter((call) => call.startsWith("check"))).toEqual([]);
    expect(harness.calls).toContain("finalize r1 please-refac-k3j9");

    // The message changed after the last check: the send checks the new names.
    const edited = startHarness({ nameLimit: 20, nameFits: fits });
    const changed = {
      ...start,
      message: "Fix the login form",
      instanceName: "fix-the-login-form-k3j9",
    };
    expect(await edited.run(changed)).toBe(true);
    expect(edited.calls).toContain("check fix-the-login-form-k3j9");
  });

  it("keeps a typed check's refusal: the start stops as its own check would", async () => {
    const message = "Please refactor the checkout payment flow handlers";
    const typed = startHarness({ nameLimit: 3 });
    const fits = createOrbitInstanceNameFits(typed.client as never);
    fits.prefetch(78, message, "k3j9");
    const harness = startHarness({ nameFits: fits });
    expect(await harness.run({ ...reservedStart(), message, nameSuffix: "k3j9" })).toBe(false);
    expect(harness.saves.at(-1)).toMatchObject({ errorCode: "route.domain_invalid" });
    expect(harness.calls.filter((call) => call.startsWith("check"))).toEqual([]);
  });

  it("checks at send when the typed check failed", async () => {
    const message = "Please refactor the checkout payment flow handlers";
    const fits = createOrbitInstanceNameFits({
      checkInstanceName: async () => {
        throw new Error("offline");
      },
    });
    fits.prefetch(78, message, "k3j9");
    await fits.lookup(78, message, "k3j9");
    expect(fits.lookup(78, message, "k3j9")).toBeUndefined();
    const harness = startHarness({ nameLimit: 20, nameFits: fits });
    expect(await harness.run({ ...reservedStart(), message, nameSuffix: "k3j9" })).toBe(true);
    expect(harness.calls).toContain("finalize r1 please-refac-k3j9");
  });

  it("reads a running finalize every 200 ms for its first 2 s", async () => {
    const harness = startHarness({ finalizeRunningReads: 14 });
    expect(await harness.run(reservedStart(), (id) => id === "env-501")).toBe(true);
    expect(harness.finalizeWaits.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
    expect(harness.finalizeWaits.slice(10)).toEqual([500, 500, 500, 500]);
    // Seen running just now: the reserved server is used without listing the environments.
    expect(harness.calls).not.toContain("environments");
    expect(harness.sent).toEqual(["env-501"]);
  });

  it("lists the environments when a reload replays a finalize under its saved key", async () => {
    const harness = startHarness({ finalize: async () => op(900, "succeeded") });
    const replayed = { ...reservedStart(), createKey: "k", instanceId: 501 };
    expect(await harness.run(replayed, (id) => id === "env-501")).toBe(true);
    expect(harness.calls).toEqual(["finalize r1 fix-login", "operation 900", "environments"]);
  });

  it("does not keep a typed refusal when a shorter name's check failed", async () => {
    const message = "Please refactor the checkout payment flow handlers";
    let calls = 0;
    const fits = createOrbitInstanceNameFits({
      checkInstanceName: async (_projectId, name) => {
        if (calls++ > 0) throw new Error("offline");
        return { name, available: false, reason: "domain_invalid", domain: null };
      },
    });
    fits.prefetch(78, message, "k3j9");
    expect(await fits.lookup(78, message, "k3j9")).toBeNull();
    expect(fits.lookup(78, message, "k3j9")).toBeUndefined();
    const harness = startHarness({ nameLimit: 20, nameFits: fits });
    expect(await harness.run({ ...reservedStart(), message, nameSuffix: "k3j9" })).toBe(true);
    expect(harness.calls).toContain("finalize r1 please-refac-k3j9");
  });

  it("lists the environments for a finalize resumed after a reload", async () => {
    const harness = startHarness({});
    const resumed = { ...reservedStart(), createKey: "k", createOperationId: 900, instanceId: 501 };
    expect(await harness.run(resumed, (id) => id === "env-501")).toBe(true);
    expect(harness.calls).toEqual(["operation 900", "environments"]);
    expect(harness.sent).toEqual(["env-501"]);
  });

  it("falls back to a create when a paired reservation ended before the send", async () => {
    const harness = startHarness({
      finalize: async () => {
        throw new OrbitGatewayError({
          code: "reservation.expired",
          message: "",
          status: 410,
          details: {},
        });
      },
    });
    expect(await harness.run(reservedStart(), (id) => id === "env-501")).toBe(true);
    expect(harness.calls.slice(0, 3)).toEqual([
      "finalize r1 fix-login",
      "release r1",
      "create fix-login",
    ]);
    expect(harness.sent).toEqual(["env-41"]);
    expect(harness.saves.every((save) => save.error === null)).toBe(true);
  });

  const fallbacks: ReadonlyArray<readonly [string, Parameters<typeof startHarness>[0]]> = [
    ["expired", { reads: [reservation("r1", "expired")] }],
    ["failed", { reads: [reservation("r1", "failed")] }],
    ["released (404)", { reads: [gone()] }],
    [
      "refused at finalize (410)",
      {
        finalize: async () => {
          throw new OrbitGatewayError({
            code: "reservation.expired",
            message: "",
            status: 410,
            details: {},
          });
        },
      },
    ],
    ["whose finalize failed", { finalizeStatus: "failed" }],
  ];

  it.each(fallbacks)(
    "falls back to a normal create, with no error, when the reservation is %s",
    async (_label, script) => {
      const harness = startHarness(script);
      expect(await harness.run(reservedStart())).toBe(true);
      expect(harness.calls).toContain("release r1");
      expect(harness.calls).toContain("create fix-login");
      expect(harness.sent).toEqual(["env-41"]);
      expect(harness.saves.every((save) => save.error === null)).toBe(true);
      expect(harness.saves.at(-1)).toMatchObject({ reservationId: null, instanceId: 41 });
    },
  );

  it("creates with its full time when the reservation stays preparing", async () => {
    const harness = startHarness({
      reads: Array.from({ length: 300 }, () => reservation("r1", "preparing")),
      createReadyAfterMs: 29 * 60_000,
    });
    expect(await harness.run(reservedStart())).toBe(true);
    // A read every 500 ms for the 2 minutes the start waits.
    expect(harness.calls.filter((call) => call === "read r1")).toHaveLength(241);
    expect(harness.calls).toContain("create fix-login");
    expect(harness.createWaits[0]).toBe(500);
    expect(harness.calls).not.toContain("environments");
    expect(harness.calls).toContain("pair env-41");
    expect(harness.saves.every((save) => save.error === null)).toBe(true);
  });

  it("stops on a taken name as a create would, keeping the reservation for Retry", async () => {
    const harness = startHarness({
      finalize: async () => {
        throw new OrbitGatewayError({
          code: "instance.name_taken",
          message: "Taken.",
          status: 409,
          details: {},
        });
      },
    });
    expect(await harness.run(reservedStart())).toBe(false);
    expect(harness.saves.at(-1)).toMatchObject({
      errorCode: "instance.name_taken",
      reservationId: "r1",
      createKey: null,
    });
    expect(harness.calls).not.toContain("create fix-login");
  });
});
