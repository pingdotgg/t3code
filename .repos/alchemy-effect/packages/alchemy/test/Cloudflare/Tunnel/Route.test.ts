import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic per-test CIDRs. Using 10.99.X.0/24 keeps each test's network
// disjoint from the others and from typical lab address space, so reruns and
// parallel runs don't collide.
const NETWORK_DEFAULT = "10.99.1.0/24";
const NETWORK_UPDATE = "10.99.2.0/24";
const NETWORK_ADOPT = "10.99.3.0/24";
const NETWORK_LIST = "10.99.4.0/24";

test.provider("create and delete route with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { tunnel, route } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteHostTunnel", {
          adopt: true,
        });
        const route = yield* Cloudflare.Tunnel.Route("DefaultRoute", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK_DEFAULT,
          adopt: true,
        });
        return { tunnel, route };
      }),
    );

    expect(route.routeId).toBeDefined();
    expect(route.network).toEqual(NETWORK_DEFAULT);
    expect(route.tunnelId).toEqual(tunnel.tunnelId);
    expect(route.accountId).toEqual(accountId);

    const actual = yield* zeroTrust.getNetworkRoute({
      accountId,
      routeId: route.routeId,
    });
    expect(actual.id).toEqual(route.routeId);
    expect(actual.network).toEqual(NETWORK_DEFAULT);
    expect(actual.tunnelId).toEqual(tunnel.tunnelId);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("updating the comment patches in place", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteUpdateTunnel", {
          adopt: true,
        });
        const route = yield* Cloudflare.Tunnel.Route("UpdateRoute", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK_UPDATE,
          comment: "v1",
          adopt: true,
        });
        return { tunnel, route };
      }),
    );

    expect(initial.route.comment).toEqual("v1");

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteUpdateTunnel", {
          adopt: true,
        });
        const route = yield* Cloudflare.Tunnel.Route("UpdateRoute", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK_UPDATE,
          comment: "v2",
          adopt: true,
        });
        return { tunnel, route };
      }),
    );

    expect(updated.route.routeId).toEqual(initial.route.routeId);
    expect(updated.route.comment).toEqual("v2");

    const actual = yield* zeroTrust.getNetworkRoute({
      accountId,
      routeId: updated.route.routeId,
    });
    expect(actual.comment).toEqual("v2");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("adopt: takes over a pre-existing route", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Stand up just the tunnel via the stack so we have a stable tunnelId to
    // attach a manually-created route to.
    const { tunnel } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteAdoptTunnel", {
          adopt: true,
        });
        return { tunnel };
      }),
    );

    // Manually create the route outside of alchemy's state. The reconcile
    // path with `adopt: true` should find this and take ownership rather
    // than failing or creating a duplicate. Route networks are unique
    // account-wide, so on Conflict (a prior failed run leaked the route)
    // reuse the existing one — that's an equally valid pre-existing route.
    const pre = yield* zeroTrust
      .createNetworkRoute({
        accountId,
        tunnelId: tunnel.tunnelId,
        network: NETWORK_ADOPT,
        comment: "pre-existing",
      })
      .pipe(
        Effect.catch(() =>
          zeroTrust.listNetworkRoutes
            .items({
              accountId,
              isDeleted: false,
              networkSubset: NETWORK_ADOPT,
              networkSuperset: NETWORK_ADOPT,
            })
            .pipe(
              Stream.filter((r) => r.network === NETWORK_ADOPT),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            ),
        ),
      );
    expect(pre?.id).toBeDefined();

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteAdoptTunnel", {
          adopt: true,
        });
        const route = yield* Cloudflare.Tunnel.Route("AdoptRoute", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK_ADOPT,
          adopt: true,
        });
        return { route };
      }),
    );

    expect(adopted.route.routeId).toEqual(pre?.id);
    expect(adopted.route.network).toEqual(NETWORK_ADOPT);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed route", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { route } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("RouteListTunnel", {
          adopt: true,
        });
        const route = yield* Cloudflare.Tunnel.Route("ListRoute", {
          tunnelId: tunnel.tunnelId,
          network: NETWORK_LIST,
          adopt: true,
        });
        return { route };
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Tunnel.Route);
    const all = yield* provider.list();

    const found = all.find((r) => r.routeId === route.routeId);
    expect(found).toBeDefined();
    expect(found?.network).toEqual(NETWORK_LIST);
    expect(found?.accountId).toEqual(accountId);

    yield* stack.destroy();
  }).pipe(logLevel),
);
