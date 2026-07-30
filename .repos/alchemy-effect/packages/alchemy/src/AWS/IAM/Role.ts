import * as iam from "@distilled.cloud/aws/iam";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { PolicyDocument, PolicyStatement } from "./Policy.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import {
  parsePolicyDocument,
  stringifyPolicyDocument,
  toTagRecord,
} from "./common.ts";

export type RoleName = string;
export type RoleArn = `arn:aws:iam::${AccountID}:role/${RoleName}`;

/**
 * IAM misuses `MalformedPolicyDocument` for an eventual-consistency case: a
 * trust policy whose `Principal` names a *freshly created* user/role is
 * rejected with "Invalid principal in policy" until that principal finishes
 * propagating through IAM (typically a few seconds). That specific message is
 * retryable; a genuinely malformed document (bad syntax/fields) is not and
 * fails fast because its message never matches.
 */
const invalidPrincipalRetry = {
  while: (e: { _tag: string; message?: string }) =>
    e._tag === "MalformedPolicyDocumentException" &&
    (e.message?.includes("Invalid principal") ?? false),
  schedule: Schedule.exponential("2 seconds"),
  times: 5,
} as const;

export interface RoleProps {
  /**
   * Name of the role. If omitted, a unique name will be generated.
   */
  roleName?: string;
  /**
   * Optional IAM path prefix for the role.
   * @default "/"
   */
  path?: string;
  /**
   * IAM trust policy for the role. Optional when a binding contributes the
   * trust statements (see the `assumeRolePolicyStatements` binding field) — at
   * least one of the two must supply a statement.
   */
  assumeRolePolicyDocument?: PolicyDocument;
  /**
   * Managed policy ARNs to attach to the role.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies keyed by policy name.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
  /**
   * Optional description for the role.
   */
  description?: string;
  /**
   * Maximum session duration, e.g. `"4 hours"` or `Duration.hours(4)`.
   * Sent to IAM as whole seconds (a bare number is milliseconds).
   */
  maxSessionDuration?: Duration.Input;
  /**
   * Optional managed policy ARN used as the permissions boundary.
   */
  permissionsBoundary?: string;
  /**
   * User-defined tags to apply to the role.
   */
  tags?: Record<string, string>;
}

export interface Role extends Resource<
  "AWS.IAM.Role",
  RoleProps,
  {
    /** The ARN of the role. */
    roleArn: RoleArn;
    /** The name of the role. */
    roleName: RoleName;
    /** The stable unique ID of the role. */
    roleId: string | undefined;
    /** The IAM path of the role. */
    path: string | undefined;
    /** The trust policy in effect for the role. */
    assumeRolePolicyDocument: PolicyDocument;
    /** Managed policy ARNs attached to the role. */
    managedPolicyArns: string[];
    /** Inline policies embedded in the role, keyed by policy name. */
    inlinePolicies: Record<string, PolicyDocument>;
    /** The description of the role. */
    description: string | undefined;
    /** The maximum session duration, in seconds. */
    maxSessionDuration: number | undefined;
    /** The managed policy ARN used as the permissions boundary, if any. */
    permissionsBoundary: string | undefined;
    /** The tags applied to the role. */
    tags: Record<string, string>;
  },
  {
    /**
     * IAM policy statements contributed by bindings (e.g. a consumer granting
     * this role access to a resource). They are folded into a managed inline
     * policy named `alchemy-bindings` on the role.
     */
    policyStatements?: PolicyStatement[];
    /**
     * Trust-policy (assume-role) statements contributed by bindings — e.g. a
     * consumer declaring which service principal may assume this role. They are
     * merged into the role's `assumeRolePolicyDocument`.
     */
    assumeRolePolicyStatements?: PolicyStatement[];
  },
  Providers
> {}

/**
 * Name of the inline policy the role provider synthesizes from binding-supplied
 * {@link PolicyStatement}s.
 */
