import * as gamesConfiguration from "@distilled.cloud/gcp/gamesConfiguration_v1configuration";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  defaultScoreFormat,
  DEFAULT_LOCALE,
  DEFAULT_SCORE_ORDER,
  getLeaderboard,
  ignoreMissing,
  jsonEqual,
  MAX_LEADERBOARD_NAME_LENGTH,
  sameBundle,
  sameText,
  toDisplayName,
  translationValue,
  withTranslation,
} from "./internal.ts";

export type LeaderboardConfigurationProps = {
  /**
   * Play Games application id from the Google Play Console. Immutable —
   * changing it replaces the leaderboard.
   */
  applicationId: string;
  /**
   * Server-assigned leaderboard id. Immutable — changing it replaces the
   * leaderboard.
   */
  leaderboardId?: string;
  /**
   * Sort order for posted scores.
   * @default "LARGER_IS_BETTER"
   */
  scoreOrder?:
    | gamesConfiguration.LeaderboardConfigurationScoreOrderEnum
    | (string & {});
  /**
   * Minimum score that can be posted (int64 string).
   */
  scoreMin?: string;
  /**
   * Maximum score that can be posted (int64 string).
   */
  scoreMax?: string;
  /**
   * Default-locale display name. If omitted, a unique name is generated.
   */
  name?: string;
  /**
   * Locale used for `name` translations.
   * @default "en-US"
   */
  locale?: string;
  /**
   * Score formatting. Defaults to a whole-number `NUMERIC` format.
   */
  scoreFormat?: gamesConfiguration.GamesNumberFormatConfiguration;
  /**
   * Full draft detail. `name`, `locale`, and `scoreFormat` overlay the
   * default-locale fields when set.
   */
  draft?: gamesConfiguration.LeaderboardConfigurationDetail;
};

export type LeaderboardConfiguration = Resource<
  "GCP.GamesConfiguration.LeaderboardConfiguration",
  LeaderboardConfigurationProps,
  {
    /** Server-assigned leaderboard id. */
    leaderboardId: string;
    /** Play Games application id. */
    applicationId: string;
    /** Project id used when the leaderboard was reconciled. */
    project: string;
    /** Sort order for posted scores. */
    scoreOrder: string | undefined;
    /** Minimum postable score. */
    scoreMin: string | undefined;
    /** Maximum postable score. */
    scoreMax: string | undefined;
    /** Default-locale name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Default locale used for the name. */
    locale: string | undefined;
    /** Score formatting. */
    scoreFormat: gamesConfiguration.GamesNumberFormatConfiguration | undefined;
    /** Opaque update token. */
    token: string | undefined;
    /** Draft icon URL. Writes to this field are ignored. */
    iconUrl: string | undefined;
    /** Draft sort rank. Writes to this field are ignored. */
    sortRank: number | undefined;
  },
  never,
  Providers
>;

/**
 * A Play Games Services leaderboard configuration.
 *
 * Leaderboard configurations have no labels field and a server-assigned
 * id, so only a recorded leaderboard can be read back. `applicationId` and `leaderboardId` are identity — changing either
 * replaces the configuration. Score order, bounds, name, and format
 * update in place.
 *
 * ### Creating a Leaderboard
 * **Example:** High-score board
 * ```typescript
 * const board = yield* GCP.GamesConfiguration.LeaderboardConfiguration(
 *   "HighScore",
 *   {
 *     applicationId: "123456789012",
 *     name: "High Score",
 *     scoreOrder: "LARGER_IS_BETTER",
 *   },
 * );
 * ```
 *
 * **Example:** Fastest-time board
 * ```typescript
 * const board = yield* GCP.GamesConfiguration.LeaderboardConfiguration(
 *   "BestTime",
 *   {
 *     applicationId: "123456789012",
 *     name: "Best Time",
 *     scoreOrder: "SMALLER_IS_BETTER",
 *     scoreFormat: { numberFormatType: "TIME_DURATION" },
 *   },
 * );
 * ```
 *
 * ### Updating a Leaderboard
 * **Example:** Change the name
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const board = yield* GCP.GamesConfiguration.LeaderboardConfiguration(
 *   "HighScore",
 *   {
 *     applicationId: "123456789012",
 *     name: "All-time High Score",
 *   },
 * );
 * ```
 *
 * @resource
 * @category GamesConfiguration
 */
export const LeaderboardConfiguration = Resource<LeaderboardConfiguration>(
  "GCP.GamesConfiguration.LeaderboardConfiguration",
);

export class LeaderboardConfigurationNotResolved extends Data.TaggedError(
  "GCP.GamesConfiguration.LeaderboardConfigurationNotResolved",
)<{
  applicationId: string;
  leaderboardId: string;
}> {}

