import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

import { exhaustedUsageWindow, usageWindowLimitsModel } from "./usageLimits.ts";

/**
 * "Auto" is a custom model (slug `auto`) on any provider instance. Picking it never reaches
 * a provider: the server replaces it with a concrete model chosen here, from the providers'
 * live usage limits. The level (`low` | `medium` | `high`) rides in the `effort` option.
 */
const AUTO_MODEL_SLUG = "auto";
/** Stamped on the model Auto picks, holding the level, so the thread stays on Auto. */
const AUTO_OPTION_ID = "auto";
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
    claude("claude-opus-5-5", "max"),
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

function stampedLevel(selection: ModelSelection | null | undefined): AutoLevel | undefined {
  const value = selection?.options?.find((option) => option.id === AUTO_OPTION_ID)?.value;
  return AUTO_LEVELS.find((level) => level === value);
}

export function isAutoModelSelection(selection: ModelSelection | null | undefined): boolean {
  return isAutoModelSlug(selection?.model) || stampedLevel(selection) !== undefined;
}

/** The Auto level a routed thread runs at, or undefined for a thread not on Auto. */
export function routedAutoLevel(selection: ModelSelection | null | undefined) {
  return stampedLevel(selection);
}

/** A routed thread's model as the Auto level it came from, for pickers; others unchanged. */
export function autoLevelSelection<T extends ModelSelection | null | undefined>(
  selection: T,
): T | ModelSelection {
  const level = stampedLevel(selection);
  return selection && level
    ? { instanceId: selection.instanceId, model: `${AUTO_MODEL_SLUG}-${level}` }
    : selection;
}

function autoLevelOf(selection: ModelSelection): AutoLevel {
  const stamped = stampedLevel(selection);
  if (stamped) return stamped;
  const fixed = AUTO_LEVELS.find((level) => selection.model === `${AUTO_MODEL_SLUG}-${level}`);
  if (fixed) return fixed;
  const value = selection.options?.find((option) => option.id === "effort")?.value;
  return AUTO_LEVELS.find((level) => level === value) ?? DEFAULT_LEVEL;
}

/** Accounts whose 5-hour use differs by less than this many points count as equally far along. */
const SESSION_BAND_PERCENT = 10;
/** Weekly paces within this share of each other count as equal. */
const PACE_BAND = 0.15;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function sessionUsedPercent(provider: ServerProvider): number {
  const windows = (provider.usageLimits?.windows ?? []).filter((w) => w.kind === "session");
  return Math.max(0, ...windows.map((w) => w.usedPercent ?? 0));
}

/**
 * Weekly windows that limit `model` (a one-model window counts only for it) and when each
 * resets. A window that has not started reports no reset; it would run its full length from now.
 */
function weeklyWindows(provider: ServerProvider, model: string, now: number) {
  return (provider.usageLimits?.windows ?? []).flatMap((w) => {
    if (w.kind !== "weekly" || !usageWindowLimitsModel(provider, w, model)) return [];
    const resetsAt =
      w.resetsAt === undefined
        ? now + (w.windowDurationMins ?? Number.NaN) * MINUTE
        : Date.parse(w.resetsAt);
    return Number.isFinite(resetsAt) ? [{ usedPercent: w.usedPercent, resetsAt }] : [];
  });
}

/**
 * Weekly % left per hour until that window resets: the burn rate that spends the quota exactly
 * at its reset, when whatever is left is lost. The tightest window decides; undefined without
 * weekly data.
 */
function weeklyPace(provider: ServerProvider, model: string, now: number): number | undefined {
  const paces = weeklyWindows(provider, model, now).map(
    (w) => (100 - w.usedPercent) / (Math.max(w.resetsAt - now, MINUTE) / HOUR),
  );
  return paces.length > 0 ? Math.min(...paces) : undefined;
}

/** When the soonest weekly window resets; unused weekly quota is lost then. */
function weeklyResetAt(provider: ServerProvider, model: string, now: number): number {
  return Math.min(...weeklyWindows(provider, model, now).map((w) => w.resetsAt));
}

