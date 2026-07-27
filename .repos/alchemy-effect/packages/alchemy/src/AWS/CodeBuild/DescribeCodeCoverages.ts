import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportGroup } from "./ReportGroup.ts";

/**
 * Runtime binding for `codebuild:DescribeCodeCoverages` — reads the
 * per-file line/branch coverage of a coverage report in the bound report
 * group.
 * @binding
 * @section Reading Reports
 * @example Read Code Coverage
 * ```typescript
 * const describeCodeCoverages = yield* AWS.CodeBuild.DescribeCodeCoverages(reportGroup);
 *
 * const { codeCoverages } = yield* describeCodeCoverages({ reportArn });
 * ```
 */
export interface DescribeCodeCoverages extends Binding.Service<
  DescribeCodeCoverages,
  "AWS.CodeBuild.DescribeCodeCoverages",
  <G extends ReportGroup>(
    reportGroup: G,
  ) => Effect.Effect<
    (
      request: SVC.DescribeCodeCoveragesInput,
    ) => Effect.Effect<
      SVC.DescribeCodeCoveragesOutput,
      SVC.DescribeCodeCoveragesError
    >
  >
> {}
export const DescribeCodeCoverages = Binding.Service<DescribeCodeCoverages>(
  "AWS.CodeBuild.DescribeCodeCoverages",
);
