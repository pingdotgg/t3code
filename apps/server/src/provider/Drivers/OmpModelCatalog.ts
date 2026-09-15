/**
 * OmpModelCatalog — omp's own model metadata, mapped onto provider models.
 *
 * omp is a meta provider: its catalog is whatever the user configured inside
 * omp (built-ins plus `models.yml` entries), and each entry carries real
 * metadata. The ACP `model` config option only advertises `value`/`name`
 * pairs, so a catalog built from it cannot tell a 200,000-token model from a
 * 1,000,000-token one and cannot report a model's reasoning ladder before it
 * is selected. RPC mode can: `{"type":"get_available_models"}` answers with
 * every model's `contextWindow`, `maxTokens`, `input` modalities and
 * `thinking.efforts` (verified against omp/18.1.18, 121 entries).
 *
 * Two shapes are load-bearing and were verified live rather than assumed:
 *
 * - The ACP model select value is `<provider>/<id>`, not the bare `id` that
 *   `get_available_models` reports (`anthropic/claude-fable-5`). The slug must
 *   be the ACP value, because the adapter writes it back into the `model`
 *   config option.
 * - The ACP `thinking` select is `off`, `auto`, then the model's
 *   `thinking.efforts` in order — `off`/`auto` are added by omp and are not in
 *   the metadata. A model with `reasoning: false` advertises only `off`/`auto`
 *   (checked with `omp acp --model anthropic/claude-3-haiku-20240307`), i.e.
 *   no reasoning levels at all, so those models get no reasoning descriptor.
 *
 * Deliberately not carried over: `cost` (ACP `usage_update` already reports
 * omp's own computed turn cost, so per-token prices have no consumer),
 * `maxContextWindow`/`contextPromotionTarget` (omp's context-promotion
 * ceiling, which is not the window a turn is measured against), and the
 * `compat`/`identity`/`tokenizer` blocks (omp-internal request shaping).
 *
 * @module provider/Drivers/OmpModelCatalog
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

/** The single RPC request that answers the whole catalog. */
export const OMP_AVAILABLE_MODELS_REQUEST_ID = "t3-model-catalog";

/** The follow-up request that names omp's active model. */
export const OMP_STATE_REQUEST_ID = "t3-model-state";

/**
 * omp's thinking ladder, in ascending order, with the picker labels T3 uses.
 * `off`/`auto` are session-level values omp adds to every model's select;
 * the rest mirror `thinking.efforts`.
 */
const OMP_REASONING_LABELS: Record<string, string> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Normalize an omp thinking value onto the picker id T3 stores. omp's own
 * ladder is `off|minimal|low|medium|high|xhigh|max|auto`; ACP selects may
 * advertise aliases (`none`, `extra-high`) that must collapse onto one id so
 * the selection round-trips back to the raw advertised value.
 */
export function normalizeOmpReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "off":
    case "none":
      return "off";
    case "auto":
      return "auto";
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

/** `zhipu-coding-plan` → `Zhipu Coding Plan`, for upstream-provider labels. */
export function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

/**
 * Per-model facts omp reports that no `ServerProviderModel` or
 * `ModelCapabilities` field can hold. The context meter needs
 * {@link OmpModelMetadata.contextWindow}: it is the ceiling omp itself divides
 * by, and it differs 5x across one catalog (200,000 vs 1,000,000).
 */
export interface OmpModelMetadata {
  readonly slug: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** omp's `input` list: `text`, `image`, `audio`, … */
  readonly inputModalities: ReadonlyArray<string>;
  /** Normalized `thinking.efforts`; empty for a model omp reports as non-reasoning. */
  readonly reasoningEfforts: ReadonlyArray<string>;
}

export interface OmpModelCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly metadataBySlug: ReadonlyMap<string, OmpModelMetadata>;
}

export const EMPTY_OMP_MODEL_CATALOG: OmpModelCatalog = {
  models: [],
  metadataBySlug: new Map(),
};

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: Array<string> = [];
  for (const entry of value) {
    const trimmed = trimmedString(entry);
    if (trimmed.length > 0 && !items.includes(trimmed)) {
      items.push(trimmed);
    }
  }
  return items;
}

function reasoningEffortsFromThinking(model: Record<string, unknown>): ReadonlyArray<string> {
  if (model.reasoning !== true) {
    return [];
  }
  const thinking = model.thinking;
  if (typeof thinking !== "object" || thinking === null) {
    return [];
  }
  const efforts: Array<string> = [];
  for (const raw of stringList((thinking as Record<string, unknown>).efforts)) {
    // Unknown ladder values are dropped rather than offered: a value T3 cannot
    // normalize would be written back to omp as nothing at all, so the picker
    // must not present it as a choice.
    const normalized = normalizeOmpReasoningValue(raw);
    if (
      normalized &&
      normalized !== "off" &&
      normalized !== "auto" &&
      !efforts.includes(normalized)
    ) {
      efforts.push(normalized);
    }
  }
  return efforts;
}

