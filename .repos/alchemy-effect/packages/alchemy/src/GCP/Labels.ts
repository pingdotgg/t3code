import * as Effect from "effect/Effect";
import { createInternalTags, diffTags, hasTags, type Tags } from "../Tags.ts";

/**
 * GCP label keys may contain only lowercase letters, digits, underscores
 * and dashes (no `:`, no `.`). Alchemy ownership tags
 * `alchemy::stack` / `alchemy::stage` / `alchemy::id` map onto
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id`.
 */
export const ALCHEMY_LABEL_PREFIX = "alchemy-";

export const alchemyLabelKeys = {
  stack: "alchemy-stack",
  stage: "alchemy-stage",
  id: "alchemy-id",
} as const;

const TAG_PREFIX = "alchemy::";

export const toLabelKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_LABEL_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

export const toTagKey = (labelKey: string): string =>
  labelKey.startsWith(ALCHEMY_LABEL_PREFIX)
    ? `${TAG_PREFIX}${labelKey.slice(ALCHEMY_LABEL_PREFIX.length)}`
    : labelKey;

export const sanitizeLabelValue = (value: string): string => {
  const cleaned = value
    .replaceAll("/", "__")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
    .slice(0, 63)
    .replace(/[^a-zA-Z0-9]+$/g, "")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "x";
};

export const toLabels = (
  tags: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [
      toLabelKey(key)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-"),
      sanitizeLabelValue(value),
    ]),
  );

export const fromLabels = (
  labels: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).map(([key, value]) => [toTagKey(key), value]),
  );

export const createInternalLabels = Effect.fn(function* (id: string) {
  return toLabels(yield* createInternalTags(id));
});

export const stripInternalLabels = (
  labels: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {}).filter(
      ([key]) => !key.startsWith(ALCHEMY_LABEL_PREFIX),
    ),
  );

export const hasAlchemyLabels = Effect.fn(function* (
  id: string,
  labels: Tags | undefined,
) {
  const expected = yield* createInternalLabels(id);
  return hasTags(expected, labels);
});

/**
 * Diff observed cloud labels against desired labels. Always pass
 * **observed** labels as `oldLabels` — never `olds.labels` or
 * `output.labels` — so adoption converges.
 */
export const diffLabels = diffTags;
