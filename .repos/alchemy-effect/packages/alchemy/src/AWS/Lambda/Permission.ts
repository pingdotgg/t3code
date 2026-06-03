import type * as lambda from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
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
 *
 * @section Granting Permissions
 * @example S3 Notification Permission
 * ```typescript
 * const perm = yield* Permission("S3Invoke", {
 *   action: "lambda:InvokeFunction",
 *   functionName: yield* fn.functionArn(),
 *   principal: "s3.amazonaws.com",
 *   sourceArn: yield* bucket.bucketArn,
 *   sourceAccount: (yield* AWSEnvironment).accountId,
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

      return {
        stables: ["statementId", "functionName"],
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

          // Ensure + sync — addPermission has no "update" API, so we
          // unconditionally re-add. Tolerate `ResourceConflictException`
          // (statement already exists) by removing and re-adding so the
          // permission ends up matching `news`.
          yield* Lambda.addPermission({
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
          }).pipe(
            Effect.catchTag("ResourceConflictException", () =>
              Effect.gen(function* () {
                yield* Lambda.removePermission({
                  FunctionName: news.functionName,
                  StatementId: statementId,
                }).pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
                yield* Lambda.addPermission({
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
              }),
            ),
          );

          yield* session.note(
            `Permission ${statementId} on ${news.functionName}`,
          );

          return {
            statementId,
            functionName: news.functionName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Lambda.removePermission({
            FunctionName: output.functionName,
            StatementId: output.statementId,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
