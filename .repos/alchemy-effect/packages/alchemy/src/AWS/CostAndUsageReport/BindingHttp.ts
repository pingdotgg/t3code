import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Region } from "../Region.ts";
import type { ReportDefinition } from "./ReportDefinition.ts";

/**
 * Shared HTTP scaffolding for the AWS Cost and Usage Report (`cur`) runtime
 * bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below.
 *
 * The CUR control plane is a global service hosted only in `us-east-1`, so
 * every operation is resolved with the distilled Region pinned there —
 * exactly like the {@link ReportDefinition} provider. The distilled Region
 * service value is `Effect<RegionName>`, not a raw string, hence
 * `Effect.succeed`.
 */
const CUR_REGION = "us-east-1" as const;

const pinCur = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(CUR_REGION)));

/**
 * Build the impl Effect for an account-level CUR operation.
 * `cur:DescribeReportDefinitions` enumerates every report definition in the
 * account, so the grant is on `Resource: ["*"]`.
 */
export const makeCurHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"DescribeReportDefinitions"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCur(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const policyStatements: PolicyStatement[] = [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              Resource: ["*"],
            },
          ];
          yield* host.bind`Allow(${host}, AWS.CostAndUsageReport.${options.capability}())`(
            {
              policyStatements,
            },
          );
        }
      }
      return Effect.fn(`AWS.CostAndUsageReport.${options.capability}`)(
        function* (request?: I) {
          return yield* op((request ?? {}) as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for an operation scoped to one
 * {@link ReportDefinition}. The runtime callable injects the bound report's
 * name as the request's `ReportName`; the deploy-time half grants
 * `iamActions` on the report definition's ARN
 * (`arn:aws:cur:us-east-1:{account}:definition/{name}`).
 */
export const makeReportDefinitionHttpBinding = <
  I extends { ReportName?: string },
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListTagsForResource"`.
   */
  capability: string;
  /** IAM actions granted on the report definition's ARN. */
  iamActions: readonly string[];
  /** The distilled operation; `ReportName` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* pinCur(options.operation);

    return Effect.fn(function* (report: ReportDefinition) {
      const ReportName = yield* report.reportName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CostAndUsageReport.${options.capability}(${report}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [report.reportArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.CostAndUsageReport.${options.capability}(${report.LogicalId})`,
      )(function* (request?: Omit<I, "ReportName">) {
        return yield* op({
          ...request,
          ReportName: yield* ReportName,
        } as I);
      });
    });
  });
