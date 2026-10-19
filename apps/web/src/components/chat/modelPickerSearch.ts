import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

type ModelPickerSearchableModel = {
  driverKind: string;
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;
const MODEL_PICKER_EXACT_NAME_SCORE = -1000;

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
    ignorePosition: true,
  });
}

function normalizeModelName(name: string): string {
  return normalizeSearchQuery(name).replace(/\s+/gu, " ");
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

  const normalizedQuery = tokens.join(" ");
  if (
    normalizedQuery === normalizeModelName(model.name) ||
    normalizedQuery === normalizeModelName(model.shortName ?? "")
  ) {
    return MODEL_PICKER_EXACT_NAME_SCORE;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores: Array<number> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const fieldScore = scoreModelPickerSearchToken(fields[index]!, token, index * 10);
      if (fieldScore !== null) {
        tokenScores.push(fieldScore);
      }
    }

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

export function rankModelPickerSearch<T>(
  items: ReadonlyArray<T>,
  query: string,
  toSearchable: (item: T) => ModelPickerSearchableModel,
): T[] {
  const ranked: Array<{
    item: T;
    score: number;
    isFavorite: boolean;
    order: number;
  }> = [];
  items.forEach((item, order) => {
    const searchable = toSearchable(item);
    const score = scoreModelPickerSearch(searchable, query);
    if (score !== null) {
      ranked.push({
        item,
        score,
        isFavorite: searchable.isFavorite === true,
        order,
      });
    }
  });
  return ranked
    .toSorted(
      (a, b) =>
        a.score - b.score || Number(b.isFavorite) - Number(a.isFavorite) || a.order - b.order,
    )
    .map((entry) => entry.item);
}
