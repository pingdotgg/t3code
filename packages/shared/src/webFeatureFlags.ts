export const WEB_FEATURE_QUERY_PARAM = "salchiFeature";

export const DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE = "downloadable-diagnostics";

export const WEB_FEATURE_FLAGS = [DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE] as const;

export type WebFeatureFlag = (typeof WEB_FEATURE_FLAGS)[number];

const WEB_FEATURE_FLAG_SET = new Set<string>(WEB_FEATURE_FLAGS);

export function isWebFeatureFlag(value: string): value is WebFeatureFlag {
  return WEB_FEATURE_FLAG_SET.has(value);
}

export function normalizeWebFeatureFlags(
  values: ReadonlyArray<string | null | undefined>,
): WebFeatureFlag[] {
  const flags: WebFeatureFlag[] = [];
  const seen = new Set<WebFeatureFlag>();

  for (const value of values) {
    for (const part of value?.split(",") ?? []) {
      const flag = part.trim();
      if (!isWebFeatureFlag(flag) || seen.has(flag)) {
        continue;
      }
      seen.add(flag);
      flags.push(flag);
    }
  }

  return flags;
}

export function readWebFeatureFlagsFromUrl(url: URL): WebFeatureFlag[] {
  return normalizeWebFeatureFlags(url.searchParams.getAll(WEB_FEATURE_QUERY_PARAM));
}

export function appendWebFeatureFlagsToUrl(
  rawUrl: string,
  values: ReadonlyArray<string | null | undefined>,
): string {
  const flags = normalizeWebFeatureFlags(values);
  if (flags.length === 0) {
    return rawUrl;
  }

  const url = new URL(rawUrl);
  const existingFlags = new Set(readWebFeatureFlagsFromUrl(url));
  for (const flag of flags) {
    if (!existingFlags.has(flag)) {
      url.searchParams.append(WEB_FEATURE_QUERY_PARAM, flag);
    }
  }
  return url.toString();
}
