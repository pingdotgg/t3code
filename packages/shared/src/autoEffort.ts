/**
 * Auto reasoning effort: shared, provider-agnostic logic.
 *
 * Providers expose reasoning effort as a `select` provider option
 * (`reasoningEffort` for Codex, `effort` for Claude, `reasoning` for Cursor).
 * Auto effort adds one synthetic `auto` choice to that select plus two limits —
 * a maximum and a minimum — so the user delegates the per-prompt decision to a
 * reviewer model while keeping a hard spend limit.
 *
 * Everything here is pure so the server (resolving a turn's effort), the web
 * composer, and the mobile composer share one definition of the effort ladder,
 * the bounds, and the clamping rules.
 *
 * @module autoEffort
 */
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionChoice,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  SelectProviderOptionDescriptor,
} from "@t3tools/contracts";

import {
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
} from "./model.ts";

/** Synthetic effort value that delegates the choice to the reviewer model. */
export const AUTO_EFFORT_VALUE = "auto";

export const AUTO_EFFORT_LABEL = "Auto";

/** Option id suffixes for the auto-effort limits derived from an effort select. */
const CEILING_SUFFIX = "AutoCeiling";
const FLOOR_SUFFIX = "AutoFloor";

/**
 * Provider option ids that carry reasoning effort. Auto effort is offered for
 * these and only these, so unrelated selects (service tier, context window,
 * agent) keep their plain behavior.
 */
const EFFORT_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
]);

/**
 * Canonical ordering of known effort values, cheapest first. Providers list
 * their efforts in arbitrary order, and the ceiling/floor comparison needs a
 * total order, so unknown values sort after all known ones by declaration
 * order.
 */
const EFFORT_RANKS: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
  ultracode: 8,
};

const UNKNOWN_EFFORT_RANK_BASE = 100;

export interface AutoEffortBounds {
  /** Highest effort the reviewer may pick. */
  readonly ceiling: string;
  /** Lowest effort the reviewer may pick. */
  readonly floor: string;
}

export interface AutoEffortState extends AutoEffortBounds {
  /** Id of the provider's effort select (e.g. `reasoningEffort`). */
  readonly descriptorId: string;
  /** Label of the provider's effort select (e.g. `Reasoning`). */
  readonly descriptorLabel: string;
  /** True when the effort select is currently set to `auto`. */
  readonly active: boolean;
  /** Selectable efforts, cheapest first, with prompt-injected values removed. */
  readonly ladder: ReadonlyArray<ProviderOptionChoice>;
  /** Effort to use when the reviewer is unavailable or returns nonsense. */
  readonly fallback: string;
}

export function autoEffortCeilingOptionId(descriptorId: string): string {
  return `${descriptorId}${CEILING_SUFFIX}`;
}

export function autoEffortFloorOptionId(descriptorId: string): string {
  return `${descriptorId}${FLOOR_SUFFIX}`;
}

export function isAutoEffortBoundOptionId(optionId: string): boolean {
  return optionId.endsWith(CEILING_SUFFIX) || optionId.endsWith(FLOOR_SUFFIX);
}

export function isEffortOptionDescriptor(
  descriptor: ProviderOptionDescriptor | null | undefined,
): descriptor is SelectProviderOptionDescriptor {
  return (
    descriptor !== null &&
    descriptor !== undefined &&
    descriptor.type === "select" &&
    EFFORT_DESCRIPTOR_IDS.has(descriptor.id)
  );
}

function effortRank(optionId: string, declarationIndex: number): number {
  return EFFORT_RANKS[optionId] ?? UNKNOWN_EFFORT_RANK_BASE + declarationIndex;
}

/**
 * Selectable efforts for a descriptor, cheapest first.
 *
 * Prompt-injected values (Claude's `ultrathink`) are excluded: they are applied
 * by rewriting the prompt text rather than by sending an option, so the
 * reviewer must not be able to pick them.
 */
