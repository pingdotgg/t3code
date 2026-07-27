import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readLexTags,
  toLexName,
  retryWhileConflict,
  syncLexTags,
  waitForBotSettled,
} from "./internal.ts";

export interface BotProps {
  /**
   * Name of the bot. Mutable — renames update the bot in place (identity is
   * the generated bot ID).
   * @default ${app}-${id}-${stage}-${suffix}
   */
  botName?: string;
  /**
   * ARN of an IAM role that Amazon Lex assumes to call AWS services on the
   * bot's behalf (e.g. Polly for speech). The role must trust
   * `lexv2.amazonaws.com`.
   */
  roleArn: string;
  /**
   * COPPA data-privacy declaration. Set `childDirected: true` when the bot
   * is directed at children under 13.
   * @default { childDirected: false }
   */
  dataPrivacy?: {
    /** Whether the bot is directed at children under 13 (COPPA). */
    childDirected: boolean;
  };
  /**
   * How long Amazon Lex retains a conversation session after the last user
   * input (60 seconds to 24 hours). Accepts any `Duration.Input` (e.g.
   * `"10 minutes"`, `Duration.minutes(10)`; a bare number is milliseconds);
   * the wire unit is whole seconds.
   * @default 300 seconds
   */
  idleSessionTTL?: Duration.Input;
  /**
   * Description of the bot.
   */
  description?: string;
  /**
   * Tags to associate with the bot.
   */
  tags?: Record<string, string>;
}

