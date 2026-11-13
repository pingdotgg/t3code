import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";

import { exhaustedUsageWindow } from "./usageLimits.ts";

/**
 * "Auto" is a custom model (slug `auto`) on any provider instance. Picking it never reaches
 * a provider: the server replaces it with a concrete model chosen here, from the providers'
 * live usage limits. The level (`low` | `medium` | `high`) rides in the `effort` option.
 */
const AUTO_MODEL_SLUG = "auto";
const AUTO_LEVELS = ["low", "medium", "high"] as const;
type AutoLevel = (typeof AUTO_LEVELS)[number];
const DEFAULT_LEVEL: AutoLevel = "medium";
/** Above this peak usage, a sticky model gives way when another candidate has more room. */
const STICKY_MAX_USED_PERCENT = 90;

interface AutoCandidate {
  readonly driver: string;
  readonly model: string;
  /** The candidate's own reasoning effort for this level. */
  readonly effort: string;
}

const claude = (model: string, effort: string): AutoCandidate => ({
  driver: "claudeAgent",
  model,
  effort,
});
const codex = (model: string, effort: string): AutoCandidate => ({
  driver: "codex",
  model,
  effort,
});
const grok = (effort: string): AutoCandidate => ({ driver: "grok", model: "grok-4.7", effort });
/** Claude models on the Antigravity (Google) subscription: a third Claude pool. */
const antigravity = (model: string, effort: string): AutoCandidate => ({
  driver: "antigravity",
  model,
  effort,
});
const opencode = (model: string, effort: string): AutoCandidate => ({
  driver: "opencode",
  model,
  effort,
});

/**
 * Orchestrator candidates per level, best first. Each level starts on its Claude model and
 * steps down through the other subscriptions as limits run out.
 */
const AUTO_CANDIDATES: Readonly<Record<AutoLevel, ReadonlyArray<AutoCandidate>>> = {
  high: [
    claude("claude-fable-5-2", "high"),
    claude("claude-opus-5-5", "high"),
    antigravity("claude-opus-4-6-thinking", "high"),
    codex("gpt-6.1-sol", "high"),
    codex("gpt-6-astra", "high"),
    grok("high"),
    codex("gpt-6-luna", "high"),
  ],
  medium: [
    claude("claude-opus-5-5", "medium"),
    claude("claude-fable-5-2", "medium"),
    antigravity("claude-opus-4-6-thinking", "medium"),
    codex("gpt-6.1-sol", "medium"),
    codex("gpt-6-astra", "medium"),
    claude("claude-sonnet-5-5", "medium"),
    grok("medium"),
    codex("gpt-6-luna", "medium"),
  ],
  low: [
    claude("claude-sonnet-5-5", "low"),
    claude("claude-haiku-5-5", "low"),
    antigravity("claude-sonnet-4-6", "low"),
    opencode("opencode/big-pickle", "medium"),
    opencode("opencode/deepseek-v4.1-flash-free", "medium"),
    codex("gpt-6-luna", "low"),
    grok("low"),
  ],
};

/** The option each driver uses for reasoning effort. */
const EFFORT_OPTION_ID: Readonly<Record<string, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  grok: "reasoningEffort",
  opencode: "variant",
  antigravity: "thinking_level",
};

/**
 * `auto` takes its level from the `effort` option; `auto-low`, `auto-medium` and `auto-high`
 * fix it in the slug, so a picker can list one row per level.
 */
export function isAutoModelSlug(slug: string | null | undefined): boolean {
  return (
    slug === AUTO_MODEL_SLUG || AUTO_LEVELS.some((level) => slug === `${AUTO_MODEL_SLUG}-${level}`)
  );
}

export function isAutoModelSelection(selection: ModelSelection | null | undefined): boolean {
  return isAutoModelSlug(selection?.model);
}

function autoLevelOf(selection: ModelSelection): AutoLevel {
  const fixed = AUTO_LEVELS.find((level) => selection.model === `${AUTO_MODEL_SLUG}-${level}`);
  if (fixed) return fixed;
  const value = selection.options?.find((option) => option.id === "effort")?.value;
  return AUTO_LEVELS.find((level) => level === value) ?? DEFAULT_LEVEL;
}

/** The `effort` descriptor an `auto` custom model declares, so pickers show Low/Medium/High. */
export const AUTO_LEVEL_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "effort",
  label: "Auto level",
  type: "select",
  options: [
    { id: "low", label: "Low", description: "Sonnet orchestrates; cheaper models do more" },
    { id: "medium", label: "Medium", description: "Opus orchestrates", isDefault: true },
    { id: "high", label: "High", description: "Fable orchestrates" },
  ],
};

