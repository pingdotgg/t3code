import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileConflict, waitForLocaleSettled } from "./internal.ts";

export interface BotLocaleProps {
  /**
   * ID of the bot the locale belongs to. Changing it replaces the locale.
   */
  botId: string;
  /**
   * The language/locale the bot converses in, e.g. `en_US`. Changing it
   * replaces the locale.
   */
  localeId: string;
  /**
   * Confidence threshold (0 to 1) below which Amazon Lex inserts
   * `AMAZON.FallbackIntent` into the possible-intents list.
   * @default 0.4
   */
  nluIntentConfidenceThreshold?: number;
  /**
   * Description of the locale.
   */
  description?: string;
  /**
   * Amazon Polly voice used for spoken interaction with the user.
   */
  voiceSettings?: {
    /** Amazon Polly voice ID, e.g. `Ivy`. */
    voiceId: string;
    /**
     * Polly engine to use.
     * @default "standard"
     */
    engine?: "standard" | "neural" | "long-form" | "generative";
  };
}

export interface BotLocale extends Resource<
  "AWS.LexV2.BotLocale",
  BotLocaleProps,
  {
    /** ID of the bot the locale belongs to. */
    botId: string;
    /** Bot version the locale lives on — always `DRAFT`. */
    botVersion: string;
    /** The locale ID, e.g. `en_US`. */
    localeId: string;
    /** Human-readable locale name, e.g. `English (US)`. */
    localeName: string | undefined;
    /** Current status of the locale (e.g. `NotBuilt`, `Built`). */
    botLocaleStatus: string;
  },
  never,
  Providers
> {}

/**
 * A language/locale on the DRAFT version of an Amazon Lex V2 bot. Intents and
 * slot types live under a locale; a locale must exist before either can be
 * created.
 *
 * @resource
 * @section Creating a Locale
 * @example US English Locale
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const locale = yield* AWS.LexV2.BotLocale("En", {
 *   botId: bot.botId,
 *   localeId: "en_US",
 * });
 * ```
 *
 * @example Locale with Voice and Threshold
 * ```typescript
 * const locale = yield* AWS.LexV2.BotLocale("En", {
 *   botId: bot.botId,
 *   localeId: "en_US",
 *   nluIntentConfidenceThreshold: 0.7,
 *   voiceSettings: { voiceId: "Ivy", engine: "neural" },
 * });
 * ```
 */
export const BotLocale = Resource<BotLocale>("AWS.LexV2.BotLocale");

const describeLocale = Effect.fn(function* (botId: string, localeId: string) {
  return yield* lexm
    .describeBotLocale({ botId, botVersion: "DRAFT", localeId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
});

const attributesOf = (
  locale: lexm.DescribeBotLocaleResponse,
): BotLocale["Attributes"] => ({
  botId: locale.botId!,
  botVersion: "DRAFT",
  localeId: locale.localeId!,
  localeName: locale.localeName,
  botLocaleStatus: locale.botLocaleStatus!,
});

export const BotLocaleProvider = () =>
  Provider.effect(
    BotLocale,
    Effect.gen(function* () {
      return {
        stables: ["botId", "botVersion", "localeId"],

        // Sub-resource keyed entirely by its bot — nuke reaches it through
        // the parent bot's deletion.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const botId = output?.botId ?? olds?.botId;
          const localeId = output?.localeId ?? olds?.localeId;
          if (botId === undefined || localeId === undefined) return undefined;
          const observed = yield* describeLocale(botId, localeId);
          return observed === undefined ? undefined : attributesOf(observed);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds?.botId !== news.botId || olds?.localeId !== news.localeId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const desiredThreshold = news.nluIntentConfidenceThreshold ?? 0.4;

          // 1. OBSERVE
          let observed = yield* describeLocale(news.botId, news.localeId);

          // 2. ENSURE — a Conflict is a concurrent create of the same locale.
          if (observed === undefined) {
            yield* lexm
              .createBotLocale({
                botId: news.botId,
                botVersion: "DRAFT",
                localeId: news.localeId,
                nluIntentConfidenceThreshold: desiredThreshold,
                description: news.description,
                voiceSettings: news.voiceSettings,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            observed = yield* waitForLocaleSettled(news.botId, news.localeId);
          }

          // 3. SYNC — apply the delta when a declared prop drifted.
          if (
            observed.nluIntentConfidenceThreshold !== desiredThreshold ||
            (observed.description ?? undefined) !==
              (news.description ?? undefined) ||
            (observed.voiceSettings?.voiceId ?? undefined) !==
              (news.voiceSettings?.voiceId ?? undefined)
          ) {
            yield* retryWhileConflict(
              lexm.updateBotLocale({
                botId: news.botId,
                botVersion: "DRAFT",
                localeId: news.localeId,
                nluIntentConfidenceThreshold: desiredThreshold,
                description: news.description,
                voiceSettings: news.voiceSettings,
              }),
            );
            observed = yield* waitForLocaleSettled(news.botId, news.localeId);
          }

          yield* session.note(`${news.botId}/${news.localeId}`);
          return attributesOf(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Lex reports a missing locale (or an already-deleted parent bot)
          // as PreconditionFailed.
          yield* retryWhileConflict(
            lexm.deleteBotLocale({
              botId: output.botId,
              botVersion: "DRAFT",
              localeId: output.localeId,
            }),
          ).pipe(
            Effect.catchTag("PreconditionFailedException", () => Effect.void),
          );
        }),
      };
    }),
  );
