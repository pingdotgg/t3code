import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const location = "us-central1";

const waitUntilGone = (name: string) =>
  dlp.getOrganizationsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getOrganizationsLocationsConnections({
          name: `${organization}/locations/${location}/connections/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId || !!process.env.FAST)(
  "create, update, and delete an organization DLP connection",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const cloudSql = {
        connectionName: `${project}:${location}:alchemy-dlp-sql`,
        databaseEngine: "DATABASE_ENGINE_POSTGRES" as const,
        maxConnections: 2,
        cloudSqlIam: {},
      };

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsConnection("Warehouse", {
            organization,
            location,
            state: "MISSING_CREDENTIALS",
            cloudSql,
          });
        }),
      );

      expect(created.location).toEqual(location);
      expect(created.name).toContain("/connections/");
      expect(created.cloudSql?.connectionName).toEqual(cloudSql.connectionName);

      const fetched = yield* dlp.getOrganizationsLocationsConnections({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.OrganizationsLocationsConnection("Warehouse", {
            organization,
            location,
            state: "MISSING_CREDENTIALS",
            cloudSql: { ...cloudSql, maxConnections: 3 },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.cloudSql?.maxConnections).toEqual(3);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
