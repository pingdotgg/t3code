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
  networkservices.getProjectsLocationsTcpRoutes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTcpRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsTcpRoutes({
          name: `projects/${project}/locations/global/tcpRoutes/alchemy-missing`,
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
  "create, update, and delete a tcp route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const mesh = yield* GCP.NetworkServices.Mesh("Sidecar", {
            location: "global",
            description: "tcp mesh",
            labels: { env: "test" },
          });
          const route = yield* GCP.NetworkServices.TcpRoute("Passthrough", {
            location: "global",
            description: "tcp route a",
            labels: { env: "test" },
            meshes: [mesh.name],
            rules: [
              {
                matches: [{ address: "0.0.0.0/0", port: "443" }],
                action: { originalDestination: true },
              },
            ],
          });
          return { mesh, route };
        }),
      );

      expect(created.route.name).toContain("/tcpRoutes/");
      expect(created.route.tcpRouteId).toEqual(expect.any(String));
      expect(created.route.location).toEqual("global");
      expect(created.route.description).toEqual("tcp route a");
      expect(created.route.meshes).toContain(created.mesh.name);
      expect(created.route.rules[0]?.action?.originalDestination).toEqual(true);
      expect(created.route.labels).toMatchObject({ env: "test" });
      expect(created.route.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsTcpRoutes({
        name: created.route.name,
      });
      expect(fetched.name).toEqual(created.route.name);
      expect(fetched.description).toEqual("tcp route a");
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
            description: "tcp mesh",
            labels: { env: "test" },
          });
          const route = yield* GCP.NetworkServices.TcpRoute("Passthrough", {
            tcpRouteId: created.route.tcpRouteId,
            location: "global",
            description: "tcp route b",
            labels: { env: "prod", role: "tcp" },
            meshes: [mesh.name],
            rules: [
              {
                matches: [{ address: "0.0.0.0/0", port: "80" }],
                action: { originalDestination: true, idleTimeout: "60s" },
              },
            ],
          });
          return { mesh, route };
        }),
      );

      expect(updated.route.name).toEqual(created.route.name);
      expect(updated.route.description).toEqual("tcp route b");
      expect(updated.route.labels).toMatchObject({ env: "prod", role: "tcp" });
      expect(updated.route.rules[0]?.matches?.[0]?.port).toEqual("80");

      const refetched = yield* networkservices.getProjectsLocationsTcpRoutes({
        name: created.route.name,
      });
      expect(refetched.description).toEqual("tcp route b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tcp");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.route.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
