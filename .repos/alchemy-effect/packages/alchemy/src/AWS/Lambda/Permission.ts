import type * as lambda from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export type { FunctionUrlAuthType } from "@distilled.cloud/aws/lambda";

export interface PermissionProps {
  /**
   * The action that the principal can use on the function.
   * For example, `lambda:InvokeFunction` or `lambda:GetFunction`.
   */
  action: string;

  /**
   * The name or ARN of the Lambda function, version, or alias.
   */
  functionName: string;

  /**
   * The AWS service, AWS account, IAM user, or IAM role that invokes the function.
   * If you specify a service, use `sourceArn` or `sourceAccount` to limit who can
   * invoke the function through that service.
   */
  principal: string;

  /**
   * For Alexa Smart Home functions, a token that the invoker must supply.
   */
  eventSourceToken?: string;

  /**
   * The type of authentication that your function URL uses.
   * Set to `AWS_IAM` to restrict access to authenticated users only.
   * Set to `NONE` to bypass IAM authentication to create a public endpoint.
   */
  functionUrlAuthType?: lambda.FunctionUrlAuthType;

  /**
   * Indicates whether the permission applies when the function is invoked
   * through a function URL.
   */
  invokedViaFunctionUrl?: boolean;

  /**
   * The identifier for your organization in AWS Organizations.
   * Use this to grant permissions to all the AWS accounts under this organization.
   */
  principalOrgID?: string;

  /**
   * For AWS services, the ID of the AWS account that owns the resource.
   * Use this together with `sourceArn` to ensure that the specified account owns the resource.
   */
  sourceAccount?: string;

  /**
   * For AWS services, the ARN of the AWS resource that invokes the function.
   * For example, an Amazon S3 bucket or Amazon SNS topic.
   */
  sourceArn?: string;
}

export interface Permission extends Resource<
  "AWS.Lambda.Permission",
  PermissionProps,
  {
    /** The statement ID of the permission. */
    statementId: string;
    /** The function name or ARN the permission is attached to. */
    functionName: string;
  },
  never,
  Providers
> {}

/**
 * A Lambda permission that grants an AWS service or another account permission to
 * invoke a function.
 * @resource
 * @section Granting Permissions
 * @example S3 Notification Permission
 * ```typescript
 * const perm = yield* Permission("S3Invoke", {
 *   action: "lambda:InvokeFunction",
 *   functionName: yield* fn.functionArn(),
 *   principal: "s3.amazonaws.com",
 *   sourceArn: yield* bucket.bucketArn,
 *   sourceAccount: (yield* AWSEnvironment.current).accountId,
 * });
 * ```
 *
 * @example Cross Account Invoke
 * ```typescript
 * const perm = yield* Permission("CrossAccount", {
 *   action: "lambda:InvokeFunction",
 *   functionName: yield* fn.functionArn(),
 *   principal: "123456789012",
 * });
 * ```
 *
 * @example Public Function URL
 * ```typescript
 * const perm = yield* Permission("PublicUrl", {
 *   action: "lambda:InvokeFunctionUrl",
 *   functionName: yield* fn.functionArn(),
 *   principal: "*",
 *   functionUrlAuthType: "NONE",
 * });
 * ```
 */
export const Permission = Resource<Permission>("AWS.Lambda.Permission");

