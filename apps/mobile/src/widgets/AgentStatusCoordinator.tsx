import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { showcaseAgentStatusRowsAtom } from "../features/showcase/showcaseAgentActivity";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentProjects } from "../state/projects";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { workspaceConnections } from "../state/workspace";
import {
  agentStatusDisplayKey,
  agentStatusRows,
  buildAgentStatusSnapshot,
  type AgentStatusRow,
} from "./agentStatusSnapshot";
import { publishAgentStatus } from "./publishAgentStatus";
import { createWidgetTheme } from "./widgetTheme";

// Null while no environment is live: the widget keeps its last snapshot and lets it expire.
const rowsAtom = Atom.make((get) => {
  const liveEnvironmentIds = new Set<EnvironmentId>(
    get(workspaceConnections.environmentsAtom)
      .filter(
        (environment) =>
          environment.isEnabled &&
          environment.connectionState === "connected" &&
          get(environmentShell.stateValueAtom(environment.environmentId)).status === "live",
      )
      .map((environment) => environment.environmentId),
  );
  if (liveEnvironmentIds.size === 0) return null;
  return agentStatusRows({
    threads: get(environmentThreadShells.threadShellsAtom),
    projects: get(environmentProjects.projectsAtom),
    liveEnvironmentIds,
  });
}).pipe(
  Atom.withEquality<ReadonlyArray<AgentStatusRow> | null>(
    (a, b) => agentStatusDisplayKey(a) === agentStatusDisplayKey(b),
  ),
);

function subscribeToAppState(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

// Notification Center and the app switcher pass through inactive; only leaving or returning republishes.
function currentAppState() {
  return AppState.currentState === "background" ? "background" : "active";
}

export function AgentStatusCoordinator() {
  const { themeMode, themeVariablesByAppearance, isReady } = useAppearancePreferences();
  const liveRows = useAtomValue(rowsAtom);
  const rows = useAtomValue(showcaseAgentStatusRowsAtom) ?? liveRows;
  const appState = useSyncExternalStore(subscribeToAppState, currentAppState, currentAppState);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes agent status to the native home screen widget
  useEffect(() => {
    if (!isReady || rows === null) return;
    void Promise.resolve()
      .then(() =>
        publishAgentStatus({
          ...buildAgentStatusSnapshot(rows, { now: Date.now() }),
          theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        }),
      )
      .catch((error: unknown) => {
        console.warn("Could not update agent status widget", error);
      });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving or entering the app restarts the snapshot's freshness window while the connection is still live.
  }, [isReady, rows, themeMode, themeVariablesByAppearance, appState]);
  return null;
}
