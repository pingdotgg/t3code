import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
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
import { toTagRecord } from "./common.ts";

export interface InstanceProfileProps {
  /**
   * Name of the instance profile. If omitted, a deterministic name is generated.
   */
  instanceProfileName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * Optional role attached to the instance profile.
   */
  roleName?: Input<string>;
  /**
   * User-defined tags to apply to the instance profile.
   */
  tags?: Record<string, string>;
}

export interface InstanceProfile extends Resource<
  "AWS.IAM.InstanceProfile",
  InstanceProfileProps,
  {
    instanceProfileArn: string;
    instanceProfileName: string;
    instanceProfileId: string | undefined;
    path: string | undefined;
    roleName: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IAM instance profile that can present a role to EC2 instances.
 *
 * `InstanceProfile` bridges IAM roles into EC2 so compute instances can assume
 * the attached role through the instance metadata service.
 *
 * @section Attaching Roles to EC2
 * @example Create an Instance Profile
 * ```typescript
 * const role = yield* Role("InstanceRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "ec2.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 *
 * const profile = yield* InstanceProfile("WebProfile", {
 *   roleName: role.roleName,
 * });
 * ```
 */
export const InstanceProfile = Resource<InstanceProfile>(
  "AWS.IAM.InstanceProfile",
);

export const InstanceProfileProvider = () =>
  Provider.effect(
    InstanceProfile,
    Effect.gen(function* () {
      const toName = (id: string, props: InstanceProfileProps) =>
        props.instanceProfileName
          ? Effect.succeed(props.instanceProfileName)
          : createPhysicalName({ id, maxLength: 128 });

      const readInstanceProfile = Effect.fn(function* (name: string) {
        const response = yield* iam
          .getInstanceProfile({
            InstanceProfileName: name,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.InstanceProfile;
      });

      const syncRole = Effect.fn(function* ({
        profileName,
        currentRoleName,
        nextRoleName,
      }: {
        profileName: string;
        currentRoleName: string | undefined;
        nextRoleName: string | undefined;
      }) {
        if (currentRoleName && currentRoleName !== nextRoleName) {
          yield* iam
            .removeRoleFromInstanceProfile({
              InstanceProfileName: profileName,
              RoleName: currentRoleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
        if (nextRoleName && currentRoleName !== nextRoleName) {
          yield* iam.addRoleToInstanceProfile({
            InstanceProfileName: profileName,
            RoleName: nextRoleName,
          });
        }
      });

      return {
        stables: [
          "instanceProfileArn",
          "instanceProfileName",
          "instanceProfileId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as InstanceProfileProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.instanceProfileName ??
            (yield* toName(id, olds ?? ({} as InstanceProfileProps)));
          const profile = yield* readInstanceProfile(name);
          if (!profile?.Arn || !profile.InstanceProfileName) {
            return undefined;
          }
          return {
            instanceProfileArn: profile.Arn,
            instanceProfileName: profile.InstanceProfileName,
            instanceProfileId: profile.InstanceProfileId,
            path: profile.Path,
            roleName: profile.Roles?.[0]?.RoleName,
            tags: toTagRecord(profile.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.instanceProfileName ?? (yield* toName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — fetch the live instance profile (or absence).
          let profile = yield* readInstanceProfile(name);

          // Ensure — create the profile when it is missing. Tolerate races
          // and surface a clear error when an unrelated foreign profile
          // already owns the name.
          if (!profile?.Arn) {
            yield* iam
              .createInstanceProfile({
                InstanceProfileName: name,
                Path: news.path,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  Effect.gen(function* () {
                    const existing = yield* readInstanceProfile(name);
                    if (!existing?.Arn) {
                      return yield* Effect.fail(
                        new Error(
                          `Instance profile '${name}' already exists but could not be described`,
                        ),
                      );
                    }
                    if (!hasTags(desiredTags, existing.Tags)) {
                      return yield* Effect.fail(
                        new Error(
                          `Instance profile '${name}' already exists and is not managed by alchemy`,
                        ),
                      );
                    }
                  }),
                ),
              );
            profile = yield* readInstanceProfile(name);
            if (!profile?.Arn || !profile.InstanceProfileName) {
              return yield* Effect.fail(
                new Error(
                  `Instance profile '${name}' was not readable after create`,
                ),
              );
            }
          }

          // Sync role attachment — diff the observed role on the profile
          // against the desired role and only swap when they differ.
          const observedRoleName = profile.Roles?.[0]?.RoleName;
          const desiredRoleName = news.roleName as string | undefined;
          yield* syncRole({
            profileName: name,
            currentRoleName: observedRoleName,
            nextRoleName: desiredRoleName,
          });

          // Sync tags — use the cloud's actual tags as the baseline so
          // adoption / out-of-band tag changes converge correctly.
          const observedTags = toTagRecord(profile.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagInstanceProfile({
              InstanceProfileName: name,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagInstanceProfile({
              InstanceProfileName: name,
              TagKeys: removed,
            });
          }

          // Re-read for fresh attributes (the profile's `Roles` array
          // changes after `syncRole`).
          const fresh = yield* readInstanceProfile(name);
          if (!fresh?.Arn || !fresh.InstanceProfileName) {
            return yield* Effect.fail(
              new Error(
                `Instance profile '${name}' was not readable after sync`,
              ),
            );
          }

          yield* session.note(fresh.Arn);
          return {
            instanceProfileArn: fresh.Arn,
            instanceProfileName: fresh.InstanceProfileName,
            instanceProfileId: fresh.InstanceProfileId,
            path: fresh.Path,
            roleName: fresh.Roles?.[0]?.RoleName,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const profile = yield* readInstanceProfile(
            output.instanceProfileName,
          );
          for (const role of profile?.Roles ?? []) {
            if (role.RoleName) {
              yield* iam
                .removeRoleFromInstanceProfile({
                  InstanceProfileName: output.instanceProfileName,
                  RoleName: role.RoleName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }
          yield* iam
            .deleteInstanceProfile({
              InstanceProfileName: output.instanceProfileName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
