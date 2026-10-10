import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
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
  cloudbuild.getProjectsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Connection("Github", {
            location: "us-central1",
            annotations: { env: "test" },
            githubConfig: {},
          });
        }),
      );

      expect(created.connectionId).toEqual(expect.any(String));
      expect(created.name).toContain("/connections/");
      expect(created.location).toEqual("us-central1");
      expect(created.disabled).toEqual(false);
      expect(created.annotations).toMatchObject({ env: "test" });
      expect(created.githubConfig).toEqual(expect.any(Object));
      expect(created.installationState?.stage).toEqual(expect.any(String));

      const fetched = yield* cloudbuild.getProjectsLocationsConnections({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.disabled ?? false).toEqual(false);
      expect(fetched.githubConfig).toEqual(expect.any(Object));

      const listed = yield* cloudbuild.listProjectsLocationsConnections({
        parent: `projects/${created.project}/locations/${created.location}`,
      });
      expect(
        (listed.connections ?? []).some(
          (connection) => connection.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Connection("Github", {
            connectionId: created.connectionId,
            location: "us-central1",
            annotations: { env: "prod", role: "scm" },
            disabled: true,
            githubConfig: {},
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.connectionId).toEqual(created.connectionId);
      expect(updated.disabled).toEqual(true);
      expect(updated.annotations).toMatchObject({ env: "prod", role: "scm" });

      const fetchedUpdate = yield* cloudbuild.getProjectsLocationsConnections({
        name: updated.name,
      });
      expect(fetchedUpdate.disabled).toEqual(true);
      expect(fetchedUpdate.annotations?.env).toEqual("prod");
      expect(fetchedUpdate.annotations?.role).toEqual("scm");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Connection("Github", {
            connectionId: created.connectionId,
            location: "us-east1",
            annotations: { env: "test" },
            githubConfig: {},
          });
        }),
      );

      expect(replaced.connectionId).toEqual(created.connectionId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.disabled).toEqual(false);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      const fetchedReplace = yield* cloudbuild.getProjectsLocationsConnections({
        name: replaced.name,
      });
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.disabled ?? false).toEqual(false);
      expect(fetchedReplace.annotations?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
    timeout: 90_000,
  },
);
