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
  DEFAULT_ACHIEVEMENT_TYPE,
  DEFAULT_INITIAL_STATE,
  DEFAULT_LOCALE,
  DEFAULT_POINT_VALUE,
  DEFAULT_STEPS_TO_UNLOCK,
  getAchievement,
  ignoreMissing,
  sameBundle,
  sameNumber,
  sameText,
  toDisplayName,
  withTranslation,
  translationValue,
} from "./internal.ts";

export type AchievementConfigurationProps = {
  /**
   * Play Games application id from the Google Play Console. Immutable —
   * changing it replaces the achievement.
   */
  applicationId: string;
  /**
   * Server-assigned achievement id. Immutable — changing it replaces the
   * achievement.
   */
  achievementId?: string;
  /**
   * Achievement type. Immutable after create.
   * @default "STANDARD"
   */
  achievementType?:
    | gamesConfiguration.AchievementConfigurationAchievementTypeEnum
    | (string & {});
  /**
   * Initial visibility of the achievement.
   * @default "REVEALED"
   */
  initialState?:
    | gamesConfiguration.AchievementConfigurationInitialStateEnum
    | (string & {});
  /**
   * Steps required to unlock. Required for `INCREMENTAL` achievements.
   * @default 10
   */
  stepsToUnlock?: number;
  /**
   * Default-locale display name. If omitted, a unique name is generated.
   */
  name?: string;
  /**
   * Default-locale description.
   * @default the name
   */
  description?: string;
  /**
   * Locale used for `name` and `description` translations.
   * @default "en-US"
   */
  locale?: string;
  /**
   * Point value awarded when the achievement unlocks.
   * @default 5
   */
  pointValue?: number;
  /**
   * Full draft detail. `name`, `description`, `locale`, and `pointValue`
   * overlay the default-locale fields when set.
   */
  draft?: gamesConfiguration.AchievementConfigurationDetail;
};

