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
  networkservices.getProjectsLocationsGateways({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsGateways on a missing gateway fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsGateways({
          name: `projects/${project}/locations/global/gateways/alchemy-missing`,
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
  "create, update, and delete an open mesh gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.Gateway("Mesh", {
            location: "global",
            type: "OPEN_MESH",
            ports: [443],
            description: "gateway a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/gateways/");
      expect(created.gatewayId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.type).toEqual("OPEN_MESH");
      expect(created.ports).toContain(443);
      expect(created.description).toEqual("gateway a");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsGateways({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("gateway a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.Gateway("Mesh", {
            gatewayId: created.gatewayId,
            location: "global",
            type: "OPEN_MESH",
            ports: [80, 443],
            description: "gateway b",
            labels: { env: "prod", role: "mesh" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("gateway b");
      expect(updated.ports).toEqual(expect.arrayContaining([80, 443]));
      expect(updated.labels).toMatchObject({ env: "prod", role: "mesh" });

      const refetched = yield* networkservices.getProjectsLocationsGateways({
        name: created.name,
      });
      expect(refetched.description).toEqual("gateway b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("mesh");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
