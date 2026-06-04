import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface PolicyAttachmentProps {
  /**
   * Policy to attach.
   */
  policyId: string;
  /**
   * Target root, OU, or account ID.
   */
  targetId: string;
}

export interface PolicyAttachment extends Resource<
  "AWS.Organizations.PolicyAttachment",
  PolicyAttachmentProps,
  {
    policyId: string;
    targetId: string;
    targetArn: string | undefined;
    targetName: string | undefined;
    targetType: organizations.TargetType | undefined;
  },
  never,
  Providers
> {}

/**
 * Attaches an Organizations policy to a root, OU, or account.
 */
export const PolicyAttachment = Resource<PolicyAttachment>(
  "AWS.Organizations.PolicyAttachment",
);

export const PolicyAttachmentProvider = () =>
  Provider.effect(
    PolicyAttachment,
    Effect.gen(function* () {
      return {
        stables: ["policyId", "targetId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.policyId !== news.policyId ||
            olds?.targetId !== news.targetId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readAttachment({
            policyId: output?.policyId ?? olds!.policyId,
            targetId: output?.targetId ?? olds!.targetId,
          });
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Observe — list current attachments to see whether ours is present.
          // The attachment is identity-only; both `policyId` and `targetId`
          // are stable, so `diff` handles any change as a replacement.
          let state = yield* readAttachment(news);

          // Ensure — attach if missing. `DuplicatePolicyAttachmentException`
          // is treated as success (e.g. a peer reconciler attached
          // concurrently, or our observation lost a race).
          if (!state) {
            yield* retryOrganizations(
              organizations
                .attachPolicy({
                  PolicyId: news.policyId,
                  TargetId: news.targetId,
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicatePolicyAttachmentException",
                    () => Effect.void,
                  ),
                ),
            );
            state = yield* readAttachment(news);
            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `policy attachment '${news.policyId}' -> '${news.targetId}' not found after create`,
                ),
              );
            }
          }

          yield* session.note(`${state.policyId}:${state.targetId}`);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .detachPolicy({
                PolicyId: output.policyId,
                TargetId: output.targetId,
              })
              .pipe(
                Effect.catchTags({
                  PolicyNotAttachedException: () => Effect.void,
                  PolicyNotFoundException: () => Effect.void,
                  TargetNotFoundException: () => Effect.void,
                }),
              ),
          );
        }),
      };
    }),
  );

const readAttachment = Effect.fn(function* ({
  policyId,
  targetId,
}: PolicyAttachmentProps) {
  const targets = yield* retryOrganizations(
    collectPages(
      (NextToken) =>
        organizations.listTargetsForPolicy({ PolicyId: policyId, NextToken }),
      (page) => page.Targets,
    ),
  );

  const target = targets.find((candidate) => candidate.TargetId === targetId);
  return target
    ? ({
        policyId,
        targetId,
        targetArn: target.Arn,
        targetName: target.Name,
        targetType: target.Type,
      } satisfies PolicyAttachment["Attributes"])
    : undefined;
});