export function autoEffortLadder(
  descriptor: SelectProviderOptionDescriptor,
): ReadonlyArray<ProviderOptionChoice> {
  const promptInjected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.id !== AUTO_EFFORT_VALUE && !promptInjected.has(option.id))
    .sort((left, right) => {
      const delta =
        effortRank(left.option.id, left.index) - effortRank(right.option.id, right.index);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map(({ option }) => option);
}

function isLadderRankAtMost(
  ladder: ReadonlyArray<ProviderOptionChoice>,
  candidate: string,
  limit: string,
): boolean {
  return ladderIndex(ladder, candidate) <= ladderIndex(ladder, limit);
}

function ladderIndex(ladder: ReadonlyArray<ProviderOptionChoice>, optionId: string): number {
  return ladder.findIndex((option) => option.id === optionId);
}

function defaultCeiling(
  descriptor: SelectProviderOptionDescriptor,
  ladder: ReadonlyArray<ProviderOptionChoice>,
): string | undefined {
  // The model's own default is the token-safe ceiling: turning Auto on can then
  // only spend less than a manual default-effort turn until the user raises it.
  const providerDefault = providerDefaultEffort(descriptor);
  if (providerDefault && ladderIndex(ladder, providerDefault) >= 0) {
    return providerDefault;
  }
  return ladder.at(-1)?.id;
}

function resolveBoundValue(input: {
  readonly ladder: ReadonlyArray<ProviderOptionChoice>;
  readonly raw: string | undefined;
  readonly fallback: string | undefined;
}): string | undefined {
  const raw = input.raw?.trim();
  if (raw && ladderIndex(input.ladder, raw) >= 0) {
    return raw;
  }
  return input.fallback;
}

/**
 * Ceiling/floor for one effort descriptor, resolved from stored selections and
 * ordered so the ceiling is never below the floor.
 */
export function resolveAutoEffortBounds(input: {
  readonly descriptor: SelectProviderOptionDescriptor;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): AutoEffortBounds | null {
  const ladder = autoEffortLadder(input.descriptor);
  if (ladder.length === 0) {
    return null;
  }
  const ceiling = resolveBoundValue({
    ladder,
    raw: getProviderOptionStringSelectionValue(
      input.selections,
      autoEffortCeilingOptionId(input.descriptor.id),
    ),
    fallback: defaultCeiling(input.descriptor, ladder),
  });
  const floor = resolveBoundValue({
    ladder,
    raw: getProviderOptionStringSelectionValue(
      input.selections,
      autoEffortFloorOptionId(input.descriptor.id),
    ),
    fallback: ladder[0]?.id,
  });
  if (!ceiling || !floor) {
    return null;
  }
  // A floor above the ceiling is user error, not a reason to fail: treat the
  // pair as an unordered range so the reviewer still gets a usable window.
  return isLadderRankAtMost(ladder, floor, ceiling)
    ? { ceiling, floor }
    : { ceiling: floor, floor: ceiling };
}

/** Clamp any candidate effort into the configured window. */
export function clampAutoEffort(
  state: Pick<AutoEffortState, "ladder" | "ceiling" | "floor">,
  candidate: string | null | undefined,
): string {
  const trimmed = candidate?.trim();
  const index = trimmed ? ladderIndex(state.ladder, trimmed) : -1;
  const ceilingIndex = ladderIndex(state.ladder, state.ceiling);
  const floorIndex = ladderIndex(state.ladder, state.floor);
  if (index < 0) {
    return state.ceiling;
  }
  if (index > ceilingIndex) {
    return state.ceiling;
  }
  if (index < floorIndex) {
    return state.floor;
  }
  return trimmed as string;
}

function effortDescriptorFrom(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): SelectProviderOptionDescriptor | undefined {
  return descriptors.find(isEffortOptionDescriptor);
}

/**
 * Full auto-effort state for a capability set, or `null` when the model has no
 * effort select (nothing to automate).
 */
export function resolveAutoEffortState(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): AutoEffortState | null {
  if (!input.caps) {
    return null;
  }
  const descriptor = effortDescriptorFrom(input.caps.optionDescriptors ?? []);
  if (!descriptor) {
    return null;
  }
  const ladder = autoEffortLadder(descriptor);
  // A single rung leaves nothing for the reviewer to decide between.
  if (ladder.length < 2) {
    return null;
  }
  const bounds = resolveAutoEffortBounds({ descriptor, selections: input.selections });
  if (!bounds) {
    return null;
  }
  const active =
    getProviderOptionStringSelectionValue(input.selections, descriptor.id) === AUTO_EFFORT_VALUE;

  return {
    descriptorId: descriptor.id,
    descriptorLabel: descriptor.label,
    active,
    ladder,
    ...bounds,
    // The provider's own default is the fallback; it is clamped so a reviewer
    // outage can never spend above the ceiling.
    fallback: clampAutoEffort({ ladder, ...bounds }, providerDefaultEffort(descriptor)),
  };
}

/** The effort the provider itself defaults to, when it advertises one. */
function providerDefaultEffort(descriptor: SelectProviderOptionDescriptor): string | undefined {
  return descriptor.options.find((option) => option.isDefault)?.id;
}

/**
 * Efforts inside the configured window, cheapest first. This is what the
 * reviewer is allowed to choose from.
 */
export function autoEffortAllowedChoices(
  state: Pick<AutoEffortState, "ladder" | "ceiling" | "floor">,
): ReadonlyArray<ProviderOptionChoice> {
  const floorIndex = ladderIndex(state.ladder, state.floor);
  const ceilingIndex = ladderIndex(state.ladder, state.ceiling);
  if (floorIndex < 0 || ceilingIndex < 0) {
    return state.ladder;
  }
  return state.ladder.slice(floorIndex, ceilingIndex + 1);
}

export function isAutoEffortActive(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): boolean {
  return resolveAutoEffortState(input)?.active === true;
}

/**
 * `auto` is a T3 Code concept; no provider CLI understands it. Read effort
 * values through this so a stale or unresolved `auto` degrades to "provider
 * default" instead of being forwarded verbatim.
 */
export function withoutAutoEffortValue(value: string | undefined): string | undefined {
  return value === AUTO_EFFORT_VALUE ? undefined : value;
}

function augmentEffortDescriptor(
  descriptor: SelectProviderOptionDescriptor,
): SelectProviderOptionDescriptor {
  return {
    ...descriptor,
    options: [
      {
        id: AUTO_EFFORT_VALUE,
        label: AUTO_EFFORT_LABEL,
        description: "A reviewer model picks the effort for each prompt, within your limits.",
      },
      ...descriptor.options,
    ],
  };
}

function buildBoundDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly ladder: ReadonlyArray<ProviderOptionChoice>;
  readonly defaultValue: string;
}): SelectProviderOptionDescriptor {
  return {
    id: input.id,
    label: input.label,
    type: "select",
    options: input.ladder.map((option) =>
      option.id === input.defaultValue
        ? { id: option.id, label: option.label, isDefault: true }
        : { id: option.id, label: option.label },
    ),
  };
}

