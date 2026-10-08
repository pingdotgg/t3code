import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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

// A service connection map publishes a producer service class, which must be
// registered for the project first (BadRequest "serviceClass gcp-cloud-sql
// does not exist: invalid argument"). Set GCP_TEST_SERVICE_CONNECTION_MAP=1 on
// a producer project with the class registered.
const runLifecycle = !!process.env.GCP_TEST_SERVICE_CONNECTION_MAP;

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsServiceConnectionMaps({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsServiceConnectionMaps on a missing map fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsServiceConnectionMaps({
          name: `projects/${project}/locations/us-central1/serviceConnectionMaps/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a service connection map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.ServiceConnectionMap("Sql", {
            serviceClass: "gcp-cloud-sql",
            description: "map a",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/serviceConnectionMaps/");
      expect(created.location).toEqual("us-central1");
      expect(created.serviceClass).toEqual("gcp-cloud-sql");
      expect(created.description).toEqual("map a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsServiceConnectionMaps({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.serviceClass).toEqual("gcp-cloud-sql");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkConnectivity.ServiceConnectionMap("Sql", {
            serviceConnectionMapId: created.serviceConnectionMapId,
            location: created.location,
            serviceClass: "gcp-cloud-sql",
            description: "map b",
            labels: { env: "prod", role: "psc" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("map b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "psc" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 180_000,
  },
);
