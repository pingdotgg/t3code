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
 *   per-base rows with `effort` / `speed` / `context` option descriptors.
 * - `resolveDevinModelUid` turns `{ model: <base>, options }` back into a
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

function effortChoice(effort: string, isDefault: boolean): ProviderOptionChoice {
  return {
    id: effort,
    label: EFFORT_LABELS[effort] ?? effort,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

/**
 * One row per (family, base) group. Variants sharing a base become option
 * descriptor choices: bare variants contribute a "Default" effort choice,
 * `-fast`/`-priority` a Speed select, and `-1m` a Context select. Variant
 * uids land in `aliases` so stored flat selections like `swe-2-high` still
 * resolve to the grouped row.
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
    const familyAliases = (family.aliases ?? []).filter(
      (alias): alias is string => typeof alias === "string" && alias.trim().length > 0,
    );

    // Group variants by parsed base; several bases in one family (e.g.
    // MODEL_PRIVATE_* under claude-sonnet-4.5) are genuinely distinct models.
    const groups = new Map<
      string,
      {
        uids: Array<string>;
        dims: Array<DevinModelDims>;
        label: string | undefined;
        isNew: boolean;
      }
    >();
    for (const variant of family.variants ?? []) {
      const uid = typeof variant.model_uid === "string" ? variant.model_uid.trim() : "";
      if (!uid) continue;
      const dims = parseDevinModelUid(uid);
      const variantLabel =
        typeof variant.label === "string" && variant.label.trim()
          ? variant.label.trim()
          : undefined;
      const group = groups.get(dims.base);
      if (group) {
        group.uids.push(uid);
        group.dims.push(dims);
        group.isNew ||= variant.is_new === true;
      } else {
        groups.set(dims.base, {
          uids: [uid],
          dims: [dims],
          label: variantLabel,
          isNew: variant.is_new === true,
        });
      }
    }

    for (const [base, group] of groups) {
      if (seenSlugs.has(base)) continue;
      seenSlugs.add(base);

      const efforts = new Set<string>();
      const speeds = new Set<string>();
      const contexts = new Set<string>();
      for (const dims of group.dims) {
        if (dims.effort) efforts.add(dims.effort);
        if (dims.speed) speeds.add(dims.speed);
        if (dims.context) contexts.add(dims.context);
      }
      const hasBare = group.dims.some(
        (dims) =>
          dims.effort === undefined && dims.speed === undefined && dims.context === undefined,
      );

      const optionDescriptors: Array<{
        id: string;
        label: string;
        type: "select";
        options: Array<ProviderOptionChoice>;
      }> = [];

      if (efforts.size > 0 || hasBare) {
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
        const hasStandard = group.dims.some((dims) => dims.speed === undefined);
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
        const hasStandard = group.dims.some((dims) => dims.context === undefined);
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

      models.push({
        slug: base,
        name:
          groups.size === 1
            ? (familyLabel ?? group.label ?? base)
            : (group.label ?? familyLabel ?? base),
        ...(familyAliases.length > 0 || group.uids.length > 1
          ? { aliases: [...familyAliases, ...group.uids.filter((uid) => uid !== base)] }
          : {}),
        ...(group.isNew ? { badge: "new" as const } : {}),
        isCustom: false,
        isDefault: base === DEVIN_DEFAULT_MODEL_SLUG,
        capabilities: optionDescriptors.length > 0 ? { optionDescriptors } : null,
      });
    }
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
