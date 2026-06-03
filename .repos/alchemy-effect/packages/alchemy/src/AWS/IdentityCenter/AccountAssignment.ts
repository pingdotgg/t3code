import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { resolveInstance, retryIdentityCenter } from "./common.ts";

export interface AccountAssignmentProps {
  /**
   * Explicit Identity Center instance ARN.
   * If omitted, Alchemy adopts the only visible instance.
   */
  instanceArn?: string;
  /**
   * Permission set ARN to assign.
   */
  permissionSetArn: string;
  /**
   * Principal ID from the IAM Identity Center identity store.
   */
  principalId: string;
  /**
   * Principal type.
   */
  principalType: "USER" | "GROUP";
  /**
   * Target AWS account ID.
   */
  targetId: string;
}

export interface AccountAssignment extends Resource<
  "AWS.IdentityCenter.AccountAssignment",
  AccountAssignmentProps,
  {
    instanceArn: string;
    permissionSetArn: string;
    principalId: string;
    principalType: "USER" | "GROUP";
    targetId: string;
    targetType: "AWS_ACCOUNT";
  },
  never,
  Providers
> {}

/**
 * Assigns an IAM Identity Center permission set to a user or group in an AWS
 * account.
 *
 * @section Creating Assignments
 * @example Assign A Group To A Workload Account
 * ```typescript
 * const assignment = yield* AccountAssignment("ProdAdminAssignment", {
 *   permissionSetArn: admin.permissionSetArn,
 *   principalType: "GROUP",
 *   principalId: engineers.groupId,
 *   targetId: prod.accountId,
 * });
 * ```
 */
export const AccountAssignment = Resource<AccountAssignment>(
  "AWS.IdentityCenter.AccountAssignment",
);

export const AccountAssignmentProvider = () =>
  Provider.effect(
    AccountAssignment,
    Effect.gen(function* () {
      return {
        stables: [
          "instanceArn",
          "permissionSetArn",
          "principalId",
          "principalType",
          "targetId",
          "targetType",
        ],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.instanceArn !== news.instanceArn ||
            olds?.permissionSetArn !== news.permissionSetArn ||
            olds?.principalId !== news.principalId ||
            olds?.principalType !== news.principalType ||
            olds?.targetId !== news.targetId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.instanceArn) {
            return yield* readAssignment({
              instanceArn: output.instanceArn,
              permissionSetArn: output.permissionSetArn,
              principalId: output.principalId,
              principalType: output.principalType,
              targetId: output.targetId,
            });
          }

          if (!olds) {
            return undefined;
          }

          return yield* readAssignment(olds);
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — look up the assignment between (principal,
          // permissionSet, target). All identifying fields are stable;
          // diff() forces a replace on any change, so this reconcile is
          // existence-only.
          const existing = yield* readAssignment({
            ...news,
            instanceArn: output?.instanceArn ?? news.instanceArn,
          });
          if (existing) {
            yield* session.note(
              `${existing.targetId}:${existing.permissionSetArn}:${existing.principalId}`,
            );
            return existing;
          }

          // Ensure — create the assignment if missing.
          const instance = yield* resolveInstance(news.instanceArn);
          const response = yield* retryIdentityCenter(
            ssoAdmin.createAccountAssignment({
              InstanceArn: instance.InstanceArn!,
              PermissionSetArn: news.permissionSetArn,
              PrincipalId: news.principalId,
              PrincipalType: news.principalType,
              TargetId: news.targetId,
              TargetType: "AWS_ACCOUNT",
            }),
          );

          const requestId =
            response.AccountAssignmentCreationStatus?.RequestId ?? undefined;
          if (requestId) {
            yield* waitForAssignmentCreation(instance.InstanceArn!, requestId);
          }

          const created = yield* readAssignment({
            ...news,
            instanceArn: instance.InstanceArn,
          });
          if (!created) {
            return yield* Effect.fail(
              new Error("account assignment not found after create"),
            );
          }

          yield* session.note(
            `${created.targetId}:${created.permissionSetArn}:${created.principalId}`,
          );
          return created;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* readAssignment(output))) {
            return;
          }

          const response = yield* retryIdentityCenter(
            ssoAdmin
              .deleteAccountAssignment({
                InstanceArn: output.instanceArn,
                PermissionSetArn: output.permissionSetArn,
                PrincipalId: output.principalId,
                PrincipalType: output.principalType,
                TargetId: output.targetId,
                TargetType: "AWS_ACCOUNT",
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              ),
          );

          const requestId =
            response?.AccountAssignmentDeletionStatus?.RequestId ?? undefined;
          if (requestId) {
            yield* waitForAssignmentDeletion(output.instanceArn, requestId);
          }
        }),
      };
    }),
  );

const readAssignment = Effect.fn(function* ({
  instanceArn,
  permissionSetArn,
  principalId,
  principalType,
  targetId,
}: AccountAssignmentProps) {
  const instance = yield* resolveInstance(instanceArn);
  const assignments = yield* ssoAdmin.listAccountAssignments
    .items({
      InstanceArn: instance.InstanceArn!,
      AccountId: targetId,
      PermissionSetArn: permissionSetArn,
      MaxResults: 100,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((items) => Array.from(items) as ssoAdmin.AccountAssignment[]),
    );

  const match = assignments.find(
    (assignment) =>
      assignment.PrincipalId === principalId &&
      assignment.PrincipalType === principalType,
  );

  return match
    ? ({
        instanceArn: instance.InstanceArn!,
        permissionSetArn,
        principalId,
        principalType,
        targetId,
        targetType: "AWS_ACCOUNT",
      } satisfies AccountAssignment["Attributes"])
    : undefined;
});

const waitForAssignmentCreation = (instanceArn: string, requestId: string) =>
  Effect.gen(function* () {
    const response = yield* retryIdentityCenter(
      ssoAdmin.describeAccountAssignmentCreationStatus({
        InstanceArn: instanceArn,
        AccountAssignmentCreationRequestId: requestId,
      }),
    );
    const status = response.AccountAssignmentCreationStatus;

    if (!status?.Status || status.Status === "IN_PROGRESS") {
      return yield* Effect.fail({
        _tag: "AssignmentCreationInProgress" as const,
      });
    }

    if (status.Status === "FAILED") {
      return yield* Effect.fail(
        new Error(
          `account assignment creation failed: ${status.FailureReason ?? "unknown failure"}`,
        ),
      );
    }

    return status;
  }).pipe(
    Effect.retry({
      while: (error: any) => error?._tag === "AssignmentCreationInProgress",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );

const waitForAssignmentDeletion = (instanceArn: string, requestId: string) =>
  Effect.gen(function* () {
    const response = yield* retryIdentityCenter(
      ssoAdmin.describeAccountAssignmentDeletionStatus({
        InstanceArn: instanceArn,
        AccountAssignmentDeletionRequestId: requestId,
      }),
    );
    const status = response.AccountAssignmentDeletionStatus;

    if (!status?.Status || status.Status === "IN_PROGRESS") {
      return yield* Effect.fail({
        _tag: "AssignmentDeletionInProgress" as const,
      });
    }

    if (status.Status === "FAILED") {
      return yield* Effect.fail(
        new Error(
          `account assignment deletion failed: ${status.FailureReason ?? "unknown failure"}`,
        ),
      );
    }

    return status;
  }).pipe(
    Effect.retry({
      while: (error: any) => error?._tag === "AssignmentDeletionInProgress",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );
