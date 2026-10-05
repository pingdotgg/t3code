import * as gamesConfiguration from "@distilled.cloud/gcp/gamesConfiguration_v1configuration";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_ACHIEVEMENT_TYPE = "STANDARD";
export const DEFAULT_INITIAL_STATE = "REVEALED";
export const DEFAULT_POINT_VALUE = 5;
export const DEFAULT_STEPS_TO_UNLOCK = 10;
export const DEFAULT_SCORE_ORDER = "LARGER_IS_BETTER";
export const MAX_ACHIEVEMENT_NAME_LENGTH = 100;
export const MAX_ACHIEVEMENT_DESCRIPTION_LENGTH = 500;
export const MAX_LEADERBOARD_NAME_LENGTH = 100;
export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ACHIEVEMENT_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
    });
    return generated.slice(0, maxLength);
  });

export const translationsOf = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
): gamesConfiguration.LocalizedString[] =>
  (bundle?.translations ?? []).map((entry) => ({
    locale: entry.locale,
    value: entry.value,
  }));

export const translationValue = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale = DEFAULT_LOCALE,
): string | undefined => {
  const translations = translationsOf(bundle);
  const match =
    translations.find((entry) => (entry.locale ?? locale) === locale) ??
    translations[0];
  return match?.value;
};

export const withTranslation = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale: string,
  value: string,
): gamesConfiguration.LocalizedStringBundle => {
  const translations = translationsOf(bundle);
  const idx = translations.findIndex(
    (entry) => (entry.locale ?? locale) === locale,
  );
  const next = { locale, value };
  if (idx >= 0) {
    translations[idx] = { ...translations[idx], ...next };
  } else {
    translations.unshift(next);
  }
  return { translations };
};

export const sameBundle = (
  left: gamesConfiguration.LocalizedStringBundle | undefined,
  right: gamesConfiguration.LocalizedStringBundle | undefined,
) =>
  jsonEqual(
    translationsOf(left)
      .map((entry) => ({
        locale: entry.locale ?? DEFAULT_LOCALE,
        value: entry.value ?? "",
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale)),
    translationsOf(right)
      .map((entry) => ({
        locale: entry.locale ?? DEFAULT_LOCALE,
        value: entry.value ?? "",
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale)),
  );

export const defaultScoreFormat =
  (): gamesConfiguration.GamesNumberFormatConfiguration => ({
    numberFormatType: "NUMERIC",
    numDecimalPlaces: 0,
  });

export const getAchievement = (achievementId: string) =>
  achievementId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gamesConfiguration.getAchievementConfigurations({ achievementId }),
      );

export const getLeaderboard = (leaderboardId: string) =>
  leaderboardId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gamesConfiguration.getLeaderboardConfigurations({ leaderboardId }),
      );
