import { create } from "zustand";
import type { ThreadId } from "@t3tools/contracts";

// ── Types ─────────────────────────────────────────────────────────────

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  model: string | null;
  completedAt: string;
}

export interface ThreadUsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  turns: TurnUsage[];
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  totalTokens: number;
  totalCostUsd: number;
  turnCount: number;
}

export interface RateLimitInfo {
  provider: string;
  limits: Record<string, unknown>;
  updatedAt: string;
}

export interface TokenUsageState {
  /** Per-thread accumulated usage */
  threadUsage: Record<string, ThreadUsageSummary>;
  /** Daily usage totals */
  dailyUsage: DailyUsage[];
  /** Latest rate limit info from providers */
  rateLimits: RateLimitInfo[];
  /** Latest account info from providers */
  accountInfo: Record<string, unknown> | null;
}

export interface TokenUsageActions {
  /** Record a completed turn's token usage */
  recordTurnUsage: (
    threadId: ThreadId,
    usage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      costUsd?: number | null;
      model?: string | null;
    },
  ) => void;
  /** Update thread-level token usage from streaming event */
  updateThreadTokenUsage: (threadId: ThreadId, usage: Record<string, unknown>) => void;
  /** Update rate limit information */
  updateRateLimits: (provider: string, limits: Record<string, unknown>) => void;
  /** Update account information */
  updateAccountInfo: (account: Record<string, unknown>) => void;
  /** Get usage for a specific thread */
  getThreadUsage: (threadId: ThreadId) => ThreadUsageSummary;
  /** Get today's usage */
  getTodayUsage: () => DailyUsage;
  /** Get this week's usage */
  getWeekUsage: () => DailyUsage;
}

// ── Helpers ───────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function isThisWeek(dateStr: string): boolean {
  const date = new Date(dateStr);
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  return date >= startOfWeek;
}

const PERSISTED_KEY = "t3code:token-usage:v1";

function loadPersistedUsage(): Partial<TokenUsageState> {
  try {
    const raw = window.localStorage.getItem(PERSISTED_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function persistUsage(state: TokenUsageState): void {
  try {
    // Only persist daily usage and rate limits (thread usage can be large)
    window.localStorage.setItem(
      PERSISTED_KEY,
      JSON.stringify({
        dailyUsage: state.dailyUsage.slice(-30), // Keep last 30 days
        rateLimits: state.rateLimits,
      }),
    );
  } catch {
    // Ignore quota errors
  }
}

// ── Store ─────────────────────────────────────────────────────────────

const persisted = loadPersistedUsage();

export const useTokenUsageStore = create<TokenUsageState & TokenUsageActions>()((set, get) => ({
  threadUsage: {},
  dailyUsage: persisted.dailyUsage ?? [],
  rateLimits: persisted.rateLimits ?? [],
  accountInfo: null,

  recordTurnUsage: (threadId, usage) => {
    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
    const costUsd = usage.costUsd ?? null;
    const now = new Date().toISOString();

    const turn: TurnUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      model: usage.model ?? null,
      completedAt: now,
    };

    set((state) => {
      // Update thread usage
      const existing = state.threadUsage[threadId] ?? {
        totalTokens: 0,
        totalCostUsd: 0,
        turns: [],
      };
      const updatedThread: ThreadUsageSummary = {
        totalTokens: existing.totalTokens + totalTokens,
        totalCostUsd: existing.totalCostUsd + (costUsd ?? 0),
        turns: [...existing.turns, turn],
      };

      // Update daily usage
      const today = todayKey();
      const dailyUsage = [...state.dailyUsage];
      const todayIdx = dailyUsage.findIndex((d) => d.date === today);
      if (todayIdx >= 0) {
        const day = dailyUsage[todayIdx]!;
        dailyUsage[todayIdx] = {
          ...day,
          totalTokens: day.totalTokens + totalTokens,
          totalCostUsd: day.totalCostUsd + (costUsd ?? 0),
          turnCount: day.turnCount + 1,
        };
      } else {
        dailyUsage.push({
          date: today,
          totalTokens,
          totalCostUsd: costUsd ?? 0,
          turnCount: 1,
        });
      }

      const newState = {
        threadUsage: { ...state.threadUsage, [threadId]: updatedThread },
        dailyUsage,
      };
      persistUsage({ ...state, ...newState });
      return newState;
    });
  },

  updateThreadTokenUsage: (threadId, usage) => {
    // Handle streaming token usage updates (partial data)
    const totalTokens =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : typeof usage.totalTokens === "number"
          ? usage.totalTokens
          : 0;

    if (totalTokens === 0) return;

    set((state) => {
      const existing = state.threadUsage[threadId] ?? {
        totalTokens: 0,
        totalCostUsd: 0,
        turns: [],
      };
      return {
        threadUsage: {
          ...state.threadUsage,
          [threadId]: { ...existing, totalTokens },
        },
      };
    });
  },

  updateRateLimits: (provider, limits) => {
    set((state) => {
      const existing = state.rateLimits.filter((r) => r.provider !== provider);
      const updated = [
        ...existing,
        { provider, limits, updatedAt: new Date().toISOString() },
      ];
      persistUsage({ ...state, rateLimits: updated });
      return { rateLimits: updated };
    });
  },

  updateAccountInfo: (account) => {
    set({ accountInfo: account });
  },

  getThreadUsage: (threadId) => {
    return get().threadUsage[threadId] ?? { totalTokens: 0, totalCostUsd: 0, turns: [] };
  },

  getTodayUsage: () => {
    const today = todayKey();
    return (
      get().dailyUsage.find((d) => d.date === today) ?? {
        date: today,
        totalTokens: 0,
        totalCostUsd: 0,
        turnCount: 0,
      }
    );
  },

  getWeekUsage: () => {
    const weekDays = get().dailyUsage.filter((d) => isThisWeek(d.date));
    return {
      date: "week",
      totalTokens: weekDays.reduce((sum, d) => sum + d.totalTokens, 0),
      totalCostUsd: weekDays.reduce((sum, d) => sum + d.totalCostUsd, 0),
      turnCount: weekDays.reduce((sum, d) => sum + d.turnCount, 0),
    };
  },
}));
