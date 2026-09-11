/**
 * devinModelCatalog — pure parsing/grouping helpers for Devin's model surface.
 *
 * Devin's CLI encodes reasoning effort, speed tier, and context window in the
 * model uid itself (`claude-opus-5-high-fast`, `glm-5-2-max-1m`,
 * `MODEL_GPT_5_2_LOW`). The picker should still present one row per family
 * with option descriptors, matching how Codex/Claude expose effort and fast
 * mode. This module owns both directions:
 *
 * - `devinModelsFromCatalog` groups `devin models list --format json` into
 *   per-family rows with `effort` / `speed` / `context` option descriptors.
 * - `resolveDevinModelUid` turns `{ model: <family>, options }` back into a
 *   concrete advertised uid for `session/set_config_option`.
 *
 * @module devinModelCatalog
 */
import type {
  ProviderOptionChoice,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";

// ── uid suffix grammar ───────────────────────────────────────────────────
//
// Wire order is <base>-<effort>[-<speed>][-<context>]; separators may be `-`
// or `_` (`MODEL_GPT_5_2_LOW`). Suffixes strip right-to-left: context, then
// speed, then effort.

const EFFORT_TOKENS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
]);
const SPEED_TOKENS = new Set(["fast", "priority"]);
const CONTEXT_TOKENS = new Set(["1m"]);

export interface DevinModelDims {
  /** Normalized base id (lowercase, `-` separators). */
  readonly base: string;
  readonly effort: string | undefined;
  readonly speed: string | undefined;
  readonly context: string | undefined;
}

export function normalizeDevinModelId(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

export function parseDevinModelUid(uid: string): DevinModelDims {
  const tokens = normalizeDevinModelId(uid).split("-").filter(Boolean);
  let effort: string | undefined;
  let speed: string | undefined;
  let context: string | undefined;
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (context === undefined && CONTEXT_TOKENS.has(last)) {
      context = last;
      tokens.pop();
      continue;
    }
    if (speed === undefined && SPEED_TOKENS.has(last)) {
      speed = last;
      tokens.pop();
      continue;
    }
    if (effort === undefined && EFFORT_TOKENS.has(last)) {
      effort = last;
      tokens.pop();
      continue;
    }
    break;
  }
  return { base: tokens.join("-"), effort, speed, context };
}

// ── picker rows ──────────────────────────────────────────────────────────

export const DEVIN_EFFORT_OPTION_ID = "effort";
export const DEVIN_SPEED_OPTION_ID = "speed";
export const DEVIN_CONTEXT_OPTION_ID = "context";

/** Selection values that mean "the provider default" for an axis. */
const DEFAULT_EFFORT_VALUE = "default";
const STANDARD_SPEED_VALUE = "standard";
const STANDARD_CONTEXT_VALUE = "200k";

const EFFORT_ORDER = [
  DEFAULT_EFFORT_VALUE,
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
] as const;

const EFFORT_LABELS: Record<string, string> = {
  [DEFAULT_EFFORT_VALUE]: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  thinking: "Thinking",
};

const SPEED_LABELS: Record<string, string> = {
  [STANDARD_SPEED_VALUE]: "Standard",
  fast: "Fast",
  priority: "Priority",
};

const CONTEXT_LABELS: Record<string, string> = {
  [STANDARD_CONTEXT_VALUE]: "Standard",
  "1m": "1M",
};

interface DevinModelVariant {
  readonly model_uid: string;
  readonly label?: string;
  readonly is_new?: boolean;
  readonly is_beta?: boolean;
}

interface DevinModelFamily {
  readonly family_uid?: string;
  readonly family_label?: string;
  readonly slug?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly variants?: ReadonlyArray<DevinModelVariant>;
}

export interface DevinModelsListJson {
  readonly families?: ReadonlyArray<DevinModelFamily>;
}

/** `adaptive` is Devin's recommended auto-router and the picker default. */
const DEVIN_DEFAULT_MODEL_SLUG = "adaptive";

interface ParsedVariant {
  readonly uid: string;
  readonly label: string | undefined;
  readonly dims: DevinModelDims;
  readonly isNew: boolean;
}

function effortRank(effort: string): number {
  const index = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  return index === -1 ? EFFORT_ORDER.length : index;
}

/**
 * Label-derived dims for families whose variant uids are opaque
 * (`MODEL_PRIVATE_*`): the variant label minus the family label carries the
 * effort words — "GPT-5.1 Low Thinking" → `low`, "… No Thinking" → `none`,
 * "… Thinking" → `thinking`. Returns `undefined` when the label does not
 * extend the family label so callers fall back to uid parsing.
 */