export type AchievementConfiguration = Resource<
  "GCP.GamesConfiguration.AchievementConfiguration",
  AchievementConfigurationProps,
  {
    /** Server-assigned achievement id. */
    achievementId: string;
    /** Play Games application id. */
    applicationId: string;
    /** Project id used when the achievement was reconciled. */
    project: string;
    /** Achievement type. */
    achievementType: string | undefined;
    /** Initial visibility. */
    initialState: string | undefined;
    /** Steps to unlock, for incremental achievements. */
    stepsToUnlock: number | undefined;
    /** Default-locale name. */
    name: string | undefined;
    /** Default-locale description. */
    description: string | undefined;
    /** Default locale used for name and description. */
    locale: string | undefined;
    /** Point value. */
    pointValue: number | undefined;
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
 * A Play Games Services achievement configuration.
 *
 * Achievement configurations have no labels field and a server-assigned
 * id, so only a recorded achievement can be read back. `applicationId` and `achievementId` are identity — changing either
 * replaces the configuration. `achievementType` is immutable after
 * create. Name, description, initial state, steps, and point value
 * update in place.
 *
 * ### Creating an Achievement
 * **Example:** Standard achievement
 * ```typescript
 * const achievement = yield* GCP.GamesConfiguration.AchievementConfiguration(
 *   "FirstWin",
 *   {
 *     applicationId: "123456789012",
 *     name: "First Win",
 *     description: "Win your first match",
 *   },
 * );
 * ```
 *
 * **Example:** Incremental achievement
 * ```typescript
 * const achievement = yield* GCP.GamesConfiguration.AchievementConfiguration(
 *   "Centurion",
 *   {
 *     applicationId: "123456789012",
 *     achievementType: "INCREMENTAL",
 *     stepsToUnlock: 100,
 *     name: "Centurion",
 *     description: "Win 100 matches",
 *     pointValue: 20,
 *   },
 * );
 * ```
 *
 * ### Updating an Achievement
 * **Example:** Change the description
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const achievement = yield* GCP.GamesConfiguration.AchievementConfiguration(
 *   "FirstWin",
 *   {
 *     applicationId: "123456789012",
 *     name: "First Win",
 *     description: "Win a match",
 *   },
 * );
 * ```
 *
 * @resource
 * @category GamesConfiguration
 */
export const AchievementConfiguration = Resource<AchievementConfiguration>(
  "GCP.GamesConfiguration.AchievementConfiguration",
);

export class AchievementConfigurationNotResolved extends Data.TaggedError(
  "GCP.GamesConfiguration.AchievementConfigurationNotResolved",
)<{
  applicationId: string;
  achievementId: string;
}> {}

const localeOf = (
  news: AchievementConfigurationProps,
  current?: gamesConfiguration.AchievementConfiguration,
) =>
  news.locale ??
  current?.draft?.name?.translations?.[0]?.locale ??
  current?.draft?.description?.translations?.[0]?.locale ??
  DEFAULT_LOCALE;

const toAttrs = (
  achievement: gamesConfiguration.AchievementConfiguration,
  applicationId: string,
  project: string,
  locale = DEFAULT_LOCALE,
) => ({
  achievementId: achievement.id ?? "",
  applicationId,
  project,
  achievementType: achievement.achievementType,
  initialState: achievement.initialState,
  stepsToUnlock: achievement.stepsToUnlock,
  name: translationValue(achievement.draft?.name, locale),
  description: translationValue(achievement.draft?.description, locale),
  locale,
  pointValue: achievement.draft?.pointValue,
  token: achievement.token,
  iconUrl: achievement.draft?.iconUrl,
  sortRank: achievement.draft?.sortRank,
});

const desiredBody = (input: {
  locale: string;
  name: string;
  description: string | undefined;
  news: AchievementConfigurationProps;
  current?: gamesConfiguration.AchievementConfiguration;
}): gamesConfiguration.AchievementConfiguration => {
  const achievementType =
    input.news.achievementType ??
    input.current?.achievementType ??
    DEFAULT_ACHIEVEMENT_TYPE;
  const draft = input.news.draft ?? {};
  const name = withTranslation(draft.name, input.locale, input.name);
  const description =
    input.description !== undefined
      ? withTranslation(draft.description, input.locale, input.description)
      : (draft.description ??
        withTranslation(undefined, input.locale, input.name));
  return {
    achievementType,
    initialState:
      input.news.initialState ??
      input.current?.initialState ??
      DEFAULT_INITIAL_STATE,
    stepsToUnlock:
      achievementType === "INCREMENTAL"
        ? (input.news.stepsToUnlock ??
          input.current?.stepsToUnlock ??
          DEFAULT_STEPS_TO_UNLOCK)
        : undefined,
    token: input.current?.token,
    id: input.current?.id,
    draft: {
      ...draft,
      name,
      description,
      pointValue:
        input.news.pointValue ??
        draft.pointValue ??
        input.current?.draft?.pointValue ??
        DEFAULT_POINT_VALUE,
    },
  };
};

const needsSync = (
  current: gamesConfiguration.AchievementConfiguration,
  desired: gamesConfiguration.AchievementConfiguration,
) =>
  !sameText(current.achievementType, desired.achievementType) ||
  !sameText(current.initialState, desired.initialState) ||
  !sameNumber(current.stepsToUnlock, desired.stepsToUnlock) ||
  !sameBundle(current.draft?.name, desired.draft?.name) ||
  !sameBundle(current.draft?.description, desired.draft?.description) ||
  !sameNumber(current.draft?.pointValue, desired.draft?.pointValue);

export const AchievementConfigurationProvider = () =>
  Provider.succeed(AchievementConfiguration, {
    stables: ["achievementId", "applicationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousApp = olds?.applicationId ?? output?.applicationId;
      if (previousApp !== undefined && news.applicationId !== previousApp) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.achievementId ?? output?.achievementId;
      if (
        previousId !== undefined &&
        news.achievementId !== undefined &&
        news.achievementId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.achievementType ?? output?.achievementType;
      if (
        previousType !== undefined &&
        news.achievementType !== undefined &&
        news.achievementType !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      // Server-assigned id: only a recorded achievement can be observed.
      const achievementId = olds?.achievementId ?? output?.achievementId ?? "";
      const existing = yield* getAchievement(achievementId);
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
      );

      let current = yield* getAchievement(
        news.achievementId ?? output?.achievementId ?? "",
      );

      const locale = localeOf(news, current);
      const desired = desiredBody({
        locale,
        name,
        description: news.description,
        news,
        current,
      });

      if (current === undefined) {
        current = yield* gamesConfiguration.insertAchievementConfigurations({
          applicationId,
          body: desired,
        });
      }

      if (current === undefined) {
        return yield* new AchievementConfigurationNotResolved({
          applicationId,
          achievementId: news.achievementId ?? output?.achievementId ?? "",
        });
      }

      const synced = desiredBody({
        locale,
        name,
        description: news.description,
        news,
        current,
      });
      if (needsSync(current, synced)) {
        current = yield* gamesConfiguration.updateAchievementConfigurations({
          achievementId: current.id ?? news.achievementId ?? "",
          body: synced,
        });
      }

      return toAttrs(current, applicationId, env.project, locale);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.achievementId.length === 0) return;
      yield* ignoreMissing(
        gamesConfiguration.deleteAchievementConfigurations({
          achievementId: output.achievementId,
        }),
      );
    }),
  });
