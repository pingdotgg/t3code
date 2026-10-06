import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsLbRouteExtensions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsLbRouteExtensions on a missing extension fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsLbRouteExtensions({
          name: `projects/${project}/locations/us-central1/lbRouteExtensions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsLbRouteExtensions without a forwarding rule fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkservices.createProjectsLocationsLbRouteExtensions({
          parent: `projects/${project}/locations/us-central1`,
          lbRouteExtensionId: "alchemy-missing-lb-route",
          body: {
            loadBalancingScheme: "INTERNAL_MANAGED",
            forwardingRules: [
              `//compute.googleapis.com/projects/${project}/regions/us-central1/forwardingRules/alchemy-missing-fr`,
            ],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    authority: "ext1.example.com",
                    service: `https://www.googleapis.com/compute/v1/projects/${project}/regions/us-central1/backendServices/alchemy-missing-be`,
                    timeout: "0.1s",
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          },
        }),
      );
      expect(error._tag).toBe("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_LB_ROUTE_EXTENSION,
)(
  "create, update, and delete an lb route extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const forwardingRule = process.env.GCP_TEST_LB_ROUTE_EXTENSION_TARGET!;
      const service = process.env.GCP_TEST_LB_ROUTE_EXTENSION_SERVICE!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.LbRouteExtension("Route", {
            location: "us-central1",
            description: "lb route a",
            labels: { env: "test" },
            loadBalancingScheme: "INTERNAL_MANAGED",
            forwardingRules: [forwardingRule],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    authority: "ext1.example.com",
                    service,
                    timeout: "0.1s",
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/lbRouteExtensions/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkservices.getProjectsLocationsLbRouteExtensions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.LbRouteExtension("Route", {
            lbRouteExtensionId: created.lbRouteExtensionId,
            location: "us-central1",
            description: "lb route b",
            labels: { env: "prod", role: "route" },
            loadBalancingScheme: "INTERNAL_MANAGED",
            forwardingRules: [forwardingRule],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    authority: "ext1.example.com",
                    service,
                    timeout: "0.2s",
                    failOpen: true,
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("lb route b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "route" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 120_000,
  },
);