export function parseDevinVariantLabel(
  familyLabel: string | undefined,
  variantLabel: string | undefined,
): DevinModelDims | undefined {
  if (!familyLabel || !variantLabel) return undefined;
  const trimmedFamily = familyLabel.trim();
  const trimmedVariant = variantLabel.trim();
  if (
    !trimmedVariant.toLowerCase().startsWith(trimmedFamily.toLowerCase()) ||
    trimmedVariant.length === trimmedFamily.length
  ) {
    return undefined;
  }
  let rest = trimmedVariant.slice(trimmedFamily.length).trim().toLowerCase();

  let context: string | undefined;
  let speed: string | undefined;
  for (const token of rest.split(/\s+/).reverse()) {
    if (context === undefined && CONTEXT_TOKENS.has(token)) {
      context = token;
      rest = rest.slice(0, rest.length - token.length).trim();
      continue;
    }
    if (speed === undefined && SPEED_TOKENS.has(token)) {
      speed = token;
      rest = rest.slice(0, rest.length - token.length).trim();
      continue;
    }
    break;
  }

  let effort: string | undefined;
  if (rest === "no thinking") {
    effort = "none";
  } else if (rest === "thinking") {
    effort = "thinking";
  } else {
    const stripped = rest.replace(/\s*thinking$/, "");
    if (stripped !== rest && EFFORT_TOKENS.has(stripped)) {
      effort = stripped;
    } else if (EFFORT_TOKENS.has(rest)) {
      effort = rest;
    }
  }
  return { base: "", effort, speed, context };
}

