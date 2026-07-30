import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const GATEWAY_ID = "alchemy-test-aigw-routing";
const GATEWAY_ID_B = "alchemy-test-aigw-routing-b";

const graph = (
  model: string,
  retries: number,
): Cloudflare.AI.RouteElement[] => [
  {
    id: "start",
    type: "start",
    outputs: { next: { elementId: "model" } },
  },
  {
    id: "model",
    type: "model",
    properties: {
      provider: "workers-ai",
      model,
      retries,
      timeout: 30_000,
    },
    outputs: {
      success: { elementId: "end" },
      fallback: { elementId: "end" },
    },
  },
  { id: "end", type: "end", outputs: {} },
];

class RouteStillExists extends Data.TaggedError("RouteStillExists") {}

// A deleted route surfaces as `RouteNotFound` (Cloudflare error code 7005);
// once the parent gateway is destroyed the same probe fails with
// `GatewayNotFound` (code 7002). Either way the route is gone.
const expectGone = (accountId: string, gatewayId: string, routeId: string) =>
  aiGateway.getDynamicRouting({ accountId, gatewayId, id: routeId }).pipe(
    Effect.flatMap(() => Effect.fail(new RouteStillExists())),
    Effect.retry({
      while: (e): e is RouteStillExists => e instanceof RouteStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("RouteNotFound", () => Effect.void),
    Effect.catchTag("GatewayNotFound", () => Effect.void),
  );

test.provider(
  "create, update elements (new deployed version), rename, delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("RoutingGateway", {
            id: GATEWAY_ID,
          });
          const route = yield* Cloudflare.AI.GatewayDynamicRouting("Route", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-route",
            elements: graph("@cf/meta/llama-3.1-8b-instruct", 1),
          });
          return { gateway, route };
        }),
      );

      expect(initial.route.routeId).toBeDefined();
      expect(initial.route.accountId).toEqual(accountId);
      expect(initial.route.gatewayId).toEqual(GATEWAY_ID);
      expect(initial.route.name).toEqual("alchemy-test-route");
      // Creation auto-deploys version 1.
      expect(initial.route.versionId).toBeDefined();
      expect(initial.route.deploymentId).toBeDefined();
      expect(initial.route.elements).toEqual(
        graph("@cf/meta/llama-3.1-8b-instruct", 1),
      );

      // Verify out-of-band via the API: deployed version matches.
      const live = yield* aiGateway.getDynamicRouting({
        accountId,
        gatewayId: GATEWAY_ID,
        id: initial.route.routeId,
      });
      expect(live.name).toEqual("alchemy-test-route");
      expect(live.deployment.versionId).toEqual(initial.route.versionId);
      expect(live.version.data).toEqual(
        graph("@cf/meta/llama-3.1-8b-instruct", 1),
      );

      // Update the element graph and rename — same route id, but a new
      // version must be created AND deployed.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("RoutingGateway", {
            id: GATEWAY_ID,
          });
          const route = yield* Cloudflare.AI.GatewayDynamicRouting("Route", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-route-v2",
            elements: graph("@cf/meta/llama-3.1-8b-instruct", 2),
          });
          return { gateway, route };
        }),
      );

      expect(updated.route.routeId).toEqual(initial.route.routeId);
      expect(updated.route.name).toEqual("alchemy-test-route-v2");
      expect(updated.route.versionId).not.toEqual(initial.route.versionId);
      expect(updated.route.elements).toEqual(
        graph("@cf/meta/llama-3.1-8b-instruct", 2),
      );

      const liveUpdated = yield* aiGateway.getDynamicRouting({
        accountId,
        gatewayId: GATEWAY_ID,
        id: initial.route.routeId,
      });
      expect(liveUpdated.name).toEqual("alchemy-test-route-v2");
      expect(liveUpdated.version.active).toBe(true);
      expect(liveUpdated.deployment.versionId).toEqual(updated.route.versionId);
      expect(liveUpdated.version.data).toEqual(
        graph("@cf/meta/llama-3.1-8b-instruct", 2),
      );

      // Redeploying identical props is a no-op (same deployed version).
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("RoutingGateway", {
            id: GATEWAY_ID,
          });
          const route = yield* Cloudflare.AI.GatewayDynamicRouting("Route", {
            gatewayId: gateway.gatewayId,
            name: "alchemy-test-route-v2",
            elements: graph("@cf/meta/llama-3.1-8b-instruct", 2),
          });
          return { gateway, route };
        }),
      );
      expect(noop.route.routeId).toEqual(initial.route.routeId);
      expect(noop.route.versionId).toEqual(updated.route.versionId);

      yield* stack.destroy();

      yield* expectGone(accountId, GATEWAY_ID, initial.route.routeId);
    }).pipe(logLevel),
);

