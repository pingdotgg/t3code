import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  oldestNondefaultPolicyVersion,
  parsePolicyDocument,
  policyArnFromParts,
  stringifyPolicyDocument,
  toTagRecord,
} from "./common.ts";

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

export interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Sid?: string;
  Action: string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
  Principal?: Record<string, string | string[]>;
  NotPrincipal?: Record<string, string | string[]>;
  NotAction?: string[];
  NotResource?: string[];
}

export type PolicyName = string;
export type PolicyArn = `arn:aws:iam::${AccountID}:policy/${string}`;

export interface PolicyProps {
  /**
   * Name of the managed policy. If omitted, a deterministic name is generated.
   */
  policyName?: string;
  /**
   * Optional IAM path prefix for the policy.
   * @default "/"
   */
  path?: string;
  /**
   * The JSON IAM policy document.
   */
  policyDocument: PolicyDocument;
  /**
   * Optional description for the policy.
   */
  description?: string;
  /**
   * User-defined tags to apply to the managed policy.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "AWS.IAM.Policy",
  PolicyProps,
  {
    policyArn: PolicyArn;
    policyName: PolicyName;
    policyId: string | undefined;
    path: string | undefined;
    defaultVersionId: string | undefined;
    attachmentCount: number | undefined;
    permissionsBoundaryUsageCount: number | undefined;
    isAttachable: boolean | undefined;
    description: string | undefined;
    policyDocument: PolicyDocument;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A customer-managed IAM policy.
 *
 * `Policy` owns the lifecycle of the policy metadata and its default version,
 * rotating versions on updates while keeping the current document attached to a
 * stable policy ARN.
 *
 * @section Creating Policies
 * @example Managed Policy
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
 * ```
 */
export const Policy = Resource<Policy>("AWS.IAM.Policy");

export const PolicyProvider = () =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment;

      const toPolicyName = (id: string, props: PolicyProps) =>
        props.policyName
          ? Effect.succeed(props.policyName)
          : createPhysicalName({ id, maxLength: 128 });

      const toPolicyArn = Effect.fn(function* (id: string, props: PolicyProps) {
        const policyName = yield* toPolicyName(id, props);
        return policyArnFromParts({
          accountId,
          path: props.path,
          policyName,
        }) as PolicyArn;
      });

      const readPolicy = Effect.fn(function* (policyArn: string) {
        const response = yield* iam
          .getPolicy({ PolicyArn: policyArn })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Policy;
      });