function effortChoice(effort: string, isDefault: boolean): ProviderOptionChoice {
  return {
    id: effort,
    label: EFFORT_LABELS[effort] ?? effort,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

/**
 * One row per family. Variants sharing a uid base become `effort`/`speed`/
 * `context` option descriptors (token-valued choices resolved by dims match);
 * families whose uids share no base (`MODEL_PRIVATE_*` under gpt-5.1) emit a
 * single effort select whose choices carry the concrete uid, which
 * `resolveDevinModelUid` passes through. Variant uids land in `aliases` so
 * stored flat selections like `swe-2-high` still resolve to the family row.
 */
export function devinModelsFromCatalog(
  parsed: DevinModelsListJson | undefined,
): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seenSlugs = new Set<string>();

  for (const family of parsed?.families ?? []) {
    const familyLabel =
      typeof family.family_label === "string" && family.family_label.trim()
        ? family.family_label.trim()
        : undefined;
    const familySlug = typeof family.slug === "string" ? family.slug.trim() : "";
    const familyAliases = [
      ...(family.aliases ?? []).filter(
        (alias): alias is string => typeof alias === "string" && alias.trim().length > 0,
      ),
      ...(familySlug ? [familySlug] : []),
    ];

    const variants: Array<ParsedVariant> = [];
    for (const variant of family.variants ?? []) {
      const uid = typeof variant.model_uid === "string" ? variant.model_uid.trim() : "";
      if (!uid) continue;
      const label =
        typeof variant.label === "string" && variant.label.trim()
          ? variant.label.trim()
          : undefined;
      variants.push({ uid, label, dims: parseDevinModelUid(uid), isNew: variant.is_new === true });
    }
    if (variants.length === 0) continue;

    const distinctBases = new Set(variants.map((variant) => variant.dims.base));
    const isNew = variants.some((variant) => variant.isNew);
    const optionDescriptors: Array<{
      id: string;
      label: string;
      type: "select";
      options: Array<ProviderOptionChoice>;
    }> = [];
    let slug: string;

    if (distinctBases.size <= 1) {
      // Shared uid base — multi-axis dims from uid suffixes.
      slug = variants[0]!.dims.base;
      const efforts = new Set<string>();
      const speeds = new Set<string>();
      const contexts = new Set<string>();
      for (const variant of variants) {
        if (variant.dims.effort) efforts.add(variant.dims.effort);
        if (variant.dims.speed) speeds.add(variant.dims.speed);
        if (variant.dims.context) contexts.add(variant.dims.context);
      }
      const hasBare = variants.some(
        (variant) =>
          variant.dims.effort === undefined &&
          variant.dims.speed === undefined &&
          variant.dims.context === undefined,
      );

      if (efforts.size > 0 || (hasBare && variants.length > 1)) {
        const options: Array<ProviderOptionChoice> = [];
        if (hasBare) {
          options.push(effortChoice(DEFAULT_EFFORT_VALUE, true));
        }
        for (const effort of EFFORT_ORDER) {
          if (effort === DEFAULT_EFFORT_VALUE || !efforts.has(effort)) continue;
          options.push(effortChoice(effort, false));
        }
        if (options.length > 1) {
          optionDescriptors.push({
            id: DEVIN_EFFORT_OPTION_ID,
            label: "Reasoning",
            type: "select",
            options,
          });
        }
      }

      if (speeds.size > 0) {
        const options: Array<ProviderOptionChoice> = [];
        const hasStandard = variants.some((variant) => variant.dims.speed === undefined);
        if (hasStandard) {
          options.push({
            id: STANDARD_SPEED_VALUE,
            label: SPEED_LABELS[STANDARD_SPEED_VALUE]!,
            isDefault: true,
          });
        }
        for (const speed of ["fast", "priority"]) {
          if (!speeds.has(speed)) continue;
          options.push({
            id: speed,
            label: SPEED_LABELS[speed]!,
            ...(hasStandard ? {} : { isDefault: true }),
          });
        }
        if (options.length > 1) {
          optionDescriptors.push({
            id: DEVIN_SPEED_OPTION_ID,
            label: "Speed",
            type: "select",
            options,
          });
        }
      }

      if (contexts.size > 0) {
        const options: Array<ProviderOptionChoice> = [];
        const hasStandard = variants.some((variant) => variant.dims.context === undefined);
        if (hasStandard) {
          options.push({
            id: STANDARD_CONTEXT_VALUE,
            label: CONTEXT_LABELS[STANDARD_CONTEXT_VALUE]!,
            isDefault: true,
          });
        }
        for (const context of ["1m"]) {
          if (!contexts.has(context)) continue;
          options.push({
            id: context,
            label: CONTEXT_LABELS[context]!,
            ...(hasStandard ? {} : { isDefault: true }),
          });
        }
        if (options.length > 1) {
          optionDescriptors.push({
            id: DEVIN_CONTEXT_OPTION_ID,
            label: "Context",
            type: "select",
            options,
          });
        }
      }
    } else {
      // Opaque uids — one effort select with uid-valued choices, ordered by
      // effort rank. `resolveDevinModelUid` passes a uid-valued selection
      // straight through, so no shared base is needed.
      const byVariant = variants.map((variant) => ({
        ...variant,
        labelDims: parseDevinVariantLabel(familyLabel, variant.label),
      }));
      const isBare = (variant: (typeof byVariant)[number]) =>
        variant.labelDims?.effort === undefined &&
        variant.labelDims?.speed === undefined &&
        variant.labelDims?.context === undefined;
      const defaultVariant =
        byVariant.find(isBare) ??
        byVariant.find((variant) => variant.labelDims?.effort === "medium") ??
        byVariant[0]!;
      slug = defaultVariant.uid;

      const options = byVariant
        .toSorted(
          (left, right) =>
            effortRank(left.labelDims?.effort ?? DEFAULT_EFFORT_VALUE) -
            effortRank(right.labelDims?.effort ?? DEFAULT_EFFORT_VALUE),
        )
        .map((variant) => {
          const suffix =
            familyLabel &&
            variant.label !== undefined &&
            variant.label.toLowerCase().startsWith(familyLabel.toLowerCase())
              ? variant.label.slice(familyLabel.length).trim()
              : "";
          return {
            id: variant.uid,
            label:
              suffix !== ""
                ? suffix
                : EFFORT_LABELS[variant.labelDims?.effort ?? DEFAULT_EFFORT_VALUE]!,
            ...(variant.uid === defaultVariant.uid ? { isDefault: true } : {}),
          };
        });
      if (options.length > 1) {
        optionDescriptors.push({
          id: DEVIN_EFFORT_OPTION_ID,
          label: "Reasoning",
          type: "select",
          options,
        });
      }
    }

    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    const aliases = [...familyAliases, ...variants.map((variant) => variant.uid)].filter(
      (alias) => alias !== slug,
    );
    models.push({
      slug,
      name: familyLabel ?? slug,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(isNew ? { badge: "new" as const } : {}),
      isCustom: false,
      isDefault:
        slug === DEVIN_DEFAULT_MODEL_SLUG ||
        variants.some((v) => v.uid === DEVIN_DEFAULT_MODEL_SLUG),
      capabilities: optionDescriptors.length > 0 ? { optionDescriptors } : null,
    });
  }
  return models;
}

// ── selection → concrete uid ─────────────────────────────────────────────

const DEVIN_DIM_OPTION_IDS = new Set([
  DEVIN_EFFORT_OPTION_ID,
  DEVIN_SPEED_OPTION_ID,
  DEVIN_CONTEXT_OPTION_ID,
]);

/** Option ids that fold into the model uid rather than a config option. */
export function isDevinModelDimOptionId(id: string): boolean {
  return DEVIN_DIM_OPTION_IDS.has(id);
}

function wantedDims(selections: ReadonlyArray<ProviderOptionSelection> | null | undefined): {
  effort: string | undefined;
  speed: string | undefined;
  context: string | undefined;
  hasAny: boolean;
} {
  let effort: string | undefined;
  let speed: string | undefined;
  let context: string | undefined;
  for (const selection of selections ?? []) {
    if (selection.id === DEVIN_EFFORT_OPTION_ID && typeof selection.value === "string") {
      effort = selection.value === DEFAULT_EFFORT_VALUE ? undefined : selection.value;
    } else if (selection.id === DEVIN_SPEED_OPTION_ID && typeof selection.value === "string") {
      speed = selection.value === STANDARD_SPEED_VALUE ? undefined : selection.value;
    } else if (selection.id === DEVIN_CONTEXT_OPTION_ID && typeof selection.value === "string") {
      context = selection.value === STANDARD_CONTEXT_VALUE ? undefined : selection.value;
    }
  }
  return {
    effort,
    speed,
    context,
    hasAny: effort !== undefined || speed !== undefined || context !== undefined,
  };
}

/**
 * Resolve a grouped selection (`model` = base id + effort/speed/context
 * options) to a concrete advertised uid. Resolution matches on parsed dims
 * rather than string composition so irregular uids (`MODEL_GPT_5_2_LOW`,
 * `claude-5-fable-*`) still land. Exact uid matches and unknown models pass
 * through untouched.
 */
export function resolveDevinModelUid(input: {
  readonly model: string;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly advertisedValues: ReadonlyArray<string>;
  readonly currentValue?: string | undefined;
}): string {
  const model = input.model.trim();
  if (!model) return model;

  // Opaque families (no shared uid base, e.g. `MODEL_PRIVATE_*`) put the
  // concrete uid in the dim choice id — a selection that is itself an
  // advertised value wins outright.
  const direct = (input.selections ?? []).find(
    (selection) =>
      isDevinModelDimOptionId(selection.id) &&
      typeof selection.value === "string" &&
      input.advertisedValues.includes(selection.value),
  );
  if (direct) return direct.value as string;

  const wanted = wantedDims(input.selections);
  // A base id like `swe-1-7` is often *also* an advertised uid (the family's
  // default-effort variant), so the exact-match pass-through only applies
  // when no dims were selected — otherwise the dims must drive resolution.
  if (!wanted.hasAny && input.advertisedValues.includes(model)) return model;

  const wantedBase = normalizeDevinModelId(model);
  const candidates = input.advertisedValues.filter(
    (uid) => parseDevinModelUid(uid).base === wantedBase,
  );
  if (candidates.length === 0) return model;

  if (!wanted.hasAny) {
    // No dims selected: keep the session's current value when it already
    // belongs to this family, else the bare variant, else first advertised.
    if (input.currentValue && candidates.includes(input.currentValue)) {
      return input.currentValue;
    }
    const bare = candidates.find((uid) => {
      const dims = parseDevinModelUid(uid);
      return dims.effort === undefined && dims.speed === undefined && dims.context === undefined;
    });
    return bare ?? candidates[0]!;
  }

  const strict = candidates.find((uid) => {
    const dims = parseDevinModelUid(uid);
    return (
      dims.effort === wanted.effort &&
      dims.speed === wanted.speed &&
      dims.context === wanted.context
    );
  });
  if (strict) return strict;

  // Relax: drop context, then speed, then accept the bare variant, then
  // first advertised — never fail the turn over a missing variant.
  const withoutContext = candidates.find((uid) => {
    const dims = parseDevinModelUid(uid);
    return dims.effort === wanted.effort && dims.speed === wanted.speed;
  });
  if (withoutContext) return withoutContext;
  const effortOnly = candidates.find((uid) => parseDevinModelUid(uid).effort === wanted.effort);
  if (effortOnly) return effortOnly;
  const bare = candidates.find((uid) => {
    const dims = parseDevinModelUid(uid);
    return dims.effort === undefined && dims.speed === undefined && dims.context === undefined;
  });
  return bare ?? candidates[0]!;
}
