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
  networkservices.getProjectsLocationsLbEdgeExtensions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsLbEdgeExtensions on a missing extension fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsLbEdgeExtensions({
          name: `projects/${project}/locations/global/lbEdgeExtensions/alchemy-missing`,
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

// Edge extensions need a WasmPlugin with a main version; the fixture's
// bare plugin makes create fail with BadRequest "MAIN_VERSION_ID_EMPTY: Main
// version ID must not be empty." Set GCP_TEST_LB_EDGE_EXTENSION=1 once the
// fixture publishes a plugin version.
test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_LB_EDGE_EXTENSION,
)(
  "create, update, and delete an lb edge extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.NetworkServices.WasmPlugin("EdgePlugin", {
            location: "global",
            description: "edge wasm",
          });
          const map = yield* GCP.Compute.UrlMap("EdgeMap", {
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("EdgeProxy", {
            urlMap: map.urlMapName,
          });
          const rule = yield* GCP.Compute.GlobalForwardingRule("EdgeFr", {
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL_MANAGED",
          });
          return yield* GCP.NetworkServices.LbEdgeExtension("Edge", {
            location: "global",
            description: "lb edge a",
            labels: { env: "test" },
            loadBalancingScheme: "EXTERNAL_MANAGED",
            forwardingRules: [rule.selfLink.as<string>()],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    service: plugin.name,
                    supportedEvents: ["REQUEST_HEADERS"],
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/lbEdgeExtensions/");
      expect(created.lbEdgeExtensionId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("lb edge a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsLbEdgeExtensions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("lb edge a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.NetworkServices.WasmPlugin("EdgePlugin", {
            location: "global",
            description: "edge wasm",
          });
          const map = yield* GCP.Compute.UrlMap("EdgeMap", {
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("EdgeProxy", {
            urlMap: map.urlMapName,
          });
          const rule = yield* GCP.Compute.GlobalForwardingRule("EdgeFr", {
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL_MANAGED",
          });
          return yield* GCP.NetworkServices.LbEdgeExtension("Edge", {
            lbEdgeExtensionId: created.lbEdgeExtensionId,
            location: "global",
            description: "lb edge b",
            labels: { env: "prod", role: "edge" },
            loadBalancingScheme: "EXTERNAL_MANAGED",
            forwardingRules: [rule.selfLink.as<string>()],
            extensionChains: [
              {
                name: "chain1",
                matchCondition: { celExpression: "true" },
                extensions: [
                  {
                    name: "ext1",
                    service: plugin.name,
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
      expect(updated.description).toEqual("lb edge b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });

      const refetched =
        yield* networkservices.getProjectsLocationsLbEdgeExtensions({
          name: created.name,
        });
      expect(refetched.description).toEqual("lb edge b");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 120_000,
  },
);