const localeOf = (
  news: LeaderboardConfigurationProps,
  current?: gamesConfiguration.LeaderboardConfiguration,
) =>
  news.locale ??
  current?.draft?.name?.translations?.[0]?.locale ??
  DEFAULT_LOCALE;

const toAttrs = (
  leaderboard: gamesConfiguration.LeaderboardConfiguration,
  applicationId: string,
  project: string,
  locale = DEFAULT_LOCALE,
) => ({
  leaderboardId: leaderboard.id ?? "",
  applicationId,
  project,
  scoreOrder: leaderboard.scoreOrder,
  scoreMin: leaderboard.scoreMin,
  scoreMax: leaderboard.scoreMax,
  name: translationValue(leaderboard.draft?.name, locale),
  locale,
  scoreFormat: leaderboard.draft?.scoreFormat,
  token: leaderboard.token,
  iconUrl: leaderboard.draft?.iconUrl,
  sortRank: leaderboard.draft?.sortRank,
});

const desiredBody = (input: {
  locale: string;
  name: string;
  news: LeaderboardConfigurationProps;
  current?: gamesConfiguration.LeaderboardConfiguration;
}): gamesConfiguration.LeaderboardConfiguration => {
  const draft = input.news.draft ?? {};
  const name = withTranslation(draft.name, input.locale, input.name);
  return {
    scoreOrder:
      input.news.scoreOrder ?? input.current?.scoreOrder ?? DEFAULT_SCORE_ORDER,
    scoreMin: input.news.scoreMin ?? input.current?.scoreMin,
    scoreMax: input.news.scoreMax ?? input.current?.scoreMax,
    token: input.current?.token,
    id: input.current?.id,
    draft: {
      ...draft,
      name,
      scoreFormat:
        input.news.scoreFormat ??
        draft.scoreFormat ??
        input.current?.draft?.scoreFormat ??
        defaultScoreFormat(),
    },
  };
};

const needsSync = (
  current: gamesConfiguration.LeaderboardConfiguration,
  desired: gamesConfiguration.LeaderboardConfiguration,
) =>
  !sameText(current.scoreOrder, desired.scoreOrder) ||
  !sameText(current.scoreMin, desired.scoreMin) ||
  !sameText(current.scoreMax, desired.scoreMax) ||
  !sameBundle(current.draft?.name, desired.draft?.name) ||
  !jsonEqual(current.draft?.scoreFormat, desired.draft?.scoreFormat);

export const LeaderboardConfigurationProvider = () =>
  Provider.succeed(LeaderboardConfiguration, {
    stables: ["leaderboardId", "applicationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousApp = olds?.applicationId ?? output?.applicationId;
      if (previousApp !== undefined && news.applicationId !== previousApp) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.leaderboardId ?? output?.leaderboardId;
      if (
        previousId !== undefined &&
        news.leaderboardId !== undefined &&
        news.leaderboardId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      // Server-assigned id: only a recorded leaderboard can be observed.
      const leaderboardId = olds?.leaderboardId ?? output?.leaderboardId ?? "";
      const existing = yield* getLeaderboard(leaderboardId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        olds?.applicationId ?? output?.applicationId ?? "",
        env.project,
        olds?.locale ?? output?.locale,
      );
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const applicationId = news.applicationId;
      const name = yield* toDisplayName(
        id,
        news.name ?? translationValue(news.draft?.name, news.locale),
        output?.name,
        MAX_LEADERBOARD_NAME_LENGTH,
      );

      let current = yield* getLeaderboard(
        news.leaderboardId ?? output?.leaderboardId ?? "",
      );

      const locale = localeOf(news, current);
      const desired = desiredBody({
        locale,
        name,
        news,
        current,
      });

      if (current === undefined) {
        current = yield* gamesConfiguration.insertLeaderboardConfigurations({
          applicationId,
          body: desired,
        });
      }

      if (current === undefined) {
        return yield* new LeaderboardConfigurationNotResolved({
          applicationId,
          leaderboardId: news.leaderboardId ?? output?.leaderboardId ?? "",
        });
      }

      const synced = desiredBody({
        locale,
        name,
        news,
        current,
      });
      if (needsSync(current, synced)) {
        current = yield* gamesConfiguration.updateLeaderboardConfigurations({
          leaderboardId: current.id ?? news.leaderboardId ?? "",
          body: synced,
        });
      }

      return toAttrs(current, applicationId, env.project, locale);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.leaderboardId.length === 0) return;
      yield* ignoreMissing(
        gamesConfiguration.deleteLeaderboardConfigurations({
          leaderboardId: output.leaderboardId,
        }),
      );
    }),
  });
