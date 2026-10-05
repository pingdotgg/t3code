import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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

const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsStoredInfoTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsStoredInfoTypes on a missing stored info type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsStoredInfoTypes({
          name: `projects/${project}/locations/${location}/storedInfoTypes/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a location stored info type",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsStoredInfoType("Badge", {
            location,
            displayName: "badge numbers",
            description: "employee badges",
            regex: { pattern: "EMP[0-9]{6}" },
          });
        }),
      );

      expect(created.storedInfoTypeId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/storedInfoTypes/${created.storedInfoTypeId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.displayName).toEqual("badge numbers");
      expect(created.description).toEqual("employee badges");
      expect(created.regex?.pattern).toEqual("EMP[0-9]{6}");

      const fetched = yield* dlp.getProjectsLocationsStoredInfoTypes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.currentVersion?.config?.description).toContain(
        "alchemy-id=",
      );
      expect(fetched.currentVersion?.config?.regex?.pattern).toEqual(
        "EMP[0-9]{6}",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.LocationsStoredInfoType("Badge", {
            storedInfoTypeId: created.storedInfoTypeId,
            location,
            displayName: "badge numbers",
            description: "employee badges v2",
            regex: { pattern: "EMP[0-9]{8}" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("employee badges v2");
      expect(updated.regex?.pattern).toEqual("EMP[0-9]{8}");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
