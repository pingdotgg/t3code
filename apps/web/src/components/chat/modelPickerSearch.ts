import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    buildModelPickerSearchText(model),
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores = fields
      .map((field, index) => scoreModelPickerSearchToken(field, token, index * 10))
      .filter((fieldScore): fieldScore is number => fieldScore !== null);

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}
