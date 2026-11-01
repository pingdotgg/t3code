// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import { T3_CONNECT_TROUBLESHOOTING_SECTIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { classifyReachability, type ReachabilityFacts } from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

vi.mock("node:net", { spy: true });

const checkedAt = "2026-10-19T00:00:00.000Z";
const connected = { pid: 1, readyConnections: 4, hostname: "env.example.test", protocol: "quic" };
const notConnected = { pid: 1, readyConnections: 0, hostname: null, protocol: null };
const facts = (overrides: Partial<ReachabilityFacts>): ReachabilityFacts => ({
  managedTunnelConfigured: true,
  connector: connected,
  endpoint: null,
  edgeReachable: null,
  exitNode: null,
  ...overrides,
});

describe("classifyReachability", () => {
  it.each([
    [{ kind: "status", status: 502 }, "origin_unreachable"],
    [{ kind: "status", status: 530 }, "no_connector"],
    [{ kind: "status", status: 530, cloudflareError: "1033" }, "no_connector"],
    [{ kind: "status", status: 530, cloudflareError: "1016" }, "unexpected_response"],
    [{ kind: "network_error" }, "timeout"],
  ] as const)("maps endpoint result %o to %s", (endpoint, cause) => {
    expect(classifyReachability(facts({ endpoint, edgeReachable: true }), checkedAt)).toMatchObject(
      { status: "unreachable", cause },
    );
  });

  it("keeps the endpoint cause when the TCP edge test cannot explain it", () => {
    // QUIC (UDP) can connect while TCP 7844 is blocked.
    expect(
      classifyReachability(
        facts({ endpoint: { kind: "status", status: 502 }, edgeReachable: false }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            protocol: null,
          },
          endpoint: { kind: "status", status: 502 },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    // Failed DNS also fails the edge lookups.
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            protocol: null,
          },
          endpoint: { kind: "dns_failed" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "dns_failed" });
  });

  it("waits on a connector that has not connected while the edge answers", () => {
    expect(
      classifyReachability(facts({ connector: notConnected, edgeReachable: true }), checkedAt),
    ).toMatchObject({ cause: "connector_not_ready" });
  });
});

interface ServedResponse {
  readonly status: number;
  readonly body: string | ReadableStream<Uint8Array> | { readonly cloudflareError: number };
}

// What Cloudflare serves for its 530 page: HTML unless the client accepts JSON.
const cloudflareErrorPage = (request: HttpClientRequest.HttpClientRequest, code: number) =>
  request.headers.accept === "application/json"
    ? JSON.stringify({ status: 530, error_code: code, error_name: "tunnel_error" })
    : `<!doctype html><h1><span>Error</span> <span>${code}</span></h1>`;

const reachabilityLayer = (
  respond: Effect.Effect<ServedResponse>,
  restartConnector: (pid: number, stillDead: Effect.Effect<boolean>) => Effect.Effect<boolean>,
) =>
  ConnectReachability.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
          inspectConnector: Effect.succeed(connected),
          readinessChanged: Stream.never,
          restartConnector,
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeedSome(new Uint8Array()),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            respond.pipe(
              Effect.map(({ status, body }) =>
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    typeof body === "object" && "cloudflareError" in body
                      ? cloudflareErrorPage(request, body.cloudflareError)
                      : body,
                    { status },
                  ),
                ),
              ),
            ),
          ),
        ),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("no tailscale")),
        ),
      ),
    ),
  );

const mockEdgeConnect = () =>
  vi.spyOn(NodeNet, "connect").mockImplementation(() => {
    const socket = new NodeNet.Socket();
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });

