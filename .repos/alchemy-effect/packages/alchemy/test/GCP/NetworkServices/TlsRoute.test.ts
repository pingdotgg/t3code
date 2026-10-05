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
  networkservices.getProjectsLocationsTlsRoutes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTlsRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsTlsRoutes({
          name: `projects/${project}/locations/global/tlsRoutes/alchemy-missing`,
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
  "create, update, and delete a tls route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const mesh = yield* GCP.NetworkServices.Mesh("Sidecar", {
            location: "global",
            description: "tls mesh",
            labels: { env: "test" },
          });
          const backend = yield* GCP.Compute.BackendService("Backend", {
            loadBalancingScheme: "INTERNAL_SELF_MANAGED",
            protocol: "HTTP",
            description: "tls backend",
          });
          const route = yield* GCP.NetworkServices.TlsRoute("Secure", {
            location: "global",
            description: "tls route a",
            labels: { env: "test" },
            meshes: [mesh.name],
            rules: [
              {
                matches: [{ sniHost: ["api.example.com"], alpn: ["h2"] }],
                action: {
                  destinations: [
                    {
                      serviceName: backend.selfLink ?? backend.name,
                      weight: 1,
                    },
                  ],
                },
              },
            ],
          });
          return { mesh, backend, route };
        }),
      );

      expect(created.route.name).toContain("/tlsRoutes/");
      expect(created.route.tlsRouteId).toEqual(expect.any(String));
      expect(created.route.location).toEqual("global");
      expect(created.route.description).toEqual("tls route a");
      expect(created.route.meshes).toContain(created.mesh.name);
      expect(created.route.rules[0]?.matches?.[0]?.sniHost).toContain(
        "api.example.com",
      );
      expect(created.route.labels).toMatchObject({ env: "test" });
      expect(created.route.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsTlsRoutes({
        name: created.route.name,
      });
      expect(fetched.name).toEqual(created.route.name);
      expect(fetched.description).toEqual("tls route a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const mesh = yield* GCP.NetworkServices.Mesh("Sidecar", {
            meshId: created.mesh.meshId,
            location: "global",
            description: "tls mesh",
            labels: { env: "test" },
          });
          const backend = yield* GCP.Compute.BackendService("Backend", {
            name: created.backend.name,
            loadBalancingScheme: "INTERNAL_SELF_MANAGED",
            protocol: "HTTP",
            description: "tls backend",
          });
          const route = yield* GCP.NetworkServices.TlsRoute("Secure", {
            tlsRouteId: created.route.tlsRouteId,
            location: "global",
            description: "tls route b",
            labels: { env: "prod", role: "tls" },
            meshes: [mesh.name],
            rules: [
              {
                matches: [{ sniHost: ["secure.example.com"], alpn: ["h2"] }],
                action: {
                  destinations: [
                    {
                      serviceName: backend.selfLink ?? backend.name,
                      weight: 1,
                    },
                  ],
                  idleTimeout: "60s",
                },
              },
            ],
          });
          return { mesh, backend, route };
        }),
      );

      expect(updated.route.name).toEqual(created.route.name);
      expect(updated.route.description).toEqual("tls route b");
      expect(updated.route.labels).toMatchObject({ env: "prod", role: "tls" });
      expect(updated.route.rules[0]?.matches?.[0]?.sniHost).toContain(
        "secure.example.com",
      );

      const refetched = yield* networkservices.getProjectsLocationsTlsRoutes({
        name: created.route.name,
      });
      expect(refetched.description).toEqual("tls route b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tls");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.route.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 180_000,
  },
);
