import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:DescribeTestCases` — reads the individual
 * test cases of a test report in the bound report group.
 * @binding
 * @section Reading Reports
 * @example Read Failed Test Cases
 * ```typescript
 * const describeTestCases = yield* AWS.CodeBuild.DescribeTestCases(reportGroup);
 *
 * const { testCases } = yield* describeTestCases({
 *   reportArn,
 *   filter: { status: "FAILED" },
 * });
 * ```
 */
export interface DescribeTestCases extends Binding.Service<
  DescribeTestCases,
  "AWS.CodeBuild.DescribeTestCases",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: SVC.DescribeTestCasesInput,
    ) => Effect.Effect<SVC.DescribeTestCasesOutput, SVC.DescribeTestCasesError>
  >
> {}
export const DescribeTestCases = Binding.Service<DescribeTestCases>(
  "AWS.CodeBuild.DescribeTestCases",
);
