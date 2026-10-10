import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface CustomVerificationEmailTemplateProps {
  /**
   * Name of the template. May contain letters, numbers, dashes and
   * underscores, up to 64 characters. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID. Changing the name
   * replaces the template.
   */
  templateName?: string;
  /**
   * The verified email address the verification email is sent from. The
   * identity must already be verified for sending.
   */
  fromEmailAddress: string;
  /**
   * The subject line of the verification email.
   */
  templateSubject: string;
  /**
   * The HTML body of the verification email. Must contain a link to the
   * verification URL SES generates.
   */
  templateContent: string;
  /**
   * The URL the recipient is redirected to after successfully verifying.
   */
  successRedirectionURL: string;
  /**
   * The URL the recipient is redirected to if verification fails.
   */
  failureRedirectionURL: string;
  /**
   * Tags to apply to the template. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface CustomVerificationEmailTemplate extends Resource<
  "AWS.SES.CustomVerificationEmailTemplate",
  CustomVerificationEmailTemplateProps,
  {
    /** Name of the template. */
    templateName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 custom verification email template — the branded email SES
 * sends when you verify a new email-address identity via
 * `SendCustomVerificationEmail`.
 *
 * Creating, reading, updating, and deleting the template works on any account.
 * Actually *sending* a custom verification email requires the account to be
 * out of the SES sandbox (production access).
 * ### Creating Templates
 * **Example:** Branded Verification Email
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const template = yield* SES.CustomVerificationEmailTemplate("Verify", {
 *   fromEmailAddress: "verify@example.com",
 *   templateSubject: "Please confirm your email",
 *   templateContent:
 *     "<html><body>Click the link to verify your address.</body></html>",
 *   successRedirectionURL: "https://example.com/verified",
 *   failureRedirectionURL: "https://example.com/verify-failed",
 * });
 * ```
 *
 * **Example:** Explicit Template Name
 * ```typescript
 * // Without templateName a deterministic name is derived from app/stage/id.
 * const template = yield* SES.CustomVerificationEmailTemplate("Verify", {
 *   templateName: "onboarding-verification",
 *   fromEmailAddress: "verify@example.com",
 *   templateSubject: "Please confirm your email",
 *   templateContent:
 *     "<html><body>Click the link to verify your address.</body></html>",
 *   successRedirectionURL: "https://example.com/verified",
 *   failureRedirectionURL: "https://example.com/verify-failed",
 * });
 * ```
 *
 * ### Sending the Verification Email
 * **Example:** Verify a New Address from a Lambda Function
 * ```typescript
 * // init — account-level binding, no resource argument
 * const sendVerification = yield* SES.SendCustomVerificationEmail();
 *
 * // runtime — SES emails the branded template to the address, and the
 * // address becomes a verified identity once the recipient clicks through.
 * const { MessageId } = yield* sendVerification({
 *   EmailAddress: "new-user@example.com",
 *   TemplateName: yield* template.templateName,
 * });
 * ```
 *
 * @resource
 */
export const CustomVerificationEmailTemplate =
  Resource<CustomVerificationEmailTemplate>(
    "AWS.SES.CustomVerificationEmailTemplate",
  );

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

// getCustomVerificationEmailTemplate returns no ARN, so the ARN
// listTagsForResource needs is derived — verified live against SES.
const templateArnOf = (region: string, accountId: string, name: string) =>
  `arn:aws:ses:${region}:${accountId}:custom-verification-email-template/${name}`;

export const CustomVerificationEmailTemplateProvider = () =>
  Provider.effect(
    CustomVerificationEmailTemplate,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<CustomVerificationEmailTemplateProps, "templateName">,
      ) {
        return (
          props.templateName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getTemplate = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getCustomVerificationEmailTemplate({ TemplateName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // The get returns no tags, so ownership costs a second API call. Only
      // `read` pays it — `list` deletes by name.
      const getTemplateTags = Effect.fn(function* (name: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return yield* sesv2
          .listTagsForResource({
            ResourceArn: templateArnOf(region, accountId, name),
          })
          .pipe(
            Effect.map((response) => toTagRecord(response.Tags)),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
      });

      return CustomVerificationEmailTemplate.Provider.of({
        stables: ["templateName"],

        // Account/region-scoped: enumerate every template so leaked test
        // resources are cleaned by nuke. Custom verification email templates
        // carry no ownership signal, so existence is treated as ownership.
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listCustomVerificationEmailTemplates
            .pages({})
            .pipe(Stream.runCollect);
          return Array.from(pages)
            .flatMap((page) => page.CustomVerificationEmailTemplates ?? [])
            .flatMap((meta) =>
              meta.TemplateName ? [{ templateName: meta.TemplateName }] : [],
            );
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.templateName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getTemplate(name);
          if (!found) return undefined;
          // Templates are taggable and reconcile brands the ones it creates,
          // so existence at our deterministic name is not proof of ownership.
          const tags = yield* getTemplateTags(name);
          return (yield* hasAlchemyTags(id, tags))
            ? { templateName: name }
            : Unowned({ templateName: name });
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.templateName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* getTemplate(name);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createCustomVerificationEmailTemplate({
                TemplateName: name,
                FromEmailAddress: news.fromEmailAddress,
                TemplateSubject: news.templateSubject,
                TemplateContent: news.templateContent,
                SuccessRedirectionURL: news.successRedirectionURL,
                FailureRedirectionURL: news.failureRedirectionURL,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateCustomVerificationEmailTemplate({
                    TemplateName: name,
                    FromEmailAddress: news.fromEmailAddress,
                    TemplateSubject: news.templateSubject,
                    TemplateContent: news.templateContent,
                    SuccessRedirectionURL: news.successRedirectionURL,
                    FailureRedirectionURL: news.failureRedirectionURL,
                  }),
                ),
              );
          } else if (
            observed.FromEmailAddress !== news.fromEmailAddress ||
            observed.TemplateSubject !== news.templateSubject ||
            observed.TemplateContent !== news.templateContent ||
            observed.SuccessRedirectionURL !== news.successRedirectionURL ||
            observed.FailureRedirectionURL !== news.failureRedirectionURL
          ) {
            // 3. SYNC — a single full-replace update converges the template.
            yield* sesv2.updateCustomVerificationEmailTemplate({
              TemplateName: name,
              FromEmailAddress: news.fromEmailAddress,
              TemplateSubject: news.templateSubject,
              TemplateContent: news.templateContent,
              SuccessRedirectionURL: news.successRedirectionURL,
              FailureRedirectionURL: news.failureRedirectionURL,
            });
          }

          // 4. SYNC TAGS — diff against OBSERVED cloud tags so an adopted
          //    template gets branded and stops reading as Unowned.
          const observedTags = yield* getTemplateTags(name);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 || removed.length > 0) {
            const { accountId, region } = yield* AWSEnvironment.current;
            const arn = templateArnOf(region, accountId, name);
            if (upsert.length > 0) {
              yield* sesv2.tagResource({ ResourceArn: arn, Tags: upsert });
            }
            if (removed.length > 0) {
              yield* sesv2.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          return { templateName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteCustomVerificationEmailTemplate({
              TemplateName: output.templateName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
