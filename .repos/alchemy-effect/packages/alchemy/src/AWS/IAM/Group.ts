import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { PolicyDocument } from "./Policy.ts";
import { parsePolicyDocument, stringifyPolicyDocument } from "./common.ts";

export interface GroupProps {
  /**
   * Group name. If omitted, a deterministic name is generated.
   */
  groupName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * Managed policy ARNs attached to the group.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies embedded in the group.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
}

export interface Group extends Resource<
  "AWS.IAM.Group",
  GroupProps,
  {
    groupArn: string;
    groupName: string;
    groupId: string | undefined;
    path: string | undefined;
    managedPolicyArns: string[];
    inlinePolicies: Record<string, PolicyDocument>;
  },
  never,
  Providers
> {}

/**
 * An IAM group that can own managed and inline policies.
 *
 * `Group` manages a shared authorization container for IAM users, including
 * attached managed policies and embedded inline policies.
 *
 * @section Creating IAM Groups
 * @example Group with an Inline Policy
 * ```typescript
 * const group = yield* Group("SupportGroup", {
 *   groupName: "support",
 *   inlinePolicies: {
 *     SupportReadOnly: {
 *       Version: "2012-10-17",
 *       Statement: [{
 *         Effect: "Allow",
 *         Action: ["cloudwatch:Get*", "cloudwatch:List*"],
 *         Resource: ["*"],
 *       }],
 *     },
 *   },
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.IAM.Group");

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      const toName = (id: string, props: GroupProps) =>
        props.groupName
          ? Effect.succeed(props.groupName)
          : createPhysicalName({ id, maxLength: 128 });

      const readInlinePolicies = Effect.fn(function* (groupName: string) {
        const listed = yield* iam.listGroupPolicies({
          GroupName: groupName,
        });
        const entries = yield* Effect.all(
          (listed.PolicyNames ?? []).map((policyName) =>
            iam
              .getGroupPolicy({
                GroupName: groupName,
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

      const readManagedPolicies = Effect.fn(function* (groupName: string) {
        const listed = yield* iam.listAttachedGroupPolicies({
          GroupName: groupName,
        });
        return (listed.AttachedPolicies ?? [])
          .map((policy) => policy.PolicyArn)
          .filter(
            (policyArn): policyArn is string => typeof policyArn === "string",
          );
      });

      const syncManagedPolicies = Effect.fn(function* ({
        groupName,
        olds,
        news,
      }: {
        groupName: string;
        olds: string[];
        news: string[];
      }) {
        const oldSet = new Set(olds);
        const newSet = new Set(news);
        for (const policyArn of news) {
          if (!oldSet.has(policyArn)) {
            yield* iam.attachGroupPolicy({
              GroupName: groupName,
              PolicyArn: policyArn,
            });
          }
        }
        for (const policyArn of olds) {
          if (!newSet.has(policyArn)) {
            yield* iam
              .detachGroupPolicy({
                GroupName: groupName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      const syncInlinePolicies = Effect.fn(function* ({
        groupName,
        olds,
        news,
      }: {
        groupName: string;
        olds: Record<string, PolicyDocument>;
        news: Record<string, PolicyDocument>;
      }) {
        for (const [policyName, document] of Object.entries(news)) {
          if (
            JSON.stringify(olds[policyName] ?? null) !==
            JSON.stringify(document)
          ) {
            yield* iam.putGroupPolicy({
              GroupName: groupName,
              PolicyName: policyName,
              PolicyDocument: stringifyPolicyDocument(document),
            });
          }
        }
        for (const policyName of Object.keys(olds)) {
          if (!(policyName in news)) {
            yield* iam
              .deleteGroupPolicy({
                GroupName: groupName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      return {
        stables: ["groupArn", "groupName", "groupId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as GroupProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const groupName =
            output?.groupName ??
            (yield* toName(id, olds ?? ({} as GroupProps)));
          const response = yield* iam
            .getGroup({
              GroupName: groupName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!response?.Group?.Arn) {
            return undefined;
          }
          const [managedPolicyArns, inlinePolicies] = yield* Effect.all([
            readManagedPolicies(groupName),
            readInlinePolicies(groupName),
          ]);
          return {
            groupArn: response.Group.Arn,
            groupName: response.Group.GroupName,
            groupId: response.Group.GroupId,
            path: response.Group.Path,
            managedPolicyArns,
            inlinePolicies,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const groupName = output?.groupName ?? (yield* toName(id, news));

          // Observe — fetch the live group. `getGroup` returns
          // `NoSuchEntityException` when the group has not been created or
          // was deleted out-of-band, in which case we fall through to the
          // ensure step below.
          let observed = yield* iam
            .getGroup({ GroupName: groupName })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the group when it is missing. A concurrent
          // peer reconciler may win the race, so tolerate
          // `EntityAlreadyExistsException` and reload.
          if (!observed?.Group?.Arn) {
            observed = yield* iam
              .createGroup({
                GroupName: groupName,
                Path: news.path,
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  iam.getGroup({ GroupName: groupName }),
                ),
                Effect.map((response) => ({
                  Group: response.Group,
                  Users: [],
                  IsTruncated: false,
                })),
              );
          }

          // Sync — for each mutable aspect, diff observed against desired
          // and apply only the delta. We trust the cloud as the source of
          // truth instead of relying on `olds`.
          const [observedManagedPolicies, observedInlinePolicies] =
            yield* Effect.all([
              readManagedPolicies(groupName),
              readInlinePolicies(groupName),
            ]);

          yield* syncManagedPolicies({
            groupName,
            olds: observedManagedPolicies,
            news: news.managedPolicyArns ?? [],
          });
          yield* syncInlinePolicies({
            groupName,
            olds: observedInlinePolicies,
            news: news.inlinePolicies ?? {},
          });

          const groupArn = observed.Group?.Arn ?? groupName;
          yield* session.note(groupArn);
          return {
            groupArn,
            groupName,
            groupId: observed.Group?.GroupId,
            path: observed.Group?.Path ?? news.path ?? "/",
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies: news.inlinePolicies ?? {},
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const groupState = yield* iam
            .getGroup({
              GroupName: output.groupName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const user of groupState?.Users ?? []) {
            if (user.UserName) {
              yield* iam
                .removeUserFromGroup({
                  GroupName: output.groupName,
                  UserName: user.UserName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }
          const inlinePolicies = yield* iam
            .listGroupPolicies({
              GroupName: output.groupName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const policyName of inlinePolicies?.PolicyNames ?? []) {
            yield* iam
              .deleteGroupPolicy({
                GroupName: output.groupName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
          const attachedPolicies = yield* iam
            .listAttachedGroupPolicies({
              GroupName: output.groupName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const policy of attachedPolicies?.AttachedPolicies ?? []) {
            if (policy.PolicyArn) {
              yield* iam
                .detachGroupPolicy({
                  GroupName: output.groupName,
                  PolicyArn: policy.PolicyArn,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }
          yield* iam
            .deleteGroup({
              GroupName: output.groupName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
