import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Dashboard } from "./Dashboard.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Shared scaffolding for Amazon QuickSight HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the scoping resource, and the IAM
 * action list is boilerplate.
 *
 * Every QuickSight API call requires the `AwsAccountId`. The runtime half of
 * each binding derives it from the bound resource's ARN
 * (`arn:aws:quicksight:{region}:{account}:{type}/{id}`), so no extra
 * environment plumbing is needed inside the Lambda.
 */

/** Extract the AWS account id from a QuickSight resource ARN. */
export const accountIdFromArn = (arn: string): string => arn.split(":")[4]!;

/**
 * Build the impl Effect for a QuickSight operation scoped to a
 * {@link Dashboard}: the deploy-time half grants `actions` on the bound
 * dashboard's ARN, and the runtime half injects `AwsAccountId` (parsed from
 * the dashboard ARN) and `DashboardId` into every request.
 */
export const makeQuickSightDashboardHttpBinding = <
  I extends { AwsAccountId: string; DashboardId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QuickSight.StartDashboardSnapshotJob`. */
  tag: string;
  /** The distilled operation; `AwsAccountId` and `DashboardId` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the dashboard ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (dashboard: Dashboard) {
      const DashboardId = yield* dashboard.dashboardId;
      const Arn = yield* dashboard.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dashboard}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [dashboard.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dashboard.LogicalId})`)(function* (
        request: Omit<I, "AwsAccountId" | "DashboardId">,
      ) {
        const arn = yield* Arn;
        return yield* op({
          ...request,
          AwsAccountId: accountIdFromArn(arn),
          DashboardId: yield* DashboardId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a QuickSight operation scoped to a
 * {@link DataSet}: the deploy-time half grants `actions` on the bound
 * dataset's ARN and its `…/ingestion/*` sub-resources, and the runtime half
 * injects `AwsAccountId` (parsed from the dataset ARN) and `DataSetId` into
 * every request.
 */
export const makeQuickSightDataSetHttpBinding = <
  I extends { AwsAccountId: string; DataSetId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QuickSight.CreateIngestion`. */
  tag: string;
  /** The distilled operation; `AwsAccountId` and `DataSetId` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the dataset ARN + its ingestion sub-resources. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (dataSet: DataSet) {
      const DataSetId = yield* dataSet.dataSetId;
      const Arn = yield* dataSet.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dataSet}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  dataSet.arn,
                  Output.interpolate`${dataSet.arn}/ingestion/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataSet.LogicalId})`)(function* (
        request?: Omit<I, "AwsAccountId" | "DataSetId">,
      ) {
        const arn = yield* Arn;
        return yield* op({
          ...request,
          AwsAccountId: accountIdFromArn(arn),
          DataSetId: yield* DataSetId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a QuickSight embed-URL operation scoped to a
 * {@link Dashboard}: the deploy-time half grants `actions` on `*` (embed-URL
 * actions authorize against user/namespace ARNs that are unknown at deploy
 * time), and the runtime half injects `AwsAccountId` and defaults the
 * experience configuration to the bound dashboard via `applyDefaults`.
 */
export const makeQuickSightEmbedHttpBinding = <
  I extends { AwsAccountId: string },
  Req,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.QuickSight.GenerateEmbedUrlForRegisteredUser`. */
  tag: string;
  /** The distilled operation; `AwsAccountId` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
  /** Fill dashboard-derived defaults into the caller's request. */
  applyDefaults: (
    request: Req,
    dashboard: { dashboardId: string; arn: string },
  ) => Omit<I, "AwsAccountId">;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (dashboard: Dashboard) {
      const DashboardId = yield* dashboard.dashboardId;
      const Arn = yield* dashboard.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dashboard}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dashboard.LogicalId})`)(function* (
        request: Req,
      ) {
        const arn = yield* Arn;
        const dashboardId = yield* DashboardId;
        return yield* op({
          ...options.applyDefaults(request, { dashboardId, arn }),
          AwsAccountId: accountIdFromArn(arn),
        } as I);
      });
    });
  });