describe("ConnectReachability stale connector recovery", () => {
  it.effect("restarts cloudflared when Cloudflare has no connector but it reports ready", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restarts = yield* Queue.unbounded<number>();
      // Cloudflare answers 530 while cloudflared still reports four ready connections.
      let status = 530;
      let body = { cloudflareError: 1033 };
      const layer = reachabilityLayer(
        Effect.sync(() => ({ status, body })),
        (pid, stillDead) =>
          stillDead.pipe(Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void))),
      );
      // The scheduled checks run in the layer's scope, so the assertions run inside it.
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;

        // The first sighting schedules its own confirming check two minutes later.
        expect(yield* reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // A restart that did not help doubles the wait.
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // Reaching the endpoint resets the wait, and a 530 for a broken DNS record is left alone.
        status = 200;
        expect(yield* reachability.check).toMatchObject({ status: "reachable" });
        status = 530;
        body = { cloudflareError: 1016 };
        expect(yield* reachability.check).toMatchObject({ cause: "unexpected_response" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);

        body = { cloudflareError: 1033 };
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts a new streak after a healthy check that a newer check overtook", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restartTimes = yield* Queue.unbounded<number>();
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      let status = 530;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return { status: served, body: { cloudflareError: 1033 } };
        }),
        (_pid, stillDead) =>
          stillDead.pipe(
            Effect.tap((dead) =>
              dead
                ? Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) => Queue.offer(restartTimes, now)),
                  )
                : Effect.void,
            ),
          ),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));

        // The healthy answer arrives after a newer check already reported the tunnel dead.
        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 530;
        yield* reachability.check;
        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });

        // The grace period starts again at the next dead check, a minute after the first one.
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect((yield* Queue.take(restartTimes)) - startedAt).toBe(
          Duration.toMillis(Duration.minutes(3)),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("rejects a restart when an overtaken healthy check finishes while it waits", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      const restartRequested = yield* Deferred.make<void>();
      const releaseRestart = yield* Deferred.make<void>();
      const guardChecks = yield* Queue.unbounded<boolean>();
      let status = 530;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return { status: served, body: { cloudflareError: 1033 } };
        }),
        (_pid, stillDead) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(restartRequested, undefined);
            yield* Deferred.await(releaseRestart);
            const accepted = yield* stillDead;
            yield* Queue.offer(guardChecks, accepted);
            return accepted;
          }),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.seconds(119));

        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 530;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Deferred.await(restartRequested);

        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });
        yield* Deferred.succeed(releaseRestart, undefined);
        expect(yield* Queue.take(guardChecks)).toBe(false);

        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(guardChecks)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(guardChecks)).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("drops the confirming check of a streak that already ended", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restarts = yield* Queue.unbounded<number>();
      let status = 530;
      let requests = 0;
      const layer = reachabilityLayer(
        Effect.sync(() => {
          requests += 1;
          return { status, body: { cloudflareError: 1033 } };
        }),
        (pid, stillDead) =>
          stillDead.pipe(Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void))),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));
        status = 200;
        yield* reachability.check;
        status = 530;
        yield* reachability.check;

        const before = requests;
        yield* TestClock.adjust(Duration.minutes(1));
        expect(requests).toBe(before);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps a 530 whose error body never finishes", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      let markBodyRead = () => {};
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });
      const layer = reachabilityLayer(
        Effect.sync(() => ({
          status: 530,
          body: new ReadableStream({
            pull: () => {
              markBodyRead();
              return new Promise<void>(() => {});
            },
          }),
        })),
        () => Effect.succeed(false),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const check = yield* Effect.forkChild(reachability.check);
        yield* Effect.promise(() => bodyRead);
        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* Fiber.join(check)).toMatchObject({ cause: "no_connector" });
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("T3 Connect troubleshooting links", () => {
  it("each section names a heading in the user guide", () => {
    const guide = NodeFS.readFileSync(
      new URL("../../../../docs/user/t3-connect-troubleshooting.md", import.meta.url),
      "utf8",
    );
    // GitHub's heading anchors: lowercase, drop punctuation, spaces become hyphens.
    const anchors = new Set(
      [...guide.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replace(/ /g, "-"),
      ),
    );
    for (const section of T3_CONNECT_TROUBLESHOOTING_SECTIONS) {
      expect(anchors, section).toContain(section);
    }
  });
});