/**
 * Capabilities with the synthetic auto choice folded into the effort select,
 * and optionally with its two bound selects appended.
 *
 * The bounds are conditional so a user who never touches auto effort does not
 * accumulate ceiling/floor selections in every stored model selection.
 */
export function withAutoEffortCapabilities(
  caps: ModelCapabilities | null | undefined,
  options?: { readonly includeBounds?: boolean },
): ModelCapabilities | null | undefined {
  if (!caps) {
    return caps;
  }
  const descriptors = caps.optionDescriptors ?? [];
  const descriptor = effortDescriptorFrom(descriptors);
  if (!descriptor) {
    return caps;
  }
  const ladder = autoEffortLadder(descriptor);
  if (ladder.length < 2) {
    return caps;
  }
  const ceiling = defaultCeiling(descriptor, ladder) ?? ladder[ladder.length - 1]!.id;
  const floor = ladder[0]!.id;
  const boundDescriptors =
    options?.includeBounds === true
      ? [
          buildBoundDescriptor({
            id: autoEffortFloorOptionId(descriptor.id),
            label: "Minimum",
            ladder,
            defaultValue: floor,
          }),
          buildBoundDescriptor({
            id: autoEffortCeilingOptionId(descriptor.id),
            label: "Maximum",
            ladder,
            defaultValue: ceiling,
          }),
        ]
      : [];

  return {
    optionDescriptors: descriptors.flatMap((candidate) =>
      candidate.id === descriptor.id && isEffortOptionDescriptor(candidate)
        ? [augmentEffortDescriptor(candidate), ...boundDescriptors]
        : [candidate],
    ),
  };
}

/**
 * Provider option descriptors for composer surfaces: identical to
 * `getProviderOptionDescriptors` except that auto effort is selectable, and its
 * limits are included once the user has engaged with auto effort at all.
 */
export function getAutoEffortAwareDescriptors(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const caps = withAutoEffortCapabilities(input.caps, {
    includeBounds: hasAutoEffortFootprint(input.caps, input.selections),
  });
  if (!caps) {
    return [];
  }
  return getProviderOptionDescriptors({ caps, selections: input.selections });
}

/**
 * True once auto effort is in play for a selection: either it is currently
 * selected, or limits were configured earlier and must survive a temporary
 * switch back to a manual effort.
 */
function hasAutoEffortFootprint(
  caps: ModelCapabilities | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): boolean {
  const descriptor = effortDescriptorFrom(caps?.optionDescriptors ?? []);
  if (!descriptor) {
    return false;
  }
  if (getProviderOptionStringSelectionValue(selections, descriptor.id) === AUTO_EFFORT_VALUE) {
    return true;
  }
  const limitIds = new Set([
    autoEffortCeilingOptionId(descriptor.id),
    autoEffortFloorOptionId(descriptor.id),
  ]);
  return (selections ?? []).some((selection) => limitIds.has(selection.id));
}