const BINDINGS_POLICY_NAME = "alchemy-bindings";

/**
 * Merge the user's inline policies with a synthetic `alchemy-bindings` policy
 * built from binding-supplied statements (deduped by JSON identity, sorted for
 * a stable document).
 */
const mergeBoundInlinePolicies = (
  inlinePolicies: Record<string, PolicyDocument> | undefined,
  bindings: ResourceBinding<Role["Binding"]>[],
): Record<string, PolicyDocument> => {
  const statements = bindings
    .filter((binding) => (binding as { action?: string }).action !== "delete")
    .flatMap((binding) => binding.data?.policyStatements ?? []);
  if (statements.length === 0) return inlinePolicies ?? {};
  const deduped = Array.from(
    new Map(statements.map((s) => [JSON.stringify(s), s])).values(),
  ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    ...inlinePolicies,
    [BINDINGS_POLICY_NAME]: { Version: "2012-10-17", Statement: deduped },
  };
};

/**
 * Merge the user's trust policy with binding-supplied assume-role statements
 * (deduped by JSON identity, sorted for a stable document).
 */
const mergeBoundAssumeRolePolicy = (
  doc: PolicyDocument | undefined,
  bindings: ResourceBinding<Role["Binding"]>[],
): PolicyDocument => {
  const bound = bindings
    .filter((binding) => (binding as { action?: string }).action !== "delete")
    .flatMap((binding) => binding.data?.assumeRolePolicyStatements ?? []);
  const statements = [...(doc?.Statement ?? []), ...bound];
  const deduped = Array.from(
    new Map(statements.map((s) => [JSON.stringify(s), s])).values(),
  ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { Version: "2012-10-17", Statement: deduped };
};

/**
 * An IAM role for AWS services and runtimes.
 * @resource
 * @section Creating Roles
 * @example ECS Task Role
 * ```typescript
 * const role = yield* Role("TaskRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "ecs-tasks.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 * ```
 *
 * @section Granting Permissions
 * @example Attach a Customer-Managed Policy
 * ```typescript
 * const policy = yield* Policy("AppPolicy", {
 *   policyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Action: ["s3:GetObject"],
 *       Resource: ["arn:aws:s3:::my-bucket/*"],
 *     }],
 *   },
 * });
 *
 * const role = yield* Role("AppRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "lambda.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 *   managedPolicyArns: [policy.policyArn],
 *   inlinePolicies: {
 *     Logs: {
 *       Version: "2012-10-17",
 *       Statement: [{
 *         Effect: "Allow",
 *         Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
 *         Resource: ["*"],
 *       }],
 *     },
 *   },
 * });
 * ```
 */
export const Role = Resource<Role>("AWS.IAM.Role");

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      const toRoleName = (id: string, props: { roleName?: string } = {}) =>
        props.roleName
          ? Effect.succeed(props.roleName)
          : createPhysicalName({ id, maxLength: 64 });

      const readInlinePolicies = Effect.fn(function* (roleName: string) {
        const policyNames = yield* iam.listRolePolicies
          .items({ RoleName: roleName })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const entries = yield* Effect.all(
          policyNames.map((policyName) =>
            iam
              .getRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.map(
                  (response) =>
                    [
                      policyName,
                      parsePolicyDocument(response.PolicyDocument),
                    ] as const,
                ),
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed([policyName, undefined] as const),
                ),
              ),
          ),
        );
        return Object.fromEntries(
          entries.filter(
            (entry): entry is [string, PolicyDocument] =>
              entry[1] !== undefined,
          ),
        );
      });

      const readManagedPolicies = Effect.fn(function* (roleName: string) {
        const attached = yield* iam.listAttachedRolePolicies
          .items({ RoleName: roleName })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        return attached
          .map((policy) => policy.PolicyArn)
          .filter(
            (policyArn): policyArn is string => typeof policyArn === "string",
          );
      });

      const readTags = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listRoleTags({
          RoleName: roleName,
        });
        return toTagRecord(listed.Tags);
      });

      const syncManagedPolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
      }: {
        roleName: string;
        olds: string[];
        news: string[];
      }) {
        const oldSet = new Set(olds);
        const newSet = new Set(news);

        for (const policyArn of news) {
          if (!oldSet.has(policyArn)) {
            yield* iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            });
          }
        }

        for (const policyArn of olds) {
          if (!newSet.has(policyArn)) {
            yield* iam
              .detachRolePolicy({
                RoleName: roleName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      const syncInlinePolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
      }: {
        roleName: string;
        olds: Record<string, PolicyDocument>;
        news: Record<string, PolicyDocument>;
      }) {
        for (const [policyName, document] of Object.entries(news)) {
          if (
            JSON.stringify(olds[policyName] ?? null) !==
            JSON.stringify(document)
          ) {
            yield* iam.putRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
              PolicyDocument: stringifyPolicyDocument(document),
            });
          }
        }

        for (const policyName of Object.keys(olds)) {
          if (!(policyName in news)) {
            yield* iam
              .deleteRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      return {
        stables: ["roleArn", "roleName"],
        list: () =>
          Effect.gen(function* () {
            // IAM is global; `listRoles` enumerates every role in the
            // account. Paginate exhaustively, then hydrate each role's
            // managed/inline policies and tags (the list summary omits
            // them) to produce the same Attributes shape `read` returns.
            const roles = yield* iam.listRoles.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk)
                  .flatMap((page) => page.Roles ?? [])
                  // Service-linked roles are owned by AWS and cannot be
                  // modified or deleted by us (UnmodifiableEntityException).
                  .filter(
                    (role) => !role.Path?.startsWith("/aws-service-role/"),
                  ),
              ),
            );

            const hydrated = yield* Effect.forEach(
              roles,
              (role) =>
                Effect.gen(function* () {
                  const assumeRolePolicyDocument = parsePolicyDocument(
                    role.AssumeRolePolicyDocument,
                  );
                  if (!assumeRolePolicyDocument) {
                    return undefined;
                  }
                  const [managedPolicyArns, inlinePolicies, tags] =
                    yield* Effect.all([
                      readManagedPolicies(role.RoleName),
                      readInlinePolicies(role.RoleName),
                      readTags(role.RoleName),
                    ]);
                  return {
                    roleArn: role.Arn as RoleArn,
                    roleName: role.RoleName,
                    roleId: role.RoleId,
                    path: role.Path,
                    assumeRolePolicyDocument,
                    managedPolicyArns,
                    inlinePolicies,
                    description: role.Description,
                    maxSessionDuration: role.MaxSessionDuration,
                    permissionsBoundary:
                      role.PermissionsBoundary?.PermissionsBoundaryArn,
                    tags,
                  };
                }).pipe(
                  // A role may be deleted concurrently mid-hydration.
                  Effect.catchTag("NoSuchEntityException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 8 },
            );

            return hydrated.filter(
              (attrs): attrs is NonNullable<typeof attrs> =>
                attrs !== undefined,
            );
          }),
        diff: Effect.fn(function* ({ id, olds, news = {} }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRoleName(id, olds ?? {})) !==
            (yield* toRoleName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news?.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const roleName =
            output?.roleName ?? (yield* toRoleName(id, olds ?? {}));
          const role = yield* iam
            .getRole({
              RoleName: roleName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!role?.Role) {
            return undefined;
          }

          const [managedPolicyArns, inlinePolicies, tags] = yield* Effect.all([
            readManagedPolicies(roleName),
            readInlinePolicies(roleName),
            readTags(roleName),
          ]);

          const assumeRolePolicyDocument =
            parsePolicyDocument(role.Role.AssumeRolePolicyDocument) ??
            output?.assumeRolePolicyDocument;
          if (!assumeRolePolicyDocument) {
            return undefined;
          }

          const attrs = {
            roleArn: role.Role.Arn as RoleArn,
            roleName: role.Role.RoleName,
            roleId: role.Role.RoleId,
            path: role.Role.Path,
            assumeRolePolicyDocument,
            managedPolicyArns,
            inlinePolicies,
            description: role.Role.Description,
            maxSessionDuration: role.Role.MaxSessionDuration,
            permissionsBoundary:
              role.Role.PermissionsBoundary?.PermissionsBoundaryArn,
            tags,
          };
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          output,
          session,
          bindings,
        }) {
          const roleName = output?.roleName ?? (yield* toRoleName(id, news));
          // Fold binding-supplied policy statements into the inline policies.
          const inlinePolicies = mergeBoundInlinePolicies(
            news.inlinePolicies,
            bindings,
          );
          // Merge binding-supplied trust statements into the trust policy.
          const assumeRolePolicyDocument = mergeBoundAssumeRolePolicy(
            news.assumeRolePolicyDocument,
            bindings,
          );
          if (assumeRolePolicyDocument.Statement.length === 0) {
            return yield* Effect.die(
              "Role requires a trust policy: set `assumeRolePolicyDocument` or bind `assumeRolePolicyStatements`.",
            );
          }
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const desiredMaxSessionDuration = toWireSeconds(
            news.maxSessionDuration,
          );

          // Observe — read the role from IAM. Absence is signalled by
          // `NoSuchEntityException`; ownership has already been verified
          // upstream so adopting a `Unowned` role is the engine's call.
          let observedRole = yield* iam
            .getRole({ RoleName: roleName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the role when missing. A peer reconciler may
          // have created it concurrently; tolerate that race by reading
          // the existing role.
          if (!observedRole?.Role) {
            observedRole = yield* iam
              .createRole({
                Path: news.path,
                RoleName: roleName,
                AssumeRolePolicyDocument: stringifyPolicyDocument(
                  assumeRolePolicyDocument,
                ),
                Description: news.description,
                MaxSessionDuration: desiredMaxSessionDuration,
                PermissionsBoundary: news.permissionsBoundary,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.retry(invalidPrincipalRetry),
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  iam.getRole({ RoleName: roleName }),
                ),
              );
          }

          const observedAssumePolicy = parsePolicyDocument(
            observedRole.Role?.AssumeRolePolicyDocument,
          );
          const observedDescription = observedRole.Role?.Description;
          const observedMaxSessionDuration =
            observedRole.Role?.MaxSessionDuration;
          const observedPermissionsBoundary =
            observedRole.Role?.PermissionsBoundary?.PermissionsBoundaryArn;

          // Sync assume-role policy — only call updateAssumeRolePolicy
          // when the document actually differs.
          if (
            JSON.stringify(observedAssumePolicy ?? null) !==
            JSON.stringify(assumeRolePolicyDocument)
          ) {
            yield* iam
              .updateAssumeRolePolicy({
                RoleName: roleName,
                PolicyDocument: stringifyPolicyDocument(
                  assumeRolePolicyDocument,
                ),
              })
              .pipe(Effect.retry(invalidPrincipalRetry));
          }

          // Sync description / maxSessionDuration via updateRole.
          if (
            observedDescription !== news.description ||
            observedMaxSessionDuration !== desiredMaxSessionDuration
          ) {
            yield* iam.updateRole({
              RoleName: roleName,
              Description: news.description,
              MaxSessionDuration: desiredMaxSessionDuration,
            });
          }

          // Sync permissions boundary — put when desired, delete when
          // cleared, no-op when unchanged.
          if (news.permissionsBoundary !== observedPermissionsBoundary) {
            if (news.permissionsBoundary) {
              yield* iam.putRolePermissionsBoundary({
                RoleName: roleName,
                PermissionsBoundary: news.permissionsBoundary,
              });
            } else if (observedPermissionsBoundary) {
              yield* iam
                .deleteRolePermissionsBoundary({
                  RoleName: roleName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }

          // Sync managed and inline policies — observe the live state
          // and apply only the delta. This is robust to manual edits in
          // the AWS console and to adoption.
          const [observedManagedPolicies, observedInlinePolicies] =
            yield* Effect.all([
              readManagedPolicies(roleName),
              readInlinePolicies(roleName),
            ]);
          yield* syncManagedPolicies({
            roleName,
            olds: observedManagedPolicies,
            news: news.managedPolicyArns ?? [],
          });
          yield* syncInlinePolicies({
            roleName,
            olds: observedInlinePolicies,
            news: inlinePolicies,
          });

          // Sync tags against the cloud's actual tags so adoption /
          // out-of-band tag changes converge.
          const observedTags = yield* readTags(roleName);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagRole({
              RoleName: roleName,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagRole({
              RoleName: roleName,
              TagKeys: removed,
            });
          }

          // Re-read for fresh attributes after all mutations.
          const liveRole = yield* iam.getRole({ RoleName: roleName });
          const roleArn = (liveRole.Role?.Arn ??
            observedRole.Role?.Arn ??
            `arn:aws:iam::${(yield* AWSEnvironment.current).accountId}:role/${roleName}`) as RoleArn;

          yield* session.note(roleArn);
          return {
            roleArn,
            roleName: liveRole.Role?.RoleName ?? roleName,
            roleId: liveRole.Role?.RoleId ?? observedRole.Role?.RoleId,
            path:
              liveRole.Role?.Path ??
              observedRole.Role?.Path ??
              news.path ??
              "/",
            assumeRolePolicyDocument,
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies,
            description: liveRole.Role?.Description ?? news.description,
            maxSessionDuration:
              liveRole.Role?.MaxSessionDuration ?? desiredMaxSessionDuration,
            permissionsBoundary:
              liveRole.Role?.PermissionsBoundary?.PermissionsBoundaryArn ??
              news.permissionsBoundary,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteRolePermissionsBoundary({
              RoleName: output.roleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

          yield* iam.listRolePolicies.items({ RoleName: output.roleName }).pipe(
            Stream.mapEffect((policyName) =>
              iam
                .deleteRolePolicy({
                  RoleName: output.roleName,
                  PolicyName: policyName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                ),
            ),
            Stream.runDrain,
            // The role itself may already be gone.
            Effect.catchTag("NoSuchEntityException", () => Effect.void),
          );

          yield* iam.listAttachedRolePolicies
            .items({ RoleName: output.roleName })
            .pipe(
              Stream.mapEffect((policy) =>
                iam
                  .detachRolePolicy({
                    RoleName: output.roleName,
                    PolicyArn: policy.PolicyArn!,
                  })
                  .pipe(
                    Effect.catchTag("NoSuchEntityException", () => Effect.void),
                  ),
              ),
              Stream.runDrain,
              // The role itself may already be gone.
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );

          yield* iam
            .deleteRole({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "ConcurrentModificationException" ||
                  error._tag === "DeleteConflictException" ||
                  error._tag === "LimitExceededException" ||
                  error._tag === "ServiceFailureException",
                schedule: Schedule.max([
                  Schedule.exponential("250 millis"),
                  Schedule.recurs(8),
                ]),
              }),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );

          // IAM deletion is eventually consistent. Do not let the engine
          // discard state until the role is actually absent, otherwise a
          // following clean run (or nuke) can still discover the old role.
          for (let attempt = 0; attempt < 30; attempt++) {
            const remaining = yield* iam
              .getRole({ RoleName: output.roleName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (remaining === undefined) return;
            yield* Effect.sleep("1 second");
          }
          yield* Effect.die(
            new Error(
              `IAM role ${output.roleName} remained observable 30 seconds after delete`,
            ),
          );
        }),
      };
    }),
  );
