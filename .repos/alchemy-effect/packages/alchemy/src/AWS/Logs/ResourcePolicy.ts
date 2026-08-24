import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface ResourcePolicyProps {
  /**
   * Name of the resource policy. The policy name is the identity of the
   * policy within the account and region (put semantics upsert by name).
   * If omitted, a unique name is generated. Changing this value replaces
   * the policy.
   */
  policyName?: string;
  /**
   * The policy document granting an AWS service principal (e.g.
   * `route53.amazonaws.com`, `es.amazonaws.com`) permission to write to
   * CloudWatch Logs, either as a JSON string or a structured document.
   */
  policyDocument: PolicyDocument | string;
}

export interface ResourcePolicy extends Resource<
  "AWS.Logs.ResourcePolicy",
  ResourcePolicyProps,
  {
    policyName: string;
    policyDocument: string;
  },
  never,
  Providers
> {}

/**
 * An account-scoped CloudWatch Logs resource policy — grants AWS service
 * principals (Route 53 query logging, API Gateway execution logs, OpenSearch
 * slow logs, ...) permission to deliver logs into your account.
 *
 * :::warning
 * AWS allows at most **10 resource policies per region per account** and the
 * quota cannot be raised. Always use a deterministic `policyName` and destroy
 * policies you no longer need.
 * :::
 * @resource
 * @section Granting Log Delivery
 * @example Allow Route 53 Query Logging
 * ```typescript
 * const policy = yield* ResourcePolicy("Route53QueryLogging", {
 *   policyName: "route53-query-logging",
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "route53.amazonaws.com" },
 *         Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
 *         Resource: `arn:aws:logs:us-east-1:${accountId}:log-group:/aws/route53/*`,
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const ResourcePolicy = Resource<ResourcePolicy>(
  "AWS.Logs.ResourcePolicy",
);

export const ResourcePolicyProvider = () =>
  Provider.effect(
    ResourcePolicy,
    Effect.gen(function* () {
      const toPolicyName = (id: string, props: { policyName?: string } = {}) =>
        props.policyName
          ? Effect.succeed(props.policyName)
          : createPhysicalName({ id, maxLength: 255 });

      const toDocumentString = (document: PolicyDocument | string) =>
        typeof document === "string" ? document : JSON.stringify(document);

      // The account quota is 10 policies per region, so a single describe
      // call (limit 50) is always exhaustive — no pagination needed.
      const describeAll = logs
        .describeResourcePolicies({ limit: 50 })
        .pipe(Effect.map((response) => response.resourcePolicies ?? []));

      const observe = Effect.fn(function* (policyName: string) {
        const policies = yield* describeAll;
        return policies.find((policy) => policy.policyName === policyName);
      });

      return {
        stables: ["policyName"],
        list: () =>
          describeAll.pipe(
            Effect.map((policies) =>
              policies
                .filter(
                  (
                    policy,
                  ): policy is logs.ResourcePolicy & { policyName: string } =>
                    policy.policyName != null,
                )
                .map((policy) => ({
                  policyName: policy.policyName,
                  policyDocument: policy.policyDocument ?? "",
                })),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toPolicyName(id, olds)) !== (yield* toPolicyName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const policyName =
            output?.policyName ?? (yield* toPolicyName(id, olds ?? {}));
          const observed = yield* observe(policyName);
          if (!observed) return undefined;
          return {
            policyName,
            policyDocument: observed.policyDocument ?? "",
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const policyName =
            output?.policyName ?? (yield* toPolicyName(id, news));
          const desiredDocument = toDocumentString(news.policyDocument);

          // Observe — putResourcePolicy upserts by name; skip the put when the
          // live document already matches the desired one.
          const observed = yield* observe(policyName);
          if (observed?.policyDocument !== desiredDocument) {
            yield* logs
              .putResourcePolicy({
                policyName,
                policyDocument: desiredDocument,
              })
              .pipe(
                Effect.retry({
                  while: (error) =>
                    error._tag === "OperationAbortedException" ||
                    error._tag === "ServiceUnavailableException",
                  schedule: Schedule.exponential(100),
                  times: 8,
                }),
              );
          }

          yield* session.note(policyName);

          return {
            policyName,
            policyDocument: desiredDocument,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteResourcePolicy({ policyName: output.policyName })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "OperationAbortedException" ||
                  error._tag === "ServiceUnavailableException",
                schedule: Schedule.exponential(100),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
