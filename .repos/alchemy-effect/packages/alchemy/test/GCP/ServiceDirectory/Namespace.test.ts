import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
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
  servicedirectory.getProjectsLocationsNamespaces({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ServiceDirectory.Namespace("Services", {
            location: "us-central1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/namespaces/");
      expect(created.namespaceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.uid).toEqual(expect.any(String));

      const fetched = yield* servicedirectory.getProjectsLocationsNamespaces({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.uid).toEqual(created.uid);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ServiceDirectory.Namespace("Services", {
            namespaceId: created.namespaceId,
            location: "us-central1",
            labels: { env: "prod", role: "services" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.uid).toEqual(created.uid);
      expect(updated.labels).toMatchObject({ env: "prod", role: "services" });

      const refetched = yield* servicedirectory.getProjectsLocationsNamespaces({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("services");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ServiceDirectory.Namespace("Services", {
            namespaceId: created.namespaceId,
            location: "us-east1",
            labels: { env: "prod" },
          });
        }),
      );

      expect(replaced.location).toEqual("us-east1");
      expect(replaced.namespaceId).toEqual(created.namespaceId);
      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.name).toContain("/locations/us-east1/");

      const fetchedReplacement =
        yield* servicedirectory.getProjectsLocationsNamespaces({
          name: replaced.name,
        });
      expect(fetchedReplacement.name).toEqual(replaced.name);
      expect(fetchedReplacement.labels?.env).toEqual("prod");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicedirectory", "live"],
    timeout: 90_000,
  },
);
