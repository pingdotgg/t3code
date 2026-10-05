import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, routeName: string) =>
  compute.getRoutes({ project, route: routeName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, replace, and delete a route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const route = yield* GCP.Compute.Route("Internet", {
            destRange: "192.0.2.0/24",
            network: DEFAULT_NETWORK,
            nextHopGateway: "default-internet-gateway",
            description: "test-net egress",
            tags: ["alchemy-test"],
          });
          return { route };
        }),
      );

      expect(created.route.routeName).toEqual(expect.any(String));
      expect(created.route.destRange).toEqual("192.0.2.0/24");
      expect(created.route.priority).toEqual(1000);
      expect(created.route.description).toEqual("test-net egress");
      expect(created.route.tags).toEqual(["alchemy-test"]);
      expect(created.route.network).toContain(`networks/${DEFAULT_NETWORK}`);
      expect(created.route.nextHopGateway).toContain(
        "default-internet-gateway",
      );

      const fetched = yield* compute.getRoutes({
        project: created.route.project,
        route: created.route.routeName,
      });
      expect(fetched.name).toEqual(created.route.routeName);
      expect(fetched.destRange).toEqual("192.0.2.0/24");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("test-net egress");
      expect(fetched.tags).toEqual(["alchemy-test"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const route = yield* GCP.Compute.Route("Internet", {
            routeName: created.route.routeName,
            destRange: "198.51.100.0/24",
            network: DEFAULT_NETWORK,
            nextHopGateway: "default-internet-gateway",
            description: "updated test-net",
            priority: 900,
          });
          return { route };
        }),
      );

      expect(updated.route.routeName).toEqual(created.route.routeName);
      expect(updated.route.destRange).toEqual("198.51.100.0/24");
      expect(updated.route.description).toEqual("updated test-net");
      expect(updated.route.priority).toEqual(900);
      expect(updated.route.tags).toEqual([]);

      const refetched = yield* compute.getRoutes({
        project: updated.route.project,
        route: updated.route.routeName,
      });
      expect(refetched.destRange).toEqual("198.51.100.0/24");
      expect(refetched.priority).toEqual(900);
      expect(refetched.description).toContain("updated test-net");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.route.project,
        created.route.routeName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
