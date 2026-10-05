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
  scc.getProjectsBigQueryExports({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Security Command Center is not activated on the testing project (every
// call fails with ServiceDisabled). Set GCP_TEST_SECURITY_CENTER=1 on a
// project with SCC activated.
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER;

test.provider(
  "getProjectsBigQueryExports on a missing export fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        scc.getProjectsBigQueryExports({
          name: `projects/${project}/bigQueryExports/alchemy-missing`,
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
  "create, update, and delete a BigQuery export",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccExport", {
            location: "US",
            forceDestroy: true,
          });
          const exp = yield* GCP.SecurityCenter.BigQueryExport("High", {
            dataset: dataset.name,
            description: "high severity",
            filter: 'severity="HIGH"',
          });
          return { dataset, exp };
        }),
      );

      expect(created.exp.exportId).toEqual(expect.any(String));
      expect(created.exp.name).toEqual(
        `projects/${project}/bigQueryExports/${created.exp.exportId}`,
      );
      expect(created.exp.dataset).toEqual(created.dataset.name);
      expect(created.exp.description).toEqual("high severity");
      expect(created.exp.filter).toEqual('severity="HIGH"');

      const fetched = yield* scc.getProjectsBigQueryExports({
        name: created.exp.name,
      });
      expect(fetched.name).toEqual(created.exp.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.dataset).toEqual(created.dataset.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("SccExport", {
            datasetId: created.dataset.datasetId,
            location: "US",
            forceDestroy: true,
          });
          const exp = yield* GCP.SecurityCenter.BigQueryExport("High", {
            exportId: created.exp.exportId,
            dataset: dataset.name,
            description: "high and critical",
            filter: 'severity="HIGH" OR severity="CRITICAL"',
          });
          return { dataset, exp };
        }),
      );

      expect(updated.exp.name).toEqual(created.exp.name);
      expect(updated.exp.description).toEqual("high and critical");
      expect(updated.exp.filter).toEqual(
        'severity="HIGH" OR severity="CRITICAL"',
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.exp.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
