import { useAtomValue } from "@effect/atom-react";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell, environmentSnapshotAtom } from "../state/shell";
import type { AgentActivityWidgetProps } from "./AgentActivityWidget";

const loadWidget = () => import("./AgentActivityWidget");

const snapshotAtom = Atom.make((get) => {
  const activities: AgentActivityWidgetProps["activities"][number][] = [];
  let connected = false;
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") continue;
    connected = true;
    const snapshot = get(environmentSnapshotAtom(environmentId));
    if (!snapshot) continue;
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      const project = projects.get(thread.projectId);
      if (!project) continue;
      const state = projectThreadAwarenessV2({ environmentId, project, thread });
      if (!state || state.phase === "completed" || state.phase === "failed") continue;
      activities.push({
        environmentId: state.environmentId,
        threadId: state.threadId,
        projectTitle: state.projectTitle,
        threadTitle: state.threadTitle,
        phase: state.phase,
        status: state.headline,
        deepLink: state.deepLink,
      });
    }
  }
  activities.sort((a, b) => {
    const priority = (phase: string) =>
      phase === "waiting_for_approval" || phase === "waiting_for_input" ? 0 : 1;
    return (
      priority(a.phase) - priority(b.phase) ||
      a.environmentId.localeCompare(b.environmentId) ||
      a.threadId.localeCompare(b.threadId)
    );
  });
  return { connected, activeCount: activities.length, activities: activities.slice(0, 3) };
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function AgentActivityCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  const hasEnvironments = !enabledEnvironmentIds(catalog).next().done;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes agent state to the native Home Screen widget
  useEffect(() => {
    if (!catalog.isReady || !requireOptionalNativeModule("ExpoWidgets")) return;
    if (hasEnvironments && !snapshot.connected) return;
    let disposed = false;
    const publish = () =>
      void loadWidget()
        .then(({ default: widget }) => {
          if (disposed || AppState.currentState !== "active") return;
          const now = Date.now();
          const { connected, ...activity } = snapshot;
          const props = {
            ...activity,
            expiresAt: connected ? now + 15 * 60_000 : 0,
            url: `${Linking.createURL("/")}${snapshot.activities[0]?.deepLink.slice(1) ?? ""}`,
          };
          widget.updateTimeline([
            { date: new Date(now), props },
            ...(connected ? [{ date: new Date(props.expiresAt), props }] : []),
          ]);
        })
        .catch((error: unknown) => console.warn("Could not update agent activity widget", error));
    publish();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") publish();
    });
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, [catalog.isReady, hasEnvironments, snapshot]);
  return null;
}
