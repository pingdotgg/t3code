import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderDriverKind,
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
/** At this peak usage an account counts as nearly out: a sticky model gives way and routing
 * moves to an account with room. */
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
 * Orchestrator candidates per level, best first: Claude A/B, Claude on Antigravity A/B, ChatGPT
 * (Codex), Grok, Gemini, then free OpenCode models. Models a provider does not list are skipped,
 * so paid-plan models (Sol, Astra) wait until the plan has them.
 */
const AUTO_CANDIDATES: Readonly<Record<AutoLevel, ReadonlyArray<AutoCandidate>>> = {
  high: [
    claude("claude-fable-5-2", "high"),
    claude("claude-opus-5-5", "high"),
    antigravity("claude-opus-4-6-thinking", "high"),
    codex("gpt-6.1-sol", "high"),
    codex("gpt-6-astra", "high"),
    codex("gpt-6-luna", "high"),
    grok("high"),
    antigravity("gemini-3.8-flash", "high"),
  ],
  medium: [
    claude("claude-opus-5-5", "medium"),
    claude("claude-fable-5-2", "medium"),
    antigravity("claude-opus-4-6-thinking", "medium"),
    codex("gpt-6.1-sol", "medium"),
    codex("gpt-6-astra", "medium"),
    claude("claude-sonnet-5-5", "medium"),
    antigravity("claude-sonnet-4-6", "medium"),
    codex("gpt-6-luna", "medium"),
    grok("medium"),
    antigravity("gemini-3.8-flash", "medium"),
    opencode("opencode/big-pickle", "medium"),
  ],
  low: [
    claude("claude-sonnet-5-5", "low"),
    claude("claude-haiku-5-5", "low"),
    antigravity("claude-sonnet-4-6", "low"),
    antigravity("gemini-3.8-flash", "low"),
    opencode("opencode/big-pickle", "medium"),
    opencode("opencode/beam-free", "medium"),
    opencode("opencode/deepseek-v4.1-flash-free", "medium"),
    opencode("opencode/glm-5.3-flash-free", "medium"),
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

/** One picker row per level; every Claude provider lists them, so Auto needs no settings. */
export const AUTO_LEVEL_MODELS: ReadonlyArray<{ readonly slug: string; readonly name: string }> =
  AUTO_LEVELS.map((level) => ({
    slug: `${AUTO_MODEL_SLUG}-${level}`,
    name: `Auto ${level[0]!.toUpperCase()}${level.slice(1)}`,
  }));

export function isAutoModelSelection(selection: ModelSelection | null | undefined): boolean {
  return isAutoModelSlug(selection?.model);
}

function autoLevelOf(selection: ModelSelection): AutoLevel {
  const fixed = AUTO_LEVELS.find((level) => selection.model === `${AUTO_MODEL_SLUG}-${level}`);
  if (fixed) return fixed;
  const value = selection.options?.find((option) => option.id === "effort")?.value;
  return AUTO_LEVELS.find((level) => level === value) ?? DEFAULT_LEVEL;
}

/** Accounts whose 5-hour use differs by less than this many points count as equally far along. */
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
 * Best instance first: Auto-aware, then accounts under 90% everywhere. Among those, the further
 * along 5-hour window, so windows stagger (one refreshes while the other runs); within 10
 * points, the sooner weekly reset. Past 90% everywhere, the most left.
 */
function compareInstances(a: ServerProvider, b: ServerProvider): number {
  const aware = Number(isAutoAware(b)) - Number(isAutoAware(a));
  if (aware !== 0) return aware;
  const room = Number(hasRoom(b)) - Number(hasRoom(a));
  if (room !== 0) return room;
  if (!hasRoom(a)) return peakUsedPercent(a) - peakUsedPercent(b);
  const session = sessionUsedPercent(b) - sessionUsedPercent(a);
  if (Math.abs(session) >= SESSION_BAND_PERCENT) return session;
  const weekly = weeklyResetAt(a) - weeklyResetAt(b);
  if (Number.isFinite(weekly) && weekly !== 0) return weekly;
  if (weekly === Infinity || weekly === -Infinity) return weekly > 0 ? 1 : -1;
  return session || peakUsedPercent(a) - peakUsedPercent(b);
}

function hasRoom(provider: ServerProvider): boolean {
  return peakUsedPercent(provider) < STICKY_MAX_USED_PERCENT;
}

function peakUsedPercent(provider: ServerProvider): number {
  return Math.max(0, ...(provider.usageLimits?.windows ?? []).map((w) => w.usedPercent ?? 0));
}

/**
 * Instances named "Auto…" carry the Auto-mode prompt (their launch args), so they win ties. Every
 * Claude provider lists the Auto levels, so listing them says nothing about the prompt.
 */
function isAutoAware(provider: ServerProvider): boolean {
  return /^auto\b/i.test(provider.displayName ?? "");
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
