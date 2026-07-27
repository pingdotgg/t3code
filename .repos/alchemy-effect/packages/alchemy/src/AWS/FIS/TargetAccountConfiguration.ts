import * as fis from "@distilled.cloud/aws/fis";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TargetAccountConfigurationProps {
  /**
   * The ID of the experiment template the target account belongs to. The
   * template must use `accountTargeting: "multi-account"`. Changing it
   * replaces the configuration.
   */
  experimentTemplateId: string;
  /**
   * The AWS account ID of the target account. Changing it replaces the
   * configuration.
   */
  accountId: string;
  /**
   * The ARN of an IAM role in the target account that grants FIS permission
   * to perform the experiment's actions there. The role must trust
   * `fis.amazonaws.com`.
   */
  roleArn: string;
  /**
   * A description of the target account. Once set, it cannot be fully
   * removed via the API — only changed.
   */
  description?: string;
}

export interface TargetAccountConfiguration extends Resource<
  "AWS.FIS.TargetAccountConfiguration",
  TargetAccountConfigurationProps,
  {
    /**
     * The ID of the experiment template the target account belongs to.
     */
    experimentTemplateId: string;
    /**
     * The AWS account ID of the target account.
     */
    accountId: string;
    /**
     * The ARN of the IAM role FIS assumes in the target account.
     */
    roleArn: string;
  },
  never,
  Providers
> {}

/**
 * A target account configuration for a multi-account AWS Fault Injection
 * Service (FIS) experiment template — registers an AWS account (and the IAM
 * role FIS assumes there) as a target of the experiment, so a single
 * experiment can inject faults into resources across accounts.
 *
 * The parent {@link ExperimentTemplate} must declare
 * `experimentOptions: { accountTargeting: "multi-account" }`.
 * @resource
 * @section Registering Target Accounts
 * @example Add a Target Account to a Multi-Account Template
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const template = yield* AWS.FIS.ExperimentTemplate("CrossAccount", {
 *   roleArn: orchestratorRole.roleArn,
 *   experimentOptions: { accountTargeting: "multi-account" },
 *   actions: {
 *     Wait: { actionId: "aws:fis:wait", parameters: { duration: "PT1M" } },
 *   },
 * });
 *
 * const target = yield* AWS.FIS.TargetAccountConfiguration("WorkloadAccount", {
 *   experimentTemplateId: template.id,
 *   accountId: "111122223333",
 *   roleArn: "arn:aws:iam::111122223333:role/FisTargetRole",
 *   description: "the workload account faults are injected into",
 * });
 * ```
 */
export const TargetAccountConfiguration = Resource<TargetAccountConfiguration>(
  "AWS.FIS.TargetAccountConfiguration",
);

export const TargetAccountConfigurationProvider = () =>
  Provider.effect(
    TargetAccountConfiguration,
    Effect.gen(function* () {
      // A missing template and a missing configuration both surface as
      // ResourceNotFoundException — either way the configuration does not
      // exist.
      const observe = (experimentTemplateId: string, accountId: string) =>
        fis
          .getTargetAccountConfiguration({ experimentTemplateId, accountId })
          .pipe(
            Effect.map((r) => r.targetAccountConfiguration),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttrs = (
        experimentTemplateId: string,
        config: fis.TargetAccountConfiguration,
      ) => ({
        experimentTemplateId,
        accountId: config.accountId!,
        roleArn: config.roleArn!,
      });

      return TargetAccountConfiguration.Provider.of({
        stables: ["experimentTemplateId", "accountId"],

        // The (template, account) pair IS the configuration's identity —
        // changing either side replaces it. roleArn/description sync in
        // place.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.experimentTemplateId !== news.experimentTemplateId ||
              olds.accountId !== news.accountId)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const experimentTemplateId =
            output?.experimentTemplateId ?? olds?.experimentTemplateId;
          const accountId = output?.accountId ?? olds?.accountId;
          if (experimentTemplateId === undefined || accountId === undefined) {
            return undefined;
          }
          const config = yield* observe(experimentTemplateId, accountId);
          if (config === undefined) return undefined;
          // Target account configurations cannot carry tags; existence under
          // the parent template is the ownership signal.
          return toAttrs(experimentTemplateId, config);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. Observe — the (template, account) pair is the deterministic
          // identity; cloud state is authoritative.
          let observed = yield* observe(
            news.experimentTemplateId,
            news.accountId,
          );

          if (observed === undefined) {
            // 2. Ensure — create when missing; a concurrent create race
            // surfaces as ConflictException and falls through to observe.
            observed = yield* fis
              .createTargetAccountConfiguration({
                experimentTemplateId: news.experimentTemplateId,
                accountId: news.accountId,
                roleArn: news.roleArn,
                description: news.description,
              })
              .pipe(
                Effect.map((r) => r.targetAccountConfiguration),
                Effect.catchTag("ConflictException", () =>
                  observe(news.experimentTemplateId, news.accountId),
                ),
              );
          } else if (
            // 3. Sync — diff observed against desired and apply the single
            // update on any delta. `description` is settable-but-not-removable,
            // so it only participates while declared.
            observed.roleArn !== news.roleArn ||
            (news.description !== undefined &&
              observed.description !== news.description)
          ) {
            observed = yield* fis
              .updateTargetAccountConfiguration({
                experimentTemplateId: news.experimentTemplateId,
                accountId: news.accountId,
                roleArn: news.roleArn,
                description: news.description,
              })
              .pipe(Effect.map((r) => r.targetAccountConfiguration));
          }

          yield* session.note(`${news.experimentTemplateId}/${news.accountId}`);
          return toAttrs(news.experimentTemplateId, observed!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* fis
            .deleteTargetAccountConfiguration({
              experimentTemplateId: output.experimentTemplateId,
              accountId: output.accountId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Enumerate every template's target account configurations.
        // Single-account templates simply have none.
        list: () =>
          Effect.gen(function* () {
            const templates = yield* fis.listExperimentTemplates.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const results: TargetAccountConfiguration["Attributes"][] = [];
            for (const template of templates) {
              if (template.id === undefined) continue;
              const configs = yield* fis.listTargetAccountConfigurations
                .items({ experimentTemplateId: template.id })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) => Array.from(chunk)),
                  // A template can vanish between enumeration and listing.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([]),
                  ),
                );
              for (const config of configs) {
                if (
                  config.accountId === undefined ||
                  config.roleArn === undefined
                ) {
                  continue;
                }
                results.push({
                  experimentTemplateId: template.id,
                  accountId: config.accountId,
                  roleArn: config.roleArn,
                });
              }
            }
            return results;
          }),
      });
    }),
  );
