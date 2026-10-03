import { type ProviderDriverKind } from "@t3tools/contracts";
import { modelProviderId, resolveModelProviderLabel } from "@t3tools/shared/model";
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
  /**
   * The upstream provider as the row shows it: the catalog's own
   * `subProvider` when it has one, otherwise OpenCode's decoded slug segment
   * (e.g. "OpenCode Zen" for `opencode/big-pickle`). Indexed so searching the
   * visible name finds the model.
   */
  subProvider?: string;
  /**
   * The raw upstream provider segment of the model's slug (e.g. `opencode-go`
   * for `opencode-go/deepseek-flash`). Indexed alongside `subProvider` so the
   * un-humanized id stays searchable.
   */
  providerId?: string;
  isFavorite?: boolean;
};

type ModelPickerSearchModelInput = {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string | undefined;
  readonly subProvider?: string | undefined;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
};

/**
 * Maps a picker model to the fields search ranks over. The picker row labels
 * the upstream provider via `resolveModelProviderLabel`, so the searchable
 * `subProvider` carries that resolved label rather than the raw catalog value;
 * the raw provider id is kept alongside it. Both feed score and tiebreaker.
 */
export function buildModelPickerSearchModel(
  model: ModelPickerSearchModelInput,
): ModelPickerSearchableModel {
  const upstreamProvider = resolveModelProviderLabel({
    slug: model.slug,
    subProvider: model.subProvider,
    driverKind: model.driverKind,
  });
  // Other drivers use slashes for their own namespacing, so only OpenCode's
  // slug segment is an upstream provider worth indexing by raw id.
  const providerId = model.driverKind === "opencode" ? modelProviderId(model.slug) : undefined;
  return {
    name: model.name,
    ...(model.shortName ? { shortName: model.shortName } : {}),
    ...(upstreamProvider ? { subProvider: upstreamProvider } : {}),
    ...(providerId ? { providerId } : {}),
    driverKind: model.driverKind,
    providerDisplayName: model.providerDisplayName,
  };
}

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    ...(model.providerId ? [normalizeSearchQuery(model.providerId)] : []),
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
    [
      model.name,
      model.shortName,
      model.subProvider,
      model.providerId,
      model.driverKind,
      model.providerDisplayName,
    ]
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
