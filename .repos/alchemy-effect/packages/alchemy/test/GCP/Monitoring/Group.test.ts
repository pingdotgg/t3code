import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
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
  monitoring.getProjectsGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a monitoring group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.Group("Prod", {
            displayName: "production instances",
            filter: 'resource.metadata.region="us-central1"',
          });
        }),
      );

      expect(created.name).toContain("/groups/");
      expect(created.groupId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("production instances");
      expect(created.filter).toEqual('resource.metadata.region="us-central1"');
      expect(created.isCluster).toEqual(false);
      expect(created.parentName).toEqual("");

      const fetched = yield* monitoring.getProjectsGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.filter).toEqual('resource.metadata.region="us-central1"');
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("production instances");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Monitoring.Group("Prod", {
            displayName: "east production",
            filter: 'resource.metadata.region="us-east1"',
            isCluster: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("east production");
      expect(updated.filter).toEqual('resource.metadata.region="us-east1"');
      expect(updated.isCluster).toEqual(true);

      const fetchedUpdate = yield* monitoring.getProjectsGroups({
        name: updated.name,
      });
      expect(fetchedUpdate.filter).toEqual(
        'resource.metadata.region="us-east1"',
      );
      expect(fetchedUpdate.isCluster).toEqual(true);
      expect(fetchedUpdate.displayName).toContain("east production");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:monitoring", "live"],
    timeout: 90_000,
  },
);
