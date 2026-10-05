import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
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
  developerconnect.getProjectsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsConnections({
          name: `projects/${project}/locations/${location}/connections/alchemy-missing-connection`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a developer connect connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.Connection("Github", {
            location,
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/connections/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* developerconnect.getProjectsLocationsConnections({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.Connection("Github", {
            connectionId: created.connectionId,
            location,
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
            labels: { env: "prod", role: "git" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "git" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 180_000,
  },
);
