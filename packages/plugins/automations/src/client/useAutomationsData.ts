import type { PluginSubscriptionEvent, PluginUiContext } from "@t3tools/plugin-api/ui";

import { AUTOMATIONS_COMMANDS, AUTOMATIONS_EVENTS } from "../shared/constants.ts";
import type {
  AutomationRule,
  AutomationRun,
  AutomationsRulesListResult,
  AutomationsRunsListRecentResult,
} from "../shared/schema.ts";
import { commandErrorMessage } from "./domain.ts";

export function useAutomationsData(ctx: PluginUiContext) {
  const React = ctx.react;
  const [rules, setRules] = React.useState<ReadonlyArray<AutomationRule>>([]);
  const [runs, setRuns] = React.useState<ReadonlyArray<AutomationRun>>([]);
  const [loading, setLoading] = React.useState(true);
  const refreshInFlightRef = React.useRef(false);
  const refreshQueuedRef = React.useRef(false);
  const refreshTimerRef = React.useRef<number | null>(null);
  const runQueuedRefreshRef = React.useRef<(() => void) | null>(null);
  const refreshGenerationRef = React.useRef(0);

  const runRefresh = React.useCallback(
    async (input: { readonly showLoading: boolean }) => {
      const generation = refreshGenerationRef.current;
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        return;
      }

      refreshInFlightRef.current = true;
      if (input.showLoading) {
        setLoading(true);
      }
      try {
        const [rulesResult, runsResult] = await Promise.all([
          ctx.api.invoke<AutomationsRulesListResult>(AUTOMATIONS_COMMANDS.rulesList, {}),
          ctx.api.invoke<AutomationsRunsListRecentResult>(AUTOMATIONS_COMMANDS.runsListRecent, {
            limit: 500,
          }),
        ]);
        if (generation !== refreshGenerationRef.current) {
          return;
        }
        setRules(rulesResult.rules);
        setRuns(runsResult.runs);
      } catch (error) {
        if (generation === refreshGenerationRef.current) {
          ctx.toast.error("Could not load automations", commandErrorMessage(error));
        }
      } finally {
        if (generation === refreshGenerationRef.current) {
          refreshInFlightRef.current = false;
          setLoading(false);
          if (refreshQueuedRef.current) {
            refreshQueuedRef.current = false;
            runQueuedRefreshRef.current?.();
          }
        }
      }
    },
    [ctx],
  );

  React.useEffect(() => {
    runQueuedRefreshRef.current = () => {
      void runRefresh({ showLoading: false });
    };
    return () => {
      runQueuedRefreshRef.current = null;
    };
  }, [runRefresh]);

  const refresh = React.useCallback(() => runRefresh({ showLoading: true }), [runRefresh]);
  const refreshQuietly = React.useCallback(() => runRefresh({ showLoading: false }), [runRefresh]);
  const resetRefreshState = React.useCallback(() => {
    refreshGenerationRef.current += 1;
    refreshInFlightRef.current = false;
    refreshQueuedRef.current = false;
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefresh = React.useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshQuietly();
    }, 100);
  }, [refreshQuietly]);

  React.useEffect(() => {
    return resetRefreshState;
  }, [ctx.api, resetRefreshState]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    return ctx.api.subscribe(
      (event: PluginSubscriptionEvent) => {
        if (event.type === AUTOMATIONS_EVENTS.changed) {
          scheduleRefresh();
        }
      },
      { onResubscribe: scheduleRefresh },
    );
  }, [ctx.api, scheduleRefresh]);

  return {
    rules,
    runs,
    loading,
    refresh,
    refreshQuietly,
  } as const;
}
