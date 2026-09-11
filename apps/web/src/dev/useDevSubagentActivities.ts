/**
 * Dev-only override for a thread's activity list.
 *
 * The Agents panel and the chat's spawn CTA row both derive from
 * `threadActivities`, so swapping that one value is enough to render either
 * surface in any state without spawning a real fleet. Everything downstream —
 * the subagent fold, the panel model, the timeline collapse — runs untouched.
 *
 * Drive it from the URL (`?dev-agents=workflow-live`) or, once the app is
 * open, from the console:
 *
 *   __t3devAgents("workflow-failed")   // switch scenario, no reload
 *   __t3devAgents(null)                // back to the real thread
 *   __t3devAgents()                    // list the scenarios
 *
 * In production `import.meta.env.DEV` is a static false, so the fixture import
 * and every branch below drop out of the bundle.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  DEV_SUBAGENT_SCENARIOS,
  devSubagentActivities,
  isDevSubagentScenario,
} from "./subagentFixtures";

const DEV_AGENTS_PARAM = "dev-agents";
/** Same window-event shape as commandPaletteBus: no state owner needed. */
const DEV_AGENTS_CHANGE_EVENT = "t3code:dev-agents-change";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(DEV_AGENTS_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(DEV_AGENTS_CHANGE_EVENT, listener);
  };
}

/** Production never changes scenario, so it never registers the listeners either. */
const subscribeDev: typeof subscribe = import.meta.env.DEV ? subscribe : () => () => {};

interface DevAgentsActivation {
  readonly scenario: string;
  /** Wall clock at activation, so fixture elapsed timers start from zero. */
  readonly now: number;
}

const NO_ACTIVATION: DevAgentsActivation = { scenario: "", now: 0 };
let activation: DevAgentsActivation = NO_ACTIVATION;

/**
 * Store snapshot for `useSyncExternalStore`: the same object is returned until
 * the scenario param changes, and each change stamps a fresh clock so the
 * panel's self-ticking elapsed timers reset per activation rather than per
 * render. Production must not pay for it: `import.meta.env.DEV` is a static
 * false there, folding this to a constant return.
 */
function readActivation(): DevAgentsActivation {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return NO_ACTIVATION;
  }
  const scenario = new URLSearchParams(window.location.search).get(DEV_AGENTS_PARAM) ?? "";
  if (scenario !== activation.scenario) {
    activation = { scenario, now: Date.now() };
  }
  return activation;
}

function readServerActivation(): DevAgentsActivation {
  return NO_ACTIVATION;
}

/** Writes the param without a reload so switching scenarios keeps the view. */
function setScenarioParam(scenario: string | null): void {
  const url = new URL(window.location.href);
  if (scenario === null || scenario.length === 0) {
    url.searchParams.delete(DEV_AGENTS_PARAM);
  } else {
    url.searchParams.set(DEV_AGENTS_PARAM, scenario);
  }
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new CustomEvent(DEV_AGENTS_CHANGE_EVENT));
}

export function useDevSubagentActivities(
  actual: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const { scenario: raw, now } = useSyncExternalStore(
    subscribeDev,
    readActivation,
    readServerActivation,
  );
  const scenario = import.meta.env.DEV && isDevSubagentScenario(raw) ? raw : null;

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") {
      return;
    }
    const helper = (next?: string | null) => {
      if (next === undefined) {
        return [...DEV_SUBAGENT_SCENARIOS];
      }
      if (next !== null && !isDevSubagentScenario(next)) {
        return [...DEV_SUBAGENT_SCENARIOS];
      }
      setScenarioParam(next);
      return next;
    };
    Reflect.set(window, "__t3devAgents", helper);
    return () => {
      Reflect.deleteProperty(window, "__t3devAgents");
    };
  }, []);

  return useMemo(() => {
    if (!import.meta.env.DEV || scenario === null) {
      return actual;
    }
    return devSubagentActivities(scenario, now);
  }, [actual, now, scenario]);
}
