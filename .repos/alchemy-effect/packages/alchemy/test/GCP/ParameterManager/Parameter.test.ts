import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  parametermanager.getProjectsLocationsParameters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a parameter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ParameterManager.Parameter("AppConfig", {
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/parameters/");
      expect(created.parameterId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.format).toEqual("UNFORMATTED");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* parametermanager.getProjectsLocationsParameters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(
        fetched.format === undefined || fetched.format === "UNFORMATTED",
      ).toBe(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ParameterManager.Parameter("AppConfig", {
            parameterId: created.parameterId,
            location: created.location,
            labels: { env: "prod", role: "config" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "config" });

      const fetchedUpdate =
        yield* parametermanager.getProjectsLocationsParameters({
          name: created.name,
        });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("config");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "replace a parameter when format changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ParameterManager.Parameter("TypedConfig", {
            format: "UNFORMATTED",
          });
        }),
      );

      expect(created.format).toEqual("UNFORMATTED");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ParameterManager.Parameter("TypedConfig", {
            parameterId: created.parameterId,
            location: created.location,
            format: "JSON",
          });
        }),
      );

      expect(replaced.name).toEqual(created.name);
      expect(replaced.parameterId).toEqual(created.parameterId);
      expect(replaced.format).toEqual("JSON");

      const fetched = yield* parametermanager.getProjectsLocationsParameters({
        name: replaced.name,
      });
      expect(fetched.format).toEqual("JSON");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
    timeout: 90_000,
  },
);