/** The higher pace first; paces within 15% tie, and an account without weekly data goes last. */
function comparePace(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return Number(a === undefined) - Number(b === undefined);
  return Math.abs(a - b) > PACE_BAND * Math.max(a, b) ? b - a : 0;
}

/**
 * Best instance for `model` first: Auto-aware, then accounts under 90% everywhere. Among those,
 * the higher weekly pace, so the quota a reset would waste is spent first. With similar paces,
 * the further along 5-hour window, so windows stagger (one refreshes while the other runs);
 * within 10 points, the sooner weekly reset. Past 90% everywhere, the most left.
 */
function compareInstances(a: ServerProvider, b: ServerProvider, model: string, now: number) {
  const aware = Number(isAutoAware(b)) - Number(isAutoAware(a));
  if (aware !== 0) return aware;
  const room = Number(hasRoom(b)) - Number(hasRoom(a));
  if (room !== 0) return room;
  if (!hasRoom(a)) return peakUsedPercent(a) - peakUsedPercent(b);
  const pace = comparePace(weeklyPace(a, model, now), weeklyPace(b, model, now));
  if (pace !== 0) return pace;
  const session = sessionUsedPercent(b) - sessionUsedPercent(a);
  if (Math.abs(session) >= SESSION_BAND_PERCENT) return session;
  const weekly = weeklyResetAt(a, model, now) - weeklyResetAt(b, model, now);
  if (Number.isFinite(weekly) && weekly !== 0) return weekly;
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

function toSelection(
  provider: ServerProvider,
  candidate: AutoCandidate,
  level: AutoLevel,
): ModelSelection {
  return {
    instanceId: provider.instanceId,
    model: candidate.model,
    options: [...(effortOptions(provider, candidate) ?? []), { id: AUTO_OPTION_ID, value: level }],
  };
}

interface AutoResolution {
  readonly selection: ModelSelection;
  readonly level: AutoLevel;
  /** True when the thread's current model was kept. */
  readonly sticky: boolean;
}

/**
 * Keeps the thread's model while it fits this level, is under 90% used and no better candidate
 * has room (no account hop, no lost prompt cache); otherwise the first usable candidate on the
 * best instance (see `compareInstances`). Null when nothing is usable.
 */
export function resolveAutoModelSelection(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
  readonly current?: ModelSelection | null;
  /**
   * Instances (and models) that just failed with a usage limit or no capacity, which the usage
   * report may not show yet. Auto skips them, the thread's current model included.
   */
  readonly blocked?: (instanceId: string, model: string) => boolean;
}): AutoResolution | null {
  const level = autoLevelOf(input.selection);
  const candidates = AUTO_CANDIDATES[level];
  const open = (provider: ServerProvider, model: string) =>
    usable(provider, model, input.now) && !input.blocked?.(provider.instanceId, model);

  const current = input.current;
  if (current && !isAutoModelSlug(current.model)) {
    const provider = input.providers.find((entry) => entry.instanceId === current.instanceId);
    const rank = candidates.findIndex(
      (entry) => entry.driver === provider?.driver && entry.model === current.model,
    );
    const candidate = candidates[rank];
    // A thread that fell back to a weaker model returns once a better one has room again.
    const betterHasRoom = candidates
      .slice(0, Math.max(rank, 0))
      .some((better) =>
        input.providers.some(
          (entry) =>
            entry.driver === (better.driver as ProviderDriverKind) &&
            open(entry, better.model) &&
            hasRoom(entry),
        ),
      );
    if (
      provider &&
      candidate &&
      open(provider, candidate.model) &&
      hasRoom(provider) &&
      !betterHasRoom
    ) {
      return { selection: toSelection(provider, candidate, level), level, sticky: true };
    }
  }

  for (const candidate of candidates) {
    const instances = input.providers
      .filter(
        (provider) =>
          provider.driver === (candidate.driver as ProviderDriverKind) &&
          open(provider, candidate.model),
      )
      // A copy: `filter` already returned a new array, and Hermes has no `toSorted`.
      .sort((a, b) => compareInstances(a, b, candidate.model, input.now));
    const provider = instances[0];
    if (provider) {
      return { selection: toSelection(provider, candidate, level), level, sticky: false };
    }
  }
  return null;
}