      const readPolicyDocument = Effect.fn(function* ({
        policyArn,
        versionId,
      }: {
        policyArn: string;
        versionId: string | undefined;
      }) {
        if (!versionId) {
          return undefined;
        }
        const response = yield* iam
          .getPolicyVersion({
            PolicyArn: policyArn,
            VersionId: versionId,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return parsePolicyDocument(response?.PolicyVersion?.Document);
      });

      const prunePolicyVersions = Effect.fn(function* (policyArn: string) {
        const versions = yield* iam.listPolicyVersions({
          PolicyArn: policyArn,
        });
        if ((versions.Versions?.length ?? 0) < 5) {
          return;
        }
        const removable = oldestNondefaultPolicyVersion(versions.Versions);
        if (!removable?.VersionId) {
          return;
        }
        yield* iam.deletePolicyVersion({
          PolicyArn: policyArn,
          VersionId: removable.VersionId,
        });
      });

      return {
        stables: ["policyArn", "policyName", "policyId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toPolicyName(id, olds ?? ({} as PolicyProps))) !==
            (yield* toPolicyName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.description ?? undefined) !== (news.description ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const policyArn =
            output?.policyArn ??
            (yield* toPolicyArn(id, olds ?? ({} as PolicyProps)));
          const policy = yield* readPolicy(policyArn);
          if (!policy?.Arn || !policy.PolicyName) {
            return undefined;
          }

          const tags = yield* iam.listPolicyTags({
            PolicyArn: policy.Arn,
          });
          const policyDocument = yield* readPolicyDocument({
            policyArn: policy.Arn,
            versionId: policy.DefaultVersionId,
          });

          if (!policyDocument) {
            return undefined;
          }

          return {
            policyArn: policy.Arn as PolicyArn,
            policyName: policy.PolicyName,
            policyId: policy.PolicyId,
            path: policy.Path,
            defaultVersionId: policy.DefaultVersionId,
            attachmentCount: policy.AttachmentCount,
            permissionsBoundaryUsageCount: policy.PermissionsBoundaryUsageCount,
            isAttachable: policy.IsAttachable,
            description: policy.Description,
            policyDocument,
            tags: toTagRecord(tags.Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const policyName =
            output?.policyName ?? (yield* toPolicyName(id, news));
          const policyArn = output?.policyArn ?? (yield* toPolicyArn(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — fetch the policy metadata, current default-version
          // document, and tags. Each piece feeds an independent sync step.
          let observed = yield* readPolicy(policyArn);

          // Ensure — create the managed policy when it is missing. We
          // pass the desired document as the initial version so first
          // create lands fully configured. On race, adopt by reading
          // existing.
          if (!observed?.Arn) {
            const created = yield* iam
              .createPolicy({
                PolicyName: policyName,
                Path: news.path,
                PolicyDocument: stringifyPolicyDocument(news.policyDocument),
                Description: news.description,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("EntityAlreadyExistsException", () =>
                  Effect.gen(function* () {
                    const existing = yield* readPolicy(policyArn);
                    if (!existing?.Arn) {
                      return yield* Effect.fail(
                        new Error(
                          `Policy '${policyName}' already exists but could not be described`,
                        ),
                      );
                    }
                    const existingTags = yield* iam.listPolicyTags({
                      PolicyArn: existing.Arn,
                    });
                    if (!hasTags(desiredTags, existingTags.Tags)) {
                      return yield* Effect.fail(
                        new Error(
                          `Policy '${policyName}' already exists and is not managed by alchemy`,
                        ),
                      );
                    }
                    return { Policy: existing };
                  }),
                ),
              );
            observed = created.Policy;
          }

          // Sync default-version document — IAM managed policies are
          // immutable per version, so any document change requires
          // creating a new default version (and pruning the oldest non-
          // default if we're at the 5-version cap).
          const observedDocument = yield* readPolicyDocument({
            policyArn,
            versionId: observed?.DefaultVersionId,
          });
          if (
            JSON.stringify(observedDocument ?? null) !==
            JSON.stringify(news.policyDocument)
          ) {
            yield* prunePolicyVersions(policyArn);
            const createdVersion = yield* iam.createPolicyVersion({
              PolicyArn: policyArn,
              PolicyDocument: stringifyPolicyDocument(news.policyDocument),
              SetAsDefault: true,
            });
            if (createdVersion.PolicyVersion?.VersionId) {
              yield* iam.setDefaultPolicyVersion({
                PolicyArn: policyArn,
                VersionId: createdVersion.PolicyVersion.VersionId,
              });
            }
          }

          // Sync tags against the cloud's actual tags so adoption /
          // out-of-band tag changes converge.
          const observedTagsResp = yield* iam.listPolicyTags({
            PolicyArn: policyArn,
          });
          const observedTags = toTagRecord(observedTagsResp.Tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* iam.tagPolicy({
              PolicyArn: policyArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagPolicy({
              PolicyArn: policyArn,
              TagKeys: removed,
            });
          }

          // Re-read for fresh metadata and the now-current document.
          const fresh = yield* readPolicy(policyArn);
          const freshDocument =
            (yield* readPolicyDocument({
              policyArn,
              versionId: fresh?.DefaultVersionId,
            })) ?? news.policyDocument;

          yield* session.note(policyArn);
          return {
            policyArn,
            policyName,
            policyId: fresh?.PolicyId ?? observed?.PolicyId,
            path: fresh?.Path ?? observed?.Path ?? news.path ?? "/",
            defaultVersionId:
              fresh?.DefaultVersionId ?? observed?.DefaultVersionId,
            attachmentCount:
              fresh?.AttachmentCount ?? observed?.AttachmentCount,
            permissionsBoundaryUsageCount:
              fresh?.PermissionsBoundaryUsageCount ??
              observed?.PermissionsBoundaryUsageCount,
            isAttachable: fresh?.IsAttachable ?? observed?.IsAttachable,
            description:
              fresh?.Description ?? observed?.Description ?? news.description,
            policyDocument: freshDocument,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const versions = yield* iam
            .listPolicyVersions({
              PolicyArn: output.policyArn,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          for (const version of versions?.Versions ?? []) {
            if (!version.IsDefaultVersion && version.VersionId) {
              yield* iam
                .deletePolicyVersion({
                  PolicyArn: output.policyArn,
                  VersionId: version.VersionId,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }
          yield* iam
            .deletePolicy({
              PolicyArn: output.policyArn,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
