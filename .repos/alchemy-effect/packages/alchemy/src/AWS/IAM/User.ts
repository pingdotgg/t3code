import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import type { PolicyDocument } from "./Policy.ts";
import {
  parsePolicyDocument,
  stringifyPolicyDocument,
  toTagRecord,
} from "./common.ts";

export interface UserProps {
  /**
   * User name. If omitted, a deterministic name is generated.
   */
  userName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * Optional permissions boundary policy ARN.
   */
  permissionsBoundary?: string;
  /**
   * Managed policy ARNs attached to the user.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies embedded in the user.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
  /**
   * User-defined tags to apply to the user.
   */
  tags?: Record<string, string>;
}

export interface User extends Resource<
  "AWS.IAM.User",
  UserProps,
  {
    userArn: string;
    userName: string;
    userId: string | undefined;
    path: string | undefined;
    permissionsBoundary: string | undefined;
    managedPolicyArns: string[];
    inlinePolicies: Record<string, PolicyDocument>;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM user with optional inline policies, managed policies, and tags.
 *
 * `User` manages a long-lived IAM identity together with its attached managed
 * policies, inline policies, permissions boundary, and tags.
 *
 * @section Creating IAM Users
 * @example User with Managed Policies
 * ```typescript
 * const user = yield* User("AppUser", {
 *   userName: "app-user",
 *   managedPolicyArns: [
 *     "arn:aws:iam::aws:policy/ReadOnlyAccess",
 *   ],
 * });
 * ```
 */
export const User = Resource<User>("AWS.IAM.User");

export const UserProvider = () =>
  Provider.effect(
    User,
    Effect.gen(function* () {
      const toName = (id: string, props: UserProps) =>
        props.userName
          ? Effect.succeed(props.userName)
          : createPhysicalName({ id, maxLength: 64 });

      const readManagedPolicies = Effect.fn(function* (userName: string) {
        const listed = yield* iam.listAttachedUserPolicies({
          UserName: userName,
        });
        return (listed.AttachedPolicies ?? [])
          .map((policy) => policy.PolicyArn)
          .filter(
            (policyArn): policyArn is string => typeof policyArn === "string",
          );
      });

      const readInlinePolicies = Effect.fn(function* (userName: string) {
        const listed = yield* iam.listUserPolicies({
          UserName: userName,
        });
        const entries = yield* Effect.all(
          (listed.PolicyNames ?? []).map((policyName) =>
            iam
              .getUserPolicy({
                UserName: userName,
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

      const readTags = Effect.fn(function* (userName: string) {
        const listed = yield* iam.listUserTags({
          UserName: userName,
        });
        return toTagRecord(listed.Tags);
      });

      const syncManagedPolicies = Effect.fn(function* ({
        userName,
        olds,
        news,
      }: {
        userName: string;
        olds: string[];
        news: string[];
      }) {
        const oldSet = new Set(olds);
        const newSet = new Set(news);
        for (const policyArn of news) {
          if (!oldSet.has(policyArn)) {
            yield* iam.attachUserPolicy({
              UserName: userName,
              PolicyArn: policyArn,
            });
          }
        }
        for (const policyArn of olds) {
          if (!newSet.has(policyArn)) {
            yield* iam
              .detachUserPolicy({
                UserName: userName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      const syncInlinePolicies = Effect.fn(function* ({
        userName,
        olds,
        news,
      }: {
        userName: string;
        olds: Record<string, PolicyDocument>;
        news: Record<string, PolicyDocument>;
      }) {
        for (const [policyName, document] of Object.entries(news)) {
          if (
            JSON.stringify(olds[policyName] ?? null) !==
            JSON.stringify(document)
          ) {
            yield* iam.putUserPolicy({
              UserName: userName,
              PolicyName: policyName,
              PolicyDocument: stringifyPolicyDocument(document),
            });
          }
        }
        for (const policyName of Object.keys(olds)) {
          if (!(policyName in news)) {
            yield* iam
              .deleteUserPolicy({
                UserName: userName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      return {
        stables: ["userArn", "userName", "userId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as UserProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const userName =
            output?.userName ?? (yield* toName(id, olds ?? ({} as UserProps)));
          const response = yield* iam
            .getUser({
              UserName: userName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!response?.User?.Arn) {
            return undefined;
          }
          const [managedPolicyArns, inlinePolicies, tags] = yield* Effect.all([
            readManagedPolicies(userName),
            readInlinePolicies(userName),
            readTags(userName),
          ]);
          return {
            userArn: response.User.Arn,
            userName: response.User.UserName,
            userId: response.User.UserId,
            path: response.User.Path,
            permissionsBoundary:
              response.User.PermissionsBoundary?.PermissionsBoundaryArn,
            managedPolicyArns,
            inlinePolicies,
            tags,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const userName = output?.userName ?? (yield* toName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — read the live user (or absence).
          const observedResponse = yield* iam
            .getUser({ UserName: userName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          let observedUser = observedResponse?.User;

          // Ensure — create the user when missing. On race, verify
          // ownership tags before adopting.
          if (!observedUser?.Arn) {
            const created = yield* iam
              .createUser({
                UserName: userName,
                Path: news.path,
                PermissionsBoundary: news.permissionsBoundary,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  iam.getUser({ UserName: userName }).pipe(
                    Effect.filterOrFail(
                      (existing) => hasTags(desiredTags, existing.User?.Tags),
                      () =>
                        new Error(
                          `User '${userName}' already exists and is not managed by alchemy`,
                        ),
                    ),
                  ),
                ),
              );
            observedUser = created.User;
          }

          // Sync permissions boundary against observed.
          const observedBoundary =
            observedUser?.PermissionsBoundary?.PermissionsBoundaryArn;
          if (news.permissionsBoundary !== observedBoundary) {
            if (news.permissionsBoundary) {
              yield* iam.putUserPermissionsBoundary({
                UserName: userName,
                PermissionsBoundary: news.permissionsBoundary,
              });
            } else if (observedBoundary) {
              yield* iam
                .deleteUserPermissionsBoundary({
                  UserName: userName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }

          // Sync managed and inline policies — observe live state and
          // apply only the delta.
          const [observedManagedPolicies, observedInlinePolicies] =
            yield* Effect.all([
              readManagedPolicies(userName),
              readInlinePolicies(userName),
            ]);
          yield* syncManagedPolicies({
            userName,
            olds: observedManagedPolicies,
            news: news.managedPolicyArns ?? [],
          });
          yield* syncInlinePolicies({
            userName,
            olds: observedInlinePolicies,
            news: news.inlinePolicies ?? {},
          });

          // Sync tags against the cloud's actual tags.
          const observedTags = yield* readTags(userName);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagUser({
              UserName: userName,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagUser({
              UserName: userName,
              TagKeys: removed,
            });
          }

          // Re-read for fresh attributes after all mutations.
          const user = yield* iam.getUser({ UserName: userName });
          const userArn = user.User?.Arn ?? observedUser?.Arn ?? userName;

          yield* session.note(userArn);
          return {
            userArn,
            userName: user.User?.UserName ?? userName,
            userId: user.User?.UserId ?? observedUser?.UserId,
            path: user.User?.Path ?? observedUser?.Path ?? news.path ?? "/",
            permissionsBoundary:
              user.User?.PermissionsBoundary?.PermissionsBoundaryArn ??
              news.permissionsBoundary,
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies: news.inlinePolicies ?? {},
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteUserPermissionsBoundary({
              UserName: output.userName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

          const inlinePolicies = yield* iam
            .listUserPolicies({
              UserName: output.userName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const policyName of inlinePolicies?.PolicyNames ?? []) {
            yield* iam
              .deleteUserPolicy({
                UserName: output.userName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }

          const attachedPolicies = yield* iam
            .listAttachedUserPolicies({
              UserName: output.userName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const policy of attachedPolicies?.AttachedPolicies ?? []) {
            if (policy.PolicyArn) {
              yield* iam
                .detachUserPolicy({
                  UserName: output.userName,
                  PolicyArn: policy.PolicyArn,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }

          yield* iam
            .deleteUser({
              UserName: output.userName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
