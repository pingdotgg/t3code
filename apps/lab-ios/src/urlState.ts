import { useEffect, useState } from "react";

export const SCREENS = {
  "thread-question": {
    label: "Thread · question",
    states: ["single", "selected", "multi-1", "multi-2", "multi-3", "long", "cant-submit"],
  },
  thread: { label: "Thread · feed", states: [] },
  "thread-list": { label: "Thread list", states: [] },
  tasks: { label: "Tasks", states: ["strip", "chart"] },
} as const;

export type ScreenId = keyof typeof SCREENS;
export type ThemeChoice = "dark-mono" | "light" | "both";

/** The Tasks insight block's design variants, compared with `&insights=a|b|c`. */
export const INSIGHT_VARIANTS = ["a", "b", "c"] as const;
export type InsightVariant = (typeof INSIGHT_VARIANTS)[number];

export interface LabUrlState {
  readonly screen: ScreenId;
  readonly theme: ThemeChoice;
  readonly state: string;
  readonly scale: number;
  readonly insights: InsightVariant;
}

const DEFAULTS: LabUrlState = {
  screen: "thread-question",
  theme: "dark-mono",
  state: "",
  scale: 1,
  insights: "b",
};

function read(): LabUrlState {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get("screen");
  const theme = params.get("theme");
  const scale = Number(params.get("scale"));
  const resolved: ScreenId = screen && screen in SCREENS ? (screen as ScreenId) : DEFAULTS.screen;
  const states: readonly string[] = SCREENS[resolved].states;
  const state = params.get("state") ?? "";
  const insights =
    INSIGHT_VARIANTS.find((variant) => variant === params.get("insights")) ?? DEFAULTS.insights;
  return {
    insights,
    screen: resolved,
    theme: theme === "light" || theme === "both" || theme === "dark-mono" ? theme : DEFAULTS.theme,
    state: states.includes(state) ? state : (states[0] ?? ""),
    scale: Number.isFinite(scale) && scale >= 0.25 && scale <= 3 ? scale : DEFAULTS.scale,
  };
}

/** The lab's URL as React state; every change rewrites the query without a reload. */
export function useLabUrlState() {
  const [state, setState] = useState(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the browser's back button changes the URL outside React
  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = (patch: Partial<LabUrlState>) => {
    const next = { ...state, ...patch };
    // A new screen starts at its first state.
    if (patch.screen && patch.state === undefined)
      next.state = SCREENS[patch.screen].states[0] ?? "";
    const params = new URLSearchParams();
    params.set("screen", next.screen);
    params.set("theme", next.theme);
    if (next.state) params.set("state", next.state);
    if (next.scale !== 1) params.set("scale", String(next.scale));
    if (next.screen === "tasks") params.set("insights", next.insights);
    window.history.replaceState(null, "", `?${params.toString()}`);
    setState(next);
  };
  return [state, update] as const;
}
