import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as migrationcenter from "@distilled.cloud/gcp/migrationcenter_v1";
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

const serviceAccountOf = (project: string) =>
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

const waitUntilGone = (name: string) =>
  migrationcenter.getProjectsLocationsDiscoveryClients({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDiscoveryClients on a missing client fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsDiscoveryClients({
          name: `projects/${project}/locations/us-central1/discoveryClients/alchemy-missing-client`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a migration center discovery client",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const serviceAccount = serviceAccountOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.MigrationCenter.Source("Scanner", {
            location: "us-central1",
            type: "SOURCE_TYPE_DISCOVERY_CLIENT",
            displayName: "scanner-source",
          });
          const client = yield* GCP.MigrationCenter.DiscoveryClient("Agent", {
            location: "us-central1",
            source: source.name,
            serviceAccount,
            displayName: "on-prem-agent",
            description: "test scanner",
            labels: { env: "test" },
          });
          return { source, client };
        }),
      );

      expect(created.client.discoveryClientId).toEqual(expect.any(String));
      expect(created.client.source).toEqual(created.source.name);
      expect(created.client.serviceAccount).toEqual(serviceAccount);
      expect(created.client.displayName).toEqual("on-prem-agent");
      expect(created.client.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* migrationcenter.getProjectsLocationsDiscoveryClients({
          name: created.client.name,
        });
      expect(fetched.name).toEqual(created.client.name);
      expect(fetched.source).toEqual(created.source.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.MigrationCenter.Source("Scanner", {
            sourceId: created.source.sourceId,
            location: "us-central1",
            type: "SOURCE_TYPE_DISCOVERY_CLIENT",
            displayName: "scanner-source",
          });
          const client = yield* GCP.MigrationCenter.DiscoveryClient("Agent", {
            discoveryClientId: created.client.discoveryClientId,
            location: "us-central1",
            source: source.name,
            serviceAccount,
            displayName: "on-prem-agent-v2",
            description: "test scanner v2",
            labels: { env: "prod" },
          });
          return { source, client };
        }),
      );

      expect(updated.client.name).toEqual(created.client.name);
      expect(updated.client.displayName).toEqual("on-prem-agent-v2");
      expect(updated.client.description).toEqual("test scanner v2");
      expect(updated.client.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.client.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 180_000,
  },
);
