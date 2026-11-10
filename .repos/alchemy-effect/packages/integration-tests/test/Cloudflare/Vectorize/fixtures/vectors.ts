/**
 * Pure, dependency-free vector helpers shared by both worker fixtures. Kept
 * separate from `index-resource.ts` (which imports `@/Cloudflare`) so the plain
 * async Worker bundle does NOT drag the alchemy/Effect graph — and its
 * `node:os` transitive import — into the Worker, which Cloudflare rejects.
 */
export const DIMENSIONS = 32;

/** Builds a deterministic `DIMENSIONS`-length vector seeded by the first values. */
export const vector = (...seed: number[]): number[] =>
  Array.from({ length: DIMENSIONS }, (_, i) => seed[i] ?? (i % 10) / 10);

/**
 * The three vectors every worker upserts. Ids are namespaced by `label` so the
 * effect/async workers stay independent even though they share one index.
 */
export const seedVectors = (label: string) => [
  {
    id: `${label}-a`,
    values: vector(0.1, 0.2, 0.3),
    metadata: { kind: "first" },
  },
  {
    id: `${label}-b`,
    values: vector(0.9, 0.8, 0.7),
    metadata: { kind: "second" },
  },
  {
    id: `${label}-c`,
    values: vector(0.4, 0.5, 0.6),
    metadata: { kind: "third" },
  },
];