/** True for the maximum/minimum descriptors synthesized for auto effort. */
export function isAutoEffortBoundDescriptor(descriptor: ProviderOptionDescriptor): boolean {
  return descriptor.type === "select" && isAutoEffortBoundOptionId(descriptor.id);
}

/**
 * Effort to select when the user switches Auto off: the provider's own default,
 * so turning Auto off lands on the same effort a fresh thread would use.
 */
export function autoEffortManualDefault(
  descriptor: SelectProviderOptionDescriptor,
): string | undefined {
  return defaultCeiling(descriptor, autoEffortLadder(descriptor));
}

/**
 * Push the sibling limit out of the way after one limit changes.
 *
 * The maximum and the minimum describe one window, so raising the minimum above
 * the maximum has to drag the maximum up with it (and vice versa) — otherwise
 * the menu shows a window that reads backwards.
 */
export function reconcileAutoEffortLimitDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  changedId: string,
): ReadonlyArray<ProviderOptionDescriptor> {
  const effortDescriptor = effortDescriptorFrom(descriptors);
  if (!effortDescriptor) {
    return descriptors;
  }
  const ceilingId = autoEffortCeilingOptionId(effortDescriptor.id);
  const floorId = autoEffortFloorOptionId(effortDescriptor.id);
  if (changedId !== ceilingId && changedId !== floorId) {
    return descriptors;
  }
  const siblingId = changedId === ceilingId ? floorId : ceilingId;
  const ladder = autoEffortLadder(effortDescriptor);
  const changedValue = descriptorValue(descriptors, changedId);
  const siblingValue = descriptorValue(descriptors, siblingId);
  if (changedValue === undefined || siblingValue === undefined) {
    return descriptors;
  }
  const changedIndex = ladderIndex(ladder, changedValue);
  const siblingIndex = ladderIndex(ladder, siblingValue);
  if (changedIndex < 0 || siblingIndex < 0) {
    return descriptors;
  }
  const contradicts =
    changedId === ceilingId ? siblingIndex > changedIndex : siblingIndex < changedIndex;
  if (!contradicts) {
    return descriptors;
  }
  return descriptors.map((descriptor) =>
    descriptor.id === siblingId && descriptor.type === "select"
      ? { ...descriptor, currentValue: changedValue }
      : descriptor,
  );
}

function descriptorValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
): string | undefined {
  const value = getProviderOptionCurrentValue(
    descriptors.find((descriptor) => descriptor.id === descriptorId),
  );
  return typeof value === "string" ? value : undefined;
}

export function isAutoEffortSelectedInDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): boolean {
  const descriptor = effortDescriptorFrom(descriptors);
  return descriptor ? getProviderOptionCurrentValue(descriptor) === AUTO_EFFORT_VALUE : false;
}

export interface ResolvedAutoEffort {
  /** Effort actually sent to the provider. */
  readonly effort: string;
  /** Raw reviewer choice before clamping, when a reviewer ran. */
  readonly requested: string | null;
  /** True when clamping overrode the reviewer's choice. */
  readonly clamped: boolean;
  readonly ceiling: string;
  readonly floor: string;
  /** Selection with `auto` replaced by the resolved effort. */
  readonly modelSelection: ModelSelection;
}

/**
 * Replace an `auto` effort selection with a concrete effort.
 *
 * Returns `null` when auto is not active, which is the signal for callers to
 * pass the selection through untouched.
 */
export function resolveAutoEffortSelection(input: {
  readonly modelSelection: ModelSelection;
  readonly caps: ModelCapabilities | null | undefined;
  /** Reviewer's choice; `null`/invalid falls back to the clamped default. */
  readonly requestedEffort: string | null | undefined;
}): ResolvedAutoEffort | null {
  const state = resolveAutoEffortState({
    caps: input.caps,
    selections: input.modelSelection.options,
  });
  if (!state || !state.active) {
    return null;
  }
  const requested = input.requestedEffort?.trim() || null;
  const effort = requested === null ? state.fallback : clampAutoEffort(state, requested);
  const options = (input.modelSelection.options ?? []).map((selection) =>
    selection.id === state.descriptorId ? { id: selection.id, value: effort } : selection,
  );

  return {
    effort,
    requested,
    clamped: requested !== null && requested !== effort,
    ceiling: state.ceiling,
    floor: state.floor,
    modelSelection: { ...input.modelSelection, options },
  };
}