/**
 * Build the picker capabilities for one omp model. The reasoning descriptor
 * mirrors the ACP `thinking` select omp will advertise once the model is
 * selected (`off`, `auto`, then the ladder), so every offered level is a level
 * omp accepts. A model with no ladder gets no descriptor: omp offers it only
 * `off`/`auto`, which is not a reasoning choice.
 */
export function buildOmpModelCapabilities(input: {
  readonly reasoningEfforts: ReadonlyArray<string>;
  readonly defaultLevel?: string | undefined;
}): ModelCapabilities {
  if (input.reasoningEfforts.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  const defaultLevel = normalizeOmpReasoningValue(input.defaultLevel);
  const values = ["off", "auto", ...input.reasoningEfforts];
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: "Thinking",
        options: values.map((value) => ({
          value,
          label: OMP_REASONING_LABELS[value] ?? titleCaseSlug(value),
          ...(value === defaultLevel ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

/**
 * Fold raw `get_available_models` entries into provider models plus the
 * metadata T3's contracts have no field for. Entries are keyed by the ACP
 * slug (`<provider>/<id>`) and sorted by display name: the catalog is 121
 * entries deep on a default install.
 */
export function catalogFromOmpModelEntries(
  entries: ReadonlyArray<unknown>,
  activeSlug?: string | undefined,
): OmpModelCatalog {
  const models: Array<ServerProviderModel> = [];
  const metadataBySlug = new Map<string, OmpModelMetadata>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as Record<string, unknown>;
    const id = trimmedString(model.id);
    if (id.length === 0) continue;
    const provider = trimmedString(model.provider);
    const slug = provider.length > 0 ? `${provider}/${id}` : id;
    if (metadataBySlug.has(slug)) continue;
    const reasoningEfforts = reasoningEffortsFromThinking(model);
    const thinking = (
      typeof model.thinking === "object" && model.thinking !== null ? model.thinking : {}
    ) as Record<string, unknown>;
    const contextWindow = positiveInteger(model.contextWindow);
    const maxTokens = positiveInteger(model.maxTokens);
    metadataBySlug.set(slug, {
      slug,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      inputModalities: stringList(model.input),
      reasoningEfforts,
    });
    models.push({
      slug,
      name: trimmedString(model.name) || slug,
      ...(provider.length > 0 ? { subProvider: titleCaseSlug(provider) } : {}),
      isCustom: false,
      // Without a default the client cannot resolve a model for a fresh
      // thread, and an unresolved model takes the composer's whole traits
      // control with it — the thinking ladder included.
      ...(activeSlug !== undefined && slug === activeSlug ? { isDefault: true } : {}),
      capabilities: buildOmpModelCapabilities({
        reasoningEfforts,
        defaultLevel: trimmedString(thinking.defaultLevel) || undefined,
      }),
    });
  }
  return {
    models: models.toSorted((left, right) => left.name.localeCompare(right.name)),
    metadataBySlug,
  };
}

function modelEntriesFromFrame(frame: Record<string, unknown>): ReadonlyArray<unknown> {
  if (frame.type !== "response" || frame.command !== "get_available_models") {
    return [];
  }
  const models = (frame.data as Record<string, unknown> | undefined)?.models;
  return Array.isArray(models) ? models : [];
}

/**
 * The slug omp has selected, read from a `get_state` response. omp reports
 * the model as `{ provider, id }`, which is the same pair the ACP `model`
 * select advertises as `<provider>/<id>`.
 */
function activeSlugFromFrame(frame: Record<string, unknown>): string | undefined {
  if (frame.type !== "response" || frame.command !== "get_state") {
    return undefined;
  }
  const model = (frame.data as Record<string, unknown> | undefined)?.model;
  if (typeof model !== "object" || model === null) return undefined;
  const record = model as Record<string, unknown>;
  const id = trimmedString(record.id);
  if (id.length === 0) return undefined;
  const provider = trimmedString(record.provider);
  return provider.length > 0 ? `${provider}/${id}` : id;
}

/**
 * Read the `get_available_models` response out of an RPC JSONL transcript.
 * Frames that are not that response (`ready`, `available_commands_update`,
 * `extension_ui_request`) are skipped, so the same transcript can also feed
 * the command catalog.
 */
export function decodeOmpModelCatalog(stdout: string): OmpModelCatalog {
  const entries: Array<unknown> = [];
  let activeSlug: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    const record = frame as Record<string, unknown>;
    activeSlug = activeSlugFromFrame(record) ?? activeSlug;
    for (const entry of modelEntriesFromFrame(record)) {
      entries.push(entry);
    }
  }
  return catalogFromOmpModelEntries(entries, activeSlug);
}