export const PermissionProvider = () =>
  Provider.effect(
    Permission,
    Effect.gen(function* () {
      const createStatementId = (id: string) =>
        createPhysicalName({
          id,
          maxLength: 100,
          delimiter: "-",
        });

      type PermissionAttrs = { statementId: string; functionName: string };

      // Lambda serializes resource-policy mutations per function. Parallel
      // Permission resources (for example several API Gateway routes) can
      // therefore receive a transient ResourceConflictException even when
      // their statement ids are distinct. Keep the retry bounded well below
      // the provider/test timeout.
      type PolicyMutationError =
        | Lambda.AddPermissionError
        | Lambda.RemovePermissionError;
      const retryPolicyMutation = {
        while: (error: PolicyMutationError) =>
          error._tag === "ResourceConflictException",
        schedule: Schedule.spaced("500 millis"),
        times: 8,
      } as const;

      const addPermission = (request: Lambda.AddPermissionRequest) =>
        Lambda.addPermission(request).pipe(Effect.retry(retryPolicyMutation));

      const removePermission = (request: Lambda.RemovePermissionRequest) =>
        Lambda.removePermission(request).pipe(
          Effect.retry(retryPolicyMutation),
        );

      const hasStatement = Effect.fn(function* (
        functionName: string,
        statementId: string,
      ) {
        const { Policy } = yield* Lambda.getPolicy({
          FunctionName: functionName,
        }).pipe(
          // A function without a resource policy is reported as not found.
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({ Policy: undefined }),
          ),
        );
        if (!Policy) return false;
        return yield* Effect.try({
          try: () => {
            const policy = JSON.parse(Policy) as {
              Statement?: { Sid?: string } | { Sid?: string }[];
            };
            const statements = Array.isArray(policy.Statement)
              ? policy.Statement
              : policy.Statement
                ? [policy.Statement]
                : [];
            return statements.some(
              (statement) => statement.Sid === statementId,
            );
          },
          catch: (cause) =>
            new Error("invalid Lambda resource policy", { cause }),
        });
      });

      return {
        stables: ["statementId", "functionName"],
        list: () =>
          Effect.gen(function* () {
            // Lambda has no list-permissions API. A Permission is a single
            // statement (Sid) inside a function's resource policy, so we fan
            // out: enumerate every function in the ambient account/region
            // (paginated listFunctions), getPolicy per function, parse the
            // policy JSON, and emit one Attributes per statement Sid.
            const functionNames = yield* Lambda.listFunctions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Functions ?? [])
                    .map((fn) => fn.FunctionName)
                    .filter((name): name is string => name != null),
                ),
              ),
            );

            const perFunction = yield* Effect.forEach(
              functionNames,
              (functionName) =>
                Effect.gen(function* () {
                  const { Policy } = yield* Lambda.getPolicy({
                    FunctionName: functionName,
                  });
                  if (!Policy) return [] as PermissionAttrs[];
                  const policy = yield* Effect.try({
                    try: () =>
                      JSON.parse(Policy) as {
                        Statement?: { Sid?: string } | { Sid?: string }[];
                      },
                    catch: (cause) => new Error("invalid policy", { cause }),
                  }).pipe(
                    // A malformed/non-JSON policy yields no permissions
                    // rather than failing the whole enumeration.
                    Effect.orElseSucceed(() => ({
                      Statement: [] as { Sid?: string }[],
                    })),
                  );
                  const statements = Array.isArray(policy.Statement)
                    ? policy.Statement
                    : policy.Statement
                      ? [policy.Statement]
                      : [];
                  return statements
                    .filter(
                      (s): s is { Sid: string } => typeof s.Sid === "string",
                    )
                    .map(
                      (s): PermissionAttrs => ({
                        statementId: s.Sid,
                        functionName,
                      }),
                    );
                }).pipe(
                  // Functions with no resource policy / removed out of band
                  // between list and getPolicy — skip them.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as PermissionAttrs[]),
                  ),
                ),
              { concurrency: 10 },
            );
            return perFunction.flat();
          }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (news.functionName !== olds.functionName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — derive identity. The statementId is deterministic from
          // the logical id, so we always use it whether this is a first
          // reconciliation, an adoption, or a re-run after a partial create.
          const statementId =
            output?.statementId ?? (yield* createStatementId(id));

          // Observe the deterministic Sid before mutating. An existing Sid is
          // a true create/update collision and must be replaced; a
          // ResourceConflictException from an absent Sid is instead Lambda's
          // transient per-function policy mutation lock and is retried.
          if (yield* hasStatement(news.functionName, statementId)) {
            yield* removePermission({
              FunctionName: news.functionName,
              StatementId: statementId,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }

          yield* addPermission({
            FunctionName: news.functionName,
            StatementId: statementId,
            Action: news.action,
            Principal: news.principal,
            SourceArn: news.sourceArn,
            SourceAccount: news.sourceAccount,
            EventSourceToken: news.eventSourceToken,
            FunctionUrlAuthType: news.functionUrlAuthType,
            InvokedViaFunctionUrl: news.invokedViaFunctionUrl,
            PrincipalOrgID: news.principalOrgID,
          });

          yield* session.note(
            `Permission ${statementId} on ${news.functionName}`,
          );

          return {
            statementId,
            functionName: news.functionName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removePermission({
            FunctionName: output.functionName,
            StatementId: output.statementId,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
