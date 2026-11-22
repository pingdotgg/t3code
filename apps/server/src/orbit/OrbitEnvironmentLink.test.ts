import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PeerLink,
  type PeerLinkCreateInput,
  PeerLinkError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { makeLink, orbitGatewayTransport } from "./OrbitEnvironmentLink.ts";
import type { OrbitGatewayRequest, OrbitGatewayResponse } from "./OrbitGateway.ts";

const CODE = "SECRETCODE42";
const PAIRING_URL = `http://10.44.0.51:3773/pair#token=${CODE}`;
const ENVIRONMENT = {
  environment_id: "env-clone",
  label: "clone",
  url: "http://10.44.0.51:3773",
  status: "registered",
};
const PAIRING = {
  pairing_url: PAIRING_URL,
  pairing: { id: 7, environment_id: "env-clone", expires_at: "2026-11-10T10:05:00Z" },
};
const ok = (data: unknown, status = 200): OrbitGatewayResponse => ({ status, body: { data } });
const refused = (status: number, code: string): OrbitGatewayResponse => ({
  status,
  body: { error: { code, message: `refused ${code}`, details: {} } },
});

type Route = (request: OrbitGatewayRequest) => OrbitGatewayResponse | undefined;

/** Runs one link against a scripted Gateway and PeerLinks, with captured logs. */
const run = (options: {
  readonly routes: ReadonlyArray<Route>;
  readonly enabled?: boolean;
  readonly linkError?: PeerLinkError;
}) =>
  Effect.gen(function* () {
    const requests: OrbitGatewayRequest[] = [];
    const linkInputs: PeerLinkCreateInput[] = [];
    const logs: unknown[] = [];
    let now = 0;
    const request = (input: OrbitGatewayRequest) =>
      Effect.sync(() => {
        requests.push(input);
        for (const route of options.routes) {
          const response = route(input);
          if (response !== undefined) return response;
        }
        return refused(404, "not_found");
      });
    const link = makeLink({
      transport: (gatewayUrl) => orbitGatewayTransport(request, gatewayUrl, Effect.runPromise),
      clientOptions: {
        realtime: false,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
      links: {
        enabled: Effect.succeed(options.enabled ?? true),
        link: (input) =>
          Effect.gen(function* () {
            linkInputs.push(input);
            if (options.linkError) return yield* options.linkError;
            const linkedAt = DateTime.makeUnsafe("2026-11-10T10:00:00Z");
            const linked: PeerLink = {
              environmentId: EnvironmentId.make("env-clone"),
              label: "clone",
              urls: [input.url],
              access: input.access,
              linkedAt,
              expiresAt: DateTime.add(linkedAt, { days: 30 }),
              lastReachedAt: linkedAt,
              lastError: null,
            };
            yield* Effect.logInfo("peer link called");
            return linked;
          }),
      },
    });
    const result = yield* link({
      environmentId: "env-clone",
      access: "full-access",
    }).pipe(
      Effect.result,
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
      Effect.provideService(References.MinimumLogLevel, "Trace"),
    );
    return { result, requests, linkInputs, logs };
  });

const listEnvironments =
  (environment: object = ENVIRONMENT): Route =>
  (request) =>
    request.method === "GET" && request.path === "/api/v1/conn/environments"
      ? ok([environment])
      : undefined;
const isPairingPost = (request: OrbitGatewayRequest) =>
  request.method === "POST" && request.path === "/api/v1/conn/environments/env-clone/pairings";
const pairingPosts = (requests: ReadonlyArray<OrbitGatewayRequest>) =>
  requests.filter(isPairingPost).length;

describe("OrbitEnvironmentLink", () => {
  it.effect("links with the code from the pairing link and returns only the outcome", () =>
    Effect.gen(function* () {
      const { result, linkInputs, logs } = yield* run({
        routes: [listEnvironments(), (r) => (isPairingPost(r) ? ok(PAIRING, 201) : undefined)],
      });
      assert.deepStrictEqual(result._tag === "Success" ? result.success : result.failure, {
        environmentId: EnvironmentId.make("env-clone"),
        label: "clone",
        access: "full-access",
        expiresAt: "2026-12-10T10:00:00.000Z",
      });
      assert.strictEqual(linkInputs.length, 1);
      assert.strictEqual(linkInputs[0]!.pairingCode, CODE);
      assert.strictEqual(linkInputs[0]!.url, ENVIRONMENT.url);
      assert.strictEqual(linkInputs[0]!.expectedEnvironmentId, "env-clone");
      assert.isAbove(logs.length, 0);
      assert.notInclude(JSON.stringify(logs), CODE);
      assert.notInclude(JSON.stringify(logs), "pair#token");
      assert.notInclude(JSON.stringify(result), CODE);
    }),
  );

  it.effect("follows the pairing Operation, then reads the link once", () =>
    Effect.gen(function* () {
      let reads = 0;
      const { result, requests, logs } = yield* run({
        routes: [
          listEnvironments(),
          (r) =>
            isPairingPost(r)
              ? ok({ id: 5, status: "running", poll_after_seconds: 1 }, 202)
              : undefined,
          (r) =>
            r.path === "/api/v1/conn/operations/5"
              ? ok(
                  ++reads < 2
                    ? { id: 5, status: "running", poll_after_seconds: 1 }
                    : { id: 5, status: "succeeded", result: { pairing_id: 7 } },
                )
              : undefined,
          (r) =>
            r.path === "/api/v1/conn/environments/env-clone/pairings/7" ? ok(PAIRING) : undefined,
        ],
      });
      assert.strictEqual(result._tag, "Success");
      assert.strictEqual(pairingPosts(requests), 1);
      assert.strictEqual(requests.filter((r) => r.path.endsWith("/pairings/7")).length, 1);
      assert.notInclude(JSON.stringify(logs), CODE);
    }),
  );

  it.effect("stops at the deadline without starting a second pairing", () =>
    Effect.gen(function* () {
      const { result, requests, linkInputs } = yield* run({
        routes: [
          listEnvironments(),
          (r) =>
            isPairingPost(r)
              ? ok({ id: 5, status: "running", poll_after_seconds: 5 }, 202)
              : undefined,
          (r) =>
            r.path === "/api/v1/conn/operations/5"
              ? ok({ id: 5, status: "running", poll_after_seconds: 5 })
              : undefined,
        ],
      });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, "pairing_pending");
      assert.strictEqual(pairingPosts(requests), 1);
      assert.strictEqual(linkInputs.length, 0);
    }),
  );

  it.effect.each([
    {
      name: "no Node access",
      status: 403,
      code: "node_access.required",
      want: "node_access_required",
    },
    {
      name: "an unknown Node",
      status: 403,
      code: "peer.identity_unknown",
      want: "node_access_required",
    },
    {
      name: "an expired session",
      status: 409,
      code: "conn.session_expired",
      want: "session_expired",
    },
    {
      name: "a refused pairing",
      status: 502,
      code: "conn.request_refused",
      want: "pairing_failed",
    },
  ] as const)("maps $name on the pairing to $want", ({ status, code, want }) =>
    Effect.gen(function* () {
      const { result, linkInputs } = yield* run({
        routes: [listEnvironments(), (r) => (isPairingPost(r) ? refused(status, code) : undefined)],
      });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, want);
      assert.strictEqual(linkInputs.length, 0);
    }),
  );

  it.effect("refuses a listed session_expired environment before pairing", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* run({
        routes: [listEnvironments({ ...ENVIRONMENT, status: "session_expired" })],
      });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, "session_expired");
      assert.strictEqual(pairingPosts(requests), 0);
    }),
  );

  it.effect("calls nothing while Linked environments is off here", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* run({ routes: [], enabled: false });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, "links_off");
      assert.strictEqual(requests.length, 0);
    }),
  );

  it.effect.each([
    { reason: "peer_disabled", want: "target_links_off" },
    { reason: "unreachable", want: "link_failed" },
  ] as const)("maps a $reason link failure to $want", ({ reason, want }) =>
    Effect.gen(function* () {
      const { result } = yield* run({
        routes: [listEnvironments(), (r) => (isPairingPost(r) ? ok(PAIRING, 201) : undefined)],
        linkError: new PeerLinkError({ reason, message: "The peer said no." }),
      });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, want);
      assert.notInclude(JSON.stringify(result), CODE);
    }),
  );

  it.effect("maps a failed pairing Operation by its error code", () =>
    Effect.gen(function* () {
      const { result, requests } = yield* run({
        routes: [
          listEnvironments(),
          (r) => (isPairingPost(r) ? ok({ id: 5, status: "running" }, 202) : undefined),
          (r) =>
            r.path === "/api/v1/conn/operations/5"
              ? ok({ id: 5, status: "failed", error_code: "conn.session_expired" })
              : undefined,
        ],
      });
      assert.strictEqual(result._tag === "Failure" ? result.failure.code : null, "session_expired");
      assert.strictEqual(pairingPosts(requests), 1);
    }),
  );

  it.effect("refuses a pairing for another environment", () =>
    Effect.gen(function* () {
      const other = { ...PAIRING, pairing: { ...PAIRING.pairing, environment_id: "env-other" } };
      const { result, linkInputs } = yield* run({
        routes: [listEnvironments(), (r) => (isPairingPost(r) ? ok(other, 201) : undefined)],
      });
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(linkInputs.length, 0);
    }),
  );
  it.effect("passes a request's Idempotency-Key to the Gateway", () =>
    Effect.gen(function* () {
      const seen: OrbitGatewayRequest[] = [];
      const transport = orbitGatewayTransport(
        (request) =>
          Effect.sync(() => {
            seen.push(request);
            return ok({ id: 9, status: "running" }, 202);
          }),
        "https://gateway.orbit",
        Effect.runPromise,
      );
      yield* Effect.promise(() =>
        transport({ method: "POST", path: "/x", timeoutMs: 60_000, idempotencyKey: "key-1" }),
      );
      yield* Effect.promise(() => transport({ method: "GET", path: "/y" }));
      assert.strictEqual(seen[0]?.idempotencyKey, "key-1");
      assert.strictEqual(seen[0]?.path, "/api/v1/conn/x");
      assert.isFalse("idempotencyKey" in (seen[1] ?? {}));
    }),
  );
});
