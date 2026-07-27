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

export interface EmailTemplateProps {
  /**
   * The name of the template. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Changing the name
   * replaces the template.
   */
  templateName?: string;
  /**
   * The subject line, with optional `{{variable}}` personalization tags.
   */
  subject?: string;
  /**
   * The plain-text body, with optional `{{variable}}` personalization tags.
   */
  text?: string;
  /**
   * The HTML body, with optional `{{variable}}` personalization tags.
   */
  html?: string;
  /**
   * Tags to apply to the template. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EmailTemplate extends Resource<
  "AWS.SES.EmailTemplate",
  EmailTemplateProps,
  {
    templateName: string;
    templateArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 email template — reusable subject/text/HTML content with
 * `{{variable}}` personalization tags, rendered server-side when you send
 * templated email.
 * @resource
 * @section Creating Templates
 * @example Welcome Email Template
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const template = yield* SES.EmailTemplate("Welcome", {
 *   subject: "Welcome, {{name}}!",
 *   text: "Hi {{name}}, thanks for signing up.",
 *   html: "<h1>Hi {{name}}</h1><p>Thanks for signing up.</p>",
 * });
 * ```
 *
 * @section Sending Templated Email
 * @example Send with Template Data
 * ```typescript
 * const sendEmail = yield* SES.SendEmail(identity);
 *
 * const result = yield* sendEmail({
 *   Destination: { ToAddresses: ["customer@example.com"] },
 *   Content: {
 *     Template: {
 *       TemplateName: "my-welcome-template",
 *       TemplateData: JSON.stringify({ name: "Ada" }),
 *     },
 *   },
 * });
 * ```
 */
export const EmailTemplate = Resource<EmailTemplate>("AWS.SES.EmailTemplate");

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const templateArnOf = (region: string, accountId: string, name: string) =>
  `arn:aws:ses:${region}:${accountId}:template/${name}`;

const toContent = (props: EmailTemplateProps): sesv2.EmailTemplateContent => ({
  Subject: props.subject,
  Text: props.text,
  Html: props.html,
});

export const EmailTemplateProvider = () =>
  Provider.effect(
    EmailTemplate,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<EmailTemplateProps, "templateName">,
      ) {
        return (
          props.templateName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getTemplate = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getEmailTemplate({ TemplateName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return EmailTemplate.Provider.of({
        stables: ["templateName", "templateArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* sesv2.listEmailTemplates
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.TemplatesMetadata ?? [])
              .filter(
                (meta): meta is typeof meta & { TemplateName: string } =>
                  meta.TemplateName != null,
              )
              .map((meta) => ({
                templateName: meta.TemplateName,
                templateArn: templateArnOf(
                  region,
                  accountId,
                  meta.TemplateName,
                ),
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.templateName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getTemplate(name);
          if (!found) return undefined;
          const attrs = {
            templateName: name,
            templateArn: templateArnOf(region, accountId, name),
          };
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.templateName ?? (yield* createName(id, news));
          const templateArn = templateArnOf(region, accountId, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredContent = toContent(news);

          // 1. OBSERVE
          let observed = yield* getTemplate(name);

          if (observed === undefined) {
            // 2. ENSURE — AlreadyExists is a race → converge via update.
            yield* sesv2
              .createEmailTemplate({
                TemplateName: name,
                TemplateContent: desiredContent,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateEmailTemplate({
                    TemplateName: name,
                    TemplateContent: desiredContent,
                  }),
                ),
              );
            observed = yield* sesv2.getEmailTemplate({ TemplateName: name });
          } else if (
            observed.TemplateContent.Subject !== desiredContent.Subject ||
            observed.TemplateContent.Text !== desiredContent.Text ||
            observed.TemplateContent.Html !== desiredContent.Html
          ) {
            // 3. SYNC content — only when the observed content drifted.
            yield* sesv2.updateEmailTemplate({
              TemplateName: name,
              TemplateContent: desiredContent,
            });
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sesv2.tagResource({
              ResourceArn: templateArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* sesv2.untagResource({
              ResourceArn: templateArn,
              TagKeys: removed,
            });
          }

          yield* session.note(templateArn);
          return { templateName: name, templateArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteEmailTemplate({ TemplateName: output.templateName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
