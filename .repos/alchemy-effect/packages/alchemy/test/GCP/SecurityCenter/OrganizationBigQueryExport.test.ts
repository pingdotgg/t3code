import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
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
  scc.getOrganizationsBigQueryExports({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Organization-level Security Command Center needs SCC activated on the
// organization and org-level SCC roles for the test identity. Set
// GCP_TEST_SECURITY_CENTER=1 and GOOGLE_ORGANIZATION_ID when both hold.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID;
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER && !!organizationId;

const organizationOf = () =>
  Effect.succeed(
    organizationId === undefined
      ? ""
      : organizationId.startsWith("organizations/")
        ? organizationId
        : `organizations/${organizationId}`,
  );

test.provider(
  "getOrganizationsBigQueryExports on a missing export fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        scc.getOrganizationsBigQueryExports({
          name: `${organization}/bigQueryExports/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization BigQuery export",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const organization = yield* organizationOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccOrgExport", {
            location: "US",
            forceDestroy: true,
          });
          const exp = yield* GCP.SecurityCenter.OrganizationBigQueryExport(
            "Findings",
            {
              organization,
              dataset: `projects/${project}/datasets/${dataset.datasetId}`,
              filter: 'state="ACTIVE"',
              description: "active findings",
            },
          );
          return { exp, datasetId: dataset.datasetId };
        }),
      );

      expect(created.exp.exportId).toEqual(expect.any(String));
      expect(created.exp.organization).toEqual(organization);
      expect(created.exp.name).toEqual(
        `${organization}/bigQueryExports/${created.exp.exportId}`,
      );
      expect(created.exp.filter).toEqual('state="ACTIVE"');
      expect(created.exp.description).toEqual("active findings");

      const fetched = yield* scc.getOrganizationsBigQueryExports({
        name: created.exp.name,
      });
      expect(fetched.name).toEqual(created.exp.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccOrgExport", {
            datasetId: created.datasetId,
            location: "US",
            forceDestroy: true,
          });
          return yield* GCP.SecurityCenter.OrganizationBigQueryExport(
            "Findings",
            {
              organization,
              exportId: created.exp.exportId,
              dataset: `projects/${project}/datasets/${dataset.datasetId}`,
              filter: 'state="INACTIVE"',
              description: "inactive findings",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.exp.name);
      expect(updated.filter).toEqual('state="INACTIVE"');
      expect(updated.description).toEqual("inactive findings");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.exp.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
