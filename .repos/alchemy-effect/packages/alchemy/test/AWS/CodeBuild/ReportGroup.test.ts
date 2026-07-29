import * as AWS from "@/AWS";
import { ReportGroup } from "@/AWS/CodeBuild/ReportGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const reportGroupName = "alchemy-test-codebuild-report-group";

/** Find the group's ARN by name (report groups are addressed by ARN). */
const findReportGroupArn = codebuild
  .listReportGroups({})
  .pipe(
    Effect.map((res) =>
      res.reportGroups?.find((arn) =>
        arn.endsWith(`report-group/${reportGroupName}`),
      ),
    ),
  );

const getReportGroup = Effect.gen(function* () {
  const arn = yield* findReportGroupArn;
  if (arn === undefined) return undefined;
  const res = yield* codebuild.batchGetReportGroups({
    reportGroupArns: [arn],
  });
  const group = res.reportGroups?.[0];
  return group?.status === "DELETING" ? undefined : group;
});

test.provider(
  "lifecycle: create TEST report group, update tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a TEST report group with the default NO_EXPORT config.
      const deployed = yield* stack.deploy(
        ReportGroup("LifecycleReportGroup", {
          reportGroupName,
          type: "TEST",
        }),
      );
      expect(deployed.reportGroupArn).toContain(
        `report-group/${reportGroupName}`,
      );
      expect(deployed.reportGroupName).toBe(reportGroupName);

      // Out-of-band verification via distilled.
      const created = yield* getReportGroup;
      expect(created?.name).toBe(reportGroupName);
      expect(created?.type).toBe("TEST");
      expect(created?.exportConfig?.exportConfigType).toBe("NO_EXPORT");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(ReportGroup);
      const all = yield* provider.list();
      expect(all.some((g) => g.reportGroupName === reportGroupName)).toBe(true);

      // Update — add a user tag in place (no replacement).
      yield* stack.deploy(
        ReportGroup("LifecycleReportGroup", {
          reportGroupName,
          type: "TEST",
          tags: { Purpose: "alchemy-test" },
        }),
      );
      const updated = yield* getReportGroup;
      expect(updated?.tags?.find((t) => t.key === "Purpose")?.value).toBe(
        "alchemy-test",
      );

      // Re-deploy identical props — sync diff is a no-op that converges.
      yield* stack.deploy(
        ReportGroup("LifecycleReportGroup", {
          reportGroupName,
          type: "TEST",
          tags: { Purpose: "alchemy-test" },
        }),
      );

      // Destroy — the group is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* getReportGroup;
      expect(after).toBeUndefined();
    }),
  { timeout: 120_000 },
);
