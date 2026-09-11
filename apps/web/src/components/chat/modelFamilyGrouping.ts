import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";

/**
 * The descriptor id used for the primary reasoning-effort select option.
 * Providers expose reasoning level through different descriptor ids (`effort`,
 * `reasoningEffort`, `variant`); the first select descriptor on a model's
 * capabilities is treated as the reasoning-level control, matching the
 * convention in {@link getComposerProviderState} and {@link TraitsPicker}.
 */
const REASONING_DESCRIPTOR_IDS = new Set([
  "effort",
  "reasoningEffort",
  "variant",
  "reasoning",
  "thinking",
]);

export interface ReasoningLevelOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ReasoningLevelDescriptor {
  readonly descriptorId: string;
  readonly label: string;
  readonly currentValue: string | null;
  readonly options: ReadonlyArray<ReasoningLevelOption>;
}

/**
 * Extract the reasoning-level select descriptor from a model's capabilities.
 * Returns the first select descriptor whose id is a known reasoning id, or
 * the first select descriptor overall when none match by id (preserving the
 * existing "primary select descriptor" convention). Returns `null` when the
 * model exposes no select options.
 */
export function getReasoningLevelDescriptor(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReasoningLevelDescriptor | null {
  const descriptors = getProviderOptionDescriptors({
    caps: input.caps,
    selections: input.selections,
  });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  if (selectDescriptors.length === 0) {
    return null;
  }
  const descriptor =
    selectDescriptors.find((candidate) => REASONING_DESCRIPTOR_IDS.has(candidate.id)) ??
    selectDescriptors[0]!;
  const currentValue = getProviderOptionCurrentValue(descriptor);
  return {
    descriptorId: descriptor.id,
    label: descriptor.label,
    currentValue: typeof currentValue === "string" ? currentValue : null,
    options: descriptor.options.map((option) => ({
      id: option.id,
      label: option.label,
      isDefault: Boolean(option.isDefault),
    })),
  };
}

/**
 * Read the current reasoning level value from a stored options array,
 * resolving against the descriptor's default when no explicit selection
 * exists. Returns `null` when the model has no reasoning descriptor.
 */
export function resolveReasoningLevel(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): string | null {
  const descriptor = getReasoningLevelDescriptor(input);
  return descriptor?.currentValue ?? null;
}

/**
 * Produce the next options array after changing the reasoning level, leaving
 * every other option untouched. Returns `undefined` when the model has no
 * reasoning descriptor (so callers can short-circuit).
 */
export function withReasoningLevelChange(input: {
  readonly caps: ModelCapabilities;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly nextValue: string;
}): ReadonlyArray<ProviderOptionSelection> | undefined {
  const descriptor = getReasoningLevelDescriptor({
    caps: input.caps,
    selections: input.selections,
  });
  if (!descriptor) {
    return undefined;
  }
  const existing = input.selections ?? [];
  const filtered = existing.filter((selection) => selection.id !== descriptor.descriptorId);
  return [...filtered, { id: descriptor.descriptorId, value: input.nextValue }];
}

/**
 * Derive a clean "family" display name from a model slug + provider. Strips
 * trailing reasoning-effort qualifiers (e.g. `-low`, `-high`, `:medium`) that
 * some providers append to variant slugs, then falls back to the raw name.
 */
export function getModelFamilyLabel(
  slug: string,
  provider: ProviderDriverKind,
  fallbackName?: string,
): string {
  const stripped = stripReasoningQualifier(slug);
  if (stripped.length > 0 && stripped !== slug) {
    return humanizeSlug(stripped);
  }
  if (fallbackName && fallbackName.length > 0) {
    return fallbackName;
  }
  return humanizeSlug(slug);
}

function stripReasoningQualifier(slug: string): string {
  return slug.replace(/[-_:](?:low|medium|minimal|high|max|extended|none)$/iu, "");
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

/**
 * Resolve the provider display name for a driver kind, using the canonical
 * contracts constant and falling back to a title-cased kind slug.
 */
export function getProviderGroupLabel(driverKind: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driverKind] ?? humanizeSlug(driverKind);
}

/**
 * Group a flat list of items by their provider (driver kind), preserving the
 * first-appearance order of providers. Each group keeps its items in their
 * original relative order. Used by the model picker to render provider logo
 * headers above each provider's models in favorites and search views.
 */
export function groupByProvider<T extends { readonly driverKind: ProviderDriverKind }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<{ readonly driverKind: ProviderDriverKind; readonly items: readonly T[] }> {
  const order: ProviderDriverKind[] = [];
  const buckets = new Map<ProviderDriverKind, T[]>();
  for (const item of items) {
    const bucket = buckets.get(item.driverKind);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(item.driverKind, [item]);
      order.push(item.driverKind);
    }
  }
  return order.map((driverKind) => ({
    driverKind,
    items: buckets.get(driverKind)!,
  }));
}

/**
 * Look up a model's capabilities by slug within an instance's model snapshot.
 * Returns an empty-capabilities object when the model is not found so callers
 * can treat the result uniformly.
 */
export function findModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  slug: string,
): ModelCapabilities {
  return (
    models.find((candidate) => candidate.slug === slug)?.capabilities ?? {
      optionDescriptors: [],
    }
  );
}

/**
 * Read the reasoning level for a model from its capabilities + stored
 * selections, returning the option label (e.g. "High") rather than the id.
 * Returns `null` when the model has no reasoning descriptor.
 */
export function resolveReasoningLevelLabel(input: {
  readonly caps: ModelCapabilities;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): string | null {
  const descriptor = getReasoningLevelDescriptor(input);
  if (!descriptor || !descriptor.currentValue) {
    return null;
  }
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.label ?? null;
}