export interface Bot extends Resource<
  "AWS.LexV2.Bot",
  BotProps,
  {
    /** Unique identifier assigned to the bot. */
    botId: string;
    /** Name of the bot. */
    botName: string;
    /** ARN of the bot. */
    botArn: string;
    /** Current status of the bot (e.g. `Available`). */
    botStatus: string;
    /** ARN of the IAM role the bot assumes. */
    roleArn: string;
    /** Tags currently associated with the bot. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Lex V2 conversational bot. The bot is the container for locales,
 * intents, and slot types; conversations run against an alias of a built
 * version.
 *
 * @resource
 * @section Creating a Bot
 * @example Basic Bot
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const role = yield* AWS.IAM.Role("BotRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "lexv2.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 * });
 *
 * const bot = yield* AWS.LexV2.Bot("OrderBot", {
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Bot with Session and Privacy Settings
 * ```typescript
 * const bot = yield* AWS.LexV2.Bot("KidsBot", {
 *   roleArn: role.roleArn,
 *   dataPrivacy: { childDirected: true },
 *   idleSessionTTL: "10 minutes",
 *   description: "A bot for children",
 * });
 * ```
 *
 * @section Building the Conversation Graph
 * @example Locale, Intent, and Alias
 * ```typescript
 * const locale = yield* AWS.LexV2.BotLocale("En", {
 *   botId: bot.botId,
 *   localeId: "en_US",
 * });
 * const intent = yield* AWS.LexV2.Intent("Greet", {
 *   botId: locale.botId,
 *   localeId: locale.localeId,
 *   sampleUtterances: ["hello", "hi"],
 * });
 * const version = yield* AWS.LexV2.BotVersion("V1", {
 *   botId: intent.botId,
 *   localeIds: [intent.localeId],
 * });
 * const alias = yield* AWS.LexV2.BotAlias("Live", {
 *   botId: version.botId,
 *   botVersion: version.botVersion,
 * });
 * ```
 */
export const Bot = Resource<Bot>("AWS.LexV2.Bot");

const createBotName = (id: string, props: { botName?: string | undefined }) =>
  Effect.gen(function* () {
    if (props.botName) return props.botName;
    return toLexName(yield* createPhysicalName({ id, maxLength: 100 }));
  });

const describeBot = Effect.fn(function* (botId: string) {
  return yield* lexm
    .describeBot({ botId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
});

/** Find a bot by exact name. The physical name embeds app/stage/id. */
const findBotByName = Effect.fn(function* (botName: string) {
  const pages = yield* lexm.listBots
    .pages({
      filters: [{ name: "BotName", values: [botName], operator: "EQ" }],
    })
    .pipe(Stream.runCollect);
  const summary = Array.from(pages)
    .flatMap((page) => page.botSummaries ?? [])
    .find((bot) => bot.botName === botName);
  if (summary?.botId === undefined) return undefined;
  return yield* describeBot(summary.botId);
});

const botArnOf = Effect.fn(function* (botId: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:lex:${region}:${accountId}:bot/${botId}`;
});

const attributesOf = Effect.fn(function* (bot: lexm.DescribeBotResponse) {
  const botArn = yield* botArnOf(bot.botId!);
  return {
    botId: bot.botId!,
    botName: bot.botName!,
    botArn,
    botStatus: bot.botStatus!,
    roleArn: bot.roleArn!,
    tags: yield* readLexTags(botArn),
  } satisfies Bot["Attributes"];
});

export const BotProvider = () =>
  Provider.effect(
    Bot,
    Effect.gen(function* () {
      return {
        stables: ["botId", "botArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* lexm.listBots
              .pages({})
              .pipe(Stream.runCollect);
            const ids = Array.from(pages)
              .flatMap((page) => page.botSummaries ?? [])
              .map((bot) => bot.botId)
              .filter((id): id is string => id !== undefined);
            const hydrated = yield* Effect.forEach(
              ids,
              (id) =>
                Effect.flatMap(describeBot(id), (bot) =>
                  bot === undefined
                    ? Effect.succeed(undefined)
                    : attributesOf(bot),
                ),
              { concurrency: 5 },
            );
            return hydrated.filter(
              (attrs): attrs is Bot["Attributes"] => attrs !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const observed =
            output?.botId !== undefined
              ? yield* describeBot(output.botId)
              : yield* findBotByName(yield* createBotName(id, olds ?? {}));
          if (observed === undefined) return undefined;
          const attrs = yield* attributesOf(observed);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        // All bot props are mutable via UpdateBot — no replacement triggers.

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const botName = yield* createBotName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredDataPrivacy = news.dataPrivacy ?? {
            childDirected: false,
          };
          // Wire unit is whole seconds (idleSessionTTLInSeconds).
          const desiredTtl = toWireSeconds(news.idleSessionTTL) ?? 300;

          // 1. OBSERVE — output.botId is only a cache; fall back to name.
          let observed =
            output?.botId !== undefined
              ? yield* describeBot(output.botId)
              : undefined;
          if (observed === undefined) {
            observed = yield* findBotByName(botName);
          }

          // 2. ENSURE — create when missing; a Conflict is a concurrent
          //    create of the same name.
          if (observed === undefined) {
            const created = yield* lexm
              .createBot({
                botName,
                roleArn: news.roleArn,
                dataPrivacy: desiredDataPrivacy,
                idleSessionTTLInSeconds: desiredTtl,
                description: news.description,
                botTags: desiredTags,
              })
              .pipe(
                Effect.map((r) => r.botId),
                Effect.catchTag("ConflictException", () =>
                  Effect.map(findBotByName(botName), (bot) => bot?.botId),
                ),
              );
            if (created === undefined) {
              return yield* Effect.fail(
                new Error(`failed to create Lex bot ${botName}`),
              );
            }
            observed = yield* waitForBotSettled(created);
          }

          const botId = observed.botId!;

          // 3. SYNC — apply the delta when any declared prop drifted.
          if (
            observed.botName !== botName ||
            observed.roleArn !== news.roleArn ||
            (observed.description ?? undefined) !==
              (news.description ?? undefined) ||
            observed.idleSessionTTLInSeconds !== desiredTtl ||
            (observed.dataPrivacy?.childDirected ?? false) !==
              desiredDataPrivacy.childDirected
          ) {
            yield* retryWhileConflict(
              lexm.updateBot({
                botId,
                botName,
                roleArn: news.roleArn,
                dataPrivacy: desiredDataPrivacy,
                idleSessionTTLInSeconds: desiredTtl,
                description: news.description,
              }),
            );
            observed = yield* waitForBotSettled(botId);
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const botArn = yield* botArnOf(botId);
          const observedTags = yield* readLexTags(botArn);
          yield* syncLexTags(botArn, observedTags, desiredTags);

          yield* session.note(botId);
          return yield* attributesOf(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteBot is asynchronous (status `Deleting`); Lex reports a
          // missing bot as PreconditionFailed.
          yield* retryWhileConflict(
            lexm.deleteBot({
              botId: output.botId,
              skipResourceInUseCheck: true,
            }),
          ).pipe(
            Effect.catchTag("PreconditionFailedException", () => Effect.void),
          );
        }),
      };
    }),
  );