/** Accounts whose 5-hour use differs by less than this many points count as equally free. */
const SESSION_BAND_PERCENT = 10;

function sessionUsedPercent(provider: ServerProvider): number {
  const windows = (provider.usageLimits?.windows ?? []).filter((w) => w.kind === "session");
  return Math.max(0, ...windows.map((w) => w.usedPercent ?? 0));
}

/** When the soonest weekly window resets; unused weekly quota is lost then. */
function weeklyResetAt(provider: ServerProvider): number {
  const resets = (provider.usageLimits?.windows ?? [])
    .filter((w) => w.kind === "weekly" && w.resetsAt !== undefined)
    .map((w) => Date.parse(w.resetsAt!))
    .filter(Number.isFinite);
  return resets.length > 0 ? Math.min(...resets) : Infinity;
}

/**
 * Best instance first: Auto-aware (carries the Auto prompt), then the freer 5-hour window,
 * then, between accounts with similar 5-hour use, the one whose weekly quota resets first.
 */
function compareInstances(a: ServerProvider, b: ServerProvider): number {
  const aware = Number(isAutoAware(b)) - Number(isAutoAware(a));
  if (aware !== 0) return aware;
  const session = sessionUsedPercent(a) - sessionUsedPercent(b);
  if (Math.abs(session) >= SESSION_BAND_PERCENT) return session;
  const weekly = weeklyResetAt(a) - weeklyResetAt(b);
  if (Number.isFinite(weekly) && weekly !== 0) return weekly;
  if (weekly === Infinity || weekly === -Infinity) return weekly > 0 ? 1 : -1;
  return session || peakUsedPercent(a) - peakUsedPercent(b);
}

function peakUsedPercent(provider: ServerProvider): number {
  return Math.max(0, ...(provider.usageLimits?.windows ?? []).map((w) => w.usedPercent ?? 0));
}

/** Instances that list the `auto` model carry the Auto-mode prompt, so they win ties. */
function isAutoAware(provider: ServerProvider): boolean {
  return provider.models.some((model) => isAutoModelSlug(model.slug));
}

function usable(provider: ServerProvider, model: string, now: number): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    provider.models.some((entry) => entry.slug === model) &&
    exhaustedUsageWindow(provider, now, model) === undefined
  );
}

function effortOptions(provider: ServerProvider, candidate: AutoCandidate) {
  const id = EFFORT_OPTION_ID[candidate.driver];
  const descriptor = provider.models
    .find((entry) => entry.slug === candidate.model)
    ?.capabilities?.optionDescriptors?.find((entry) => entry.id === id);
  if (!id || descriptor?.type !== "select") return undefined;
  return descriptor.options.some((choice) => choice.id === candidate.effort)
    ? [{ id, value: candidate.effort }]
    : undefined;
}

function toSelection(provider: ServerProvider, candidate: AutoCandidate): ModelSelection {
  const options = effortOptions(provider, candidate);
  return {
    instanceId: provider.instanceId,
    model: candidate.model,
    ...(options ? { options } : {}),
  };
}

interface AutoResolution {
  readonly selection: ModelSelection;
  readonly level: AutoLevel;
  /** True when the thread's current model was kept. */
  readonly sticky: boolean;
}

/**
 * Keeps the thread's model while it fits this level and is under 90% used (no account hop, no
 * lost prompt cache); otherwise the first usable candidate on the best instance (see
 * `compareInstances`). Null when nothing is usable.
 */
export function resolveAutoModelSelection(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
  readonly current?: ModelSelection | null;
}): AutoResolution | null {
  const level = autoLevelOf(input.selection);
  const candidates = AUTO_CANDIDATES[level];

  const current = input.current;
  if (current && !isAutoModelSelection(current)) {
    const provider = input.providers.find((entry) => entry.instanceId === current.instanceId);
    const candidate = candidates.find(
      (entry) => entry.driver === provider?.driver && entry.model === current.model,
    );
    if (
      provider &&
      candidate &&
      usable(provider, candidate.model, input.now) &&
      peakUsedPercent(provider) < STICKY_MAX_USED_PERCENT
    ) {
      return { selection: toSelection(provider, candidate), level, sticky: true };
    }
  }

  for (const candidate of candidates) {
    const instances = input.providers
      .filter(
        (provider) =>
          provider.driver === (candidate.driver as ProviderDriverKind) &&
          usable(provider, candidate.model, input.now),
      )
      // A copy: `filter` already returned a new array, and Hermes has no `toSorted`.
      .sort(compareInstances);
    const provider = instances[0];
    if (provider) return { selection: toSelection(provider, candidate), level, sticky: false };
  }
  return null;
}
