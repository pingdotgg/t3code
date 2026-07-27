import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  waitForBotSettled,
  waitForLocaleBuilt,
} from "./internal.ts";

export interface BotVersionProps {
  /**
   * ID of the bot to version. Changing it replaces the version.
   */
  botId: string;
  /**
   * The locales included in the version, snapshot from `DRAFT`. Each locale
   * is built first if it is not already built (building a small bot takes
   * one to a few minutes). Pass the `localeId` attribute of the Intent (or
   * BotLocale) resources so the version depends on the conversation graph.
   * Changing the list replaces the version.
   */
  localeIds: string[];
  /**
   * Description of the version. Changing it replaces the version (versions
   * are immutable).
   */
  description?: string;
}

export interface BotVersion extends Resource<
  "AWS.LexV2.BotVersion",
  BotVersionProps,
  {
    /** ID of the bot the version belongs to. */
    botId: string;
    /** The numbered version Amazon Lex assigned, e.g. `1`. */
    botVersion: string;
    /** Status of the bot version (e.g. `Available`). */
    botStatus: string;
    /** The locales included in the version. */
    localeIds: string[];
  },
  never,
  Providers
> {}

/**
 * An immutable numbered version of an Amazon Lex V2 bot, snapshot from the
 * DRAFT version. The provider builds each included locale first (if needed),
 * so the version is immediately usable behind a `BotAlias`.
 *
 * Versions are immutable: any prop change replaces the resource with a newly
 * created version.
 *
 * @resource
 * @section Creating a Version
 * @example Version a Built Locale
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const version = yield* AWS.LexV2.BotVersion("V1", {
 *   botId: intent.botId,
 *   // depend on the intent so the build includes it
 *   localeIds: [intent.localeId],
 * });
 * const alias = yield* AWS.LexV2.BotAlias("Live", {
 *   botId: version.botId,
 *   botVersion: version.botVersion,
 * });
 * ```
 */
export const BotVersion = Resource<BotVersion>("AWS.LexV2.BotVersion");

const describeVersion = Effect.fn(function* (
  botId: string,
  botVersion: string,
) {
  return yield* lexm
    .describeBotVersion({ botId, botVersion })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
});

export const BotVersionProvider = () =>
  Provider.effect(
    BotVersion,
    Effect.gen(function* () {
      return {
        stables: ["botId", "botVersion"],

        // Sub-resource keyed entirely by its bot — nuke reaches it through
        // the parent bot's deletion.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ output }) {
          // Versions are auto-numbered — without cached output there is no
          // deterministic identity to look up.
          if (output === undefined) return undefined;
          const observed = yield* describeVersion(
            output.botId,
            output.botVersion,
          );
          if (observed === undefined) return undefined;
          return {
            botId: observed.botId!,
            botVersion: observed.botVersion!,
            botStatus: observed.botStatus!,
            localeIds: output.localeIds,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // Versions are immutable — any change replaces (a new version is
          // created and the old one deleted).
          if (
            olds?.botId !== news.botId ||
            (olds?.description ?? undefined) !==
              (news.description ?? undefined) ||
            JSON.stringify([...(olds?.localeIds ?? [])].sort()) !==
              JSON.stringify([...news.localeIds].sort())
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — versions are immutable; if the cached version still
          //    exists there is nothing to converge.
          if (output?.botVersion !== undefined) {
            const existing = yield* describeVersion(
              news.botId,
              output.botVersion,
            );
            if (existing !== undefined) {
              yield* session.note(`${news.botId}/${output.botVersion}`);
              return {
                botId: existing.botId!,
                botVersion: existing.botVersion!,
                botStatus: existing.botStatus!,
                localeIds: news.localeIds,
              };
            }
          }

          // 2. ENSURE each included DRAFT locale is built.
          for (const localeId of news.localeIds) {
            const locale = yield* lexm.describeBotLocale({
              botId: news.botId,
              botVersion: "DRAFT",
              localeId,
            });
            if (locale.botLocaleStatus !== "Built") {
              // An in-flight build surfaces as Conflict — treat as a race.
              yield* lexm
                .buildBotLocale({
                  botId: news.botId,
                  botVersion: "DRAFT",
                  localeId,
                })
                .pipe(Effect.catchTag("ConflictException", () => Effect.void));
              yield* waitForLocaleBuilt(news.botId, localeId);
            }
          }

          // 3. CREATE the version snapshot and wait for it to settle.
          const created = yield* retryWhileConflict(
            lexm.createBotVersion({
              botId: news.botId,
              description: news.description,
              botVersionLocaleSpecification: Object.fromEntries(
                news.localeIds.map((localeId) => [
                  localeId,
                  { sourceBotVersion: "DRAFT" },
                ]),
              ),
            }),
          );
          const botVersion = created.botVersion!;
          yield* waitForBotSettled(news.botId);
          const observed = yield* describeVersion(news.botId, botVersion);
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `failed to read created Lex bot version ${news.botId}/${botVersion}`,
              ),
            );
          }

          yield* session.note(`${news.botId}/${botVersion}`);
          return {
            botId: observed.botId!,
            botVersion: observed.botVersion!,
            botStatus: observed.botStatus!,
            localeIds: news.localeIds,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Lex reports a missing version (or already-deleted parent bot) as
          // PreconditionFailed.
          yield* retryWhileConflict(
            lexm.deleteBotVersion({
              botId: output.botId,
              botVersion: output.botVersion,
              skipResourceInUseCheck: true,
            }),
          ).pipe(
            Effect.catchTag("PreconditionFailedException", () => Effect.void),
          );
        }),
      };
    }),
  );