test.provider("replaces route when the gateway changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const gatewayA = yield* Cloudflare.AI.Gateway("RouteGatewayA", {
          id: GATEWAY_ID,
        });
        yield* Cloudflare.AI.Gateway("RouteGatewayB", {
          id: GATEWAY_ID_B,
        });
        const route = yield* Cloudflare.AI.GatewayDynamicRouting(
          "ReplaceRoute",
          {
            gatewayId: gatewayA.gatewayId,
            name: "alchemy-test-route-replace",
            elements: graph("@cf/meta/llama-3.1-8b-instruct", 1),
          },
        );
        return { route };
      }),
    );
    expect(initial.route.gatewayId).toEqual(GATEWAY_ID);

    // Moving the route to another gateway is a replacement: new id, new
    // parent, and the old route is removed from gateway A.
    const moved = yield* stack.deploy(
      Effect.gen(function* () {
        yield* Cloudflare.AI.Gateway("RouteGatewayA", {
          id: GATEWAY_ID,
        });
        const gatewayB = yield* Cloudflare.AI.Gateway("RouteGatewayB", {
          id: GATEWAY_ID_B,
        });
        const route = yield* Cloudflare.AI.GatewayDynamicRouting(
          "ReplaceRoute",
          {
            gatewayId: gatewayB.gatewayId,
            name: "alchemy-test-route-replace",
            elements: graph("@cf/meta/llama-3.1-8b-instruct", 1),
          },
        );
        return { route };
      }),
    );

    expect(moved.route.gatewayId).toEqual(GATEWAY_ID_B);
    expect(moved.route.routeId).not.toEqual(initial.route.routeId);

    // The replaced route is gone from gateway A.
    yield* expectGone(accountId, GATEWAY_ID, initial.route.routeId);

    yield* stack.destroy();

    yield* expectGone(accountId, GATEWAY_ID_B, moved.route.routeId);
  }).pipe(logLevel),
);

test.provider("recreates a route after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const gateway = yield* Cloudflare.AI.Gateway("HealRouteGateway", {
          id: GATEWAY_ID,
        });
        const route = yield* Cloudflare.AI.GatewayDynamicRouting("HealRoute", {
          gatewayId: gateway.gatewayId,
          name: "alchemy-test-route-heal",
          elements: graph("@cf/meta/llama-3.1-8b-instruct", 1),
        });
        return { route };
      }),
    );

    // Delete the route out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the route as missing and recreate it instead of failing on a 404.
    yield* aiGateway.deleteDynamicRouting({
      accountId,
      gatewayId: GATEWAY_ID,
      id: initial.route.routeId,
    });

    const healed = yield* stack.deploy(
      Effect.gen(function* () {
        const gateway = yield* Cloudflare.AI.Gateway("HealRouteGateway", {
          id: GATEWAY_ID,
        });
        const route = yield* Cloudflare.AI.GatewayDynamicRouting("HealRoute", {
          gatewayId: gateway.gatewayId,
          name: "alchemy-test-route-heal",
          elements: graph("@cf/meta/llama-3.1-8b-instruct", 3),
        });
        return { route };
      }),
    );

    expect(healed.route.routeId).not.toEqual(initial.route.routeId);
    expect(healed.route.elements).toEqual(
      graph("@cf/meta/llama-3.1-8b-instruct", 3),
    );

    yield* stack.destroy();

    yield* expectGone(accountId, GATEWAY_ID, healed.route.routeId);
  }).pipe(logLevel),
);

// Canonical `list()` test (parent fan-out): routes are scoped under a gateway
// with no account-wide route API, so `list()` enumerates every account gateway
// and exhaustively lists each gateway's routes. Deploy a gateway + route, then
// assert the deployed route appears in the exhaustively-paginated result.
test.provider(
  "list enumerates routes across all gateways",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.AI.Gateway("ListRouteGateway", {
            id: GATEWAY_ID,
          });
          const route = yield* Cloudflare.AI.GatewayDynamicRouting(
            "ListRoute",
            {
              gatewayId: gateway.gatewayId,
              name: "alchemy-test-route-list",
              elements: graph("@cf/meta/llama-3.1-8b-instruct", 1),
            },
          );
          return { route };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.AI.GatewayDynamicRouting,
      );

      // The route appears in list() shortly after deploy, but its element graph
      // is materialized from a separate deployed-version lookup that propagates
      // with its own eventual-consistency lag. Poll until the route is present
      // AND its graph has propagated before asserting.
      const all = yield* poll({
        description:
          "list() includes the deployed route with its element graph",
        effect: provider.list(),
        predicate: (all) =>
          (all.find((r) => r.routeId === deployed.route.routeId)?.elements
            ?.length ?? 0) > 0,
        // Bound the poll so it converges (or fails with a clear PredicateFailed)
        // well within the test timeout below — the default schedule (50 × 5s)
        // outruns the timeout and surfaces as an opaque "Test timed out".
        schedule: Schedule.max([
          Schedule.spaced("3 seconds"),
          Schedule.recurs(40),
        ]),
      });

      const found = all.find((r) => r.routeId === deployed.route.routeId);
      expect(found).toBeDefined();
      expect(found?.gatewayId).toEqual(GATEWAY_ID);
      expect(found?.name).toEqual("alchemy-test-route-list");
      expect(found?.elements).toEqual(
        graph("@cf/meta/llama-3.1-8b-instruct", 1),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
