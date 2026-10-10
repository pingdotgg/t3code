/**
 * A Fly.io region code. The literal codes are the regions Fly listed in
 * September 2026 and give editor completion; any other string is accepted
 * so new regions work without an Alchemy release. `bom` is deprecated by
 * Fly. See [Regions](/fly/compute/regions).
 */
export type Region =
  | "ams"
  | "arn"
  | "bom"
  | "cdg"
  | "dfw"
  | "ewr"
  | "fra"
  | "gru"
  | "iad"
  | "jnb"
  | "lax"
  | "lhr"
  | "nrt"
  | "ord"
  | "sin"
  | "sjc"
  | "syd"
  | "yyz"
  | (string & {});

/** Normalize a `Region | Region[]` prop into a de-duplicated list. */
export const regionList = (
  region: Region | readonly Region[] | undefined,
  fallback: string,
): string[] => {
  const list = region === undefined ? [fallback] : [region].flat();
  const unique = [...new Set(list)];
  return unique.length === 0 ? [fallback] : unique;
};

/**
 * Region of replica `index` when `count` replicas run in each of
 * `regions`. Replicas are spread round-robin, so growing `count` keeps
 * every existing replica in its region.
 */
export const regionOfReplica = (regions: readonly string[], index: number) =>
  regions[index % regions.length]!;
