import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dummyAws,
  logLevel,
  currentProject,
  runSourceLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsSourcesUtilizationReports on a missing report fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source/utilizationReports/alchemy-missing-report`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runSourceLifecycle)(
  "create and delete a vm migration utilization report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.VMMigration.Source("ReportSource", {
            aws: dummyAws,
          });
          return yield* GCP.VMMigration.SourcesUtilizationReport("Week", {
            source: source.name,
            timeFrame: "WEEK",
            displayName: "weekly",
            vms: [{ vmId: "i-0123456789abcdef0" }],
          });
        }),
      );

      expect(created.utilizationReportId).toEqual(expect.any(String));
      expect(created.name).toContain("/utilizationReports/");
      expect(created.timeFrame).toEqual("WEEK");
      expect(created.displayName).toEqual("weekly");

      const fetched =
        yield* vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmmigration", "live"],
    timeout: 120_000,
  },
);
