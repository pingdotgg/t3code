import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopAgentActivitySnapshotInput,
  DesktopAgentActivitySource,
  EnvironmentId,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { environmentShell } from "../state/shell";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

const HEARTBEAT_MS = 15_000;
const TERMINAL_VISIBILITY_MS = 15 * 60_000;

export function visibleDesktopAgentActivities(
  activities: readonly DesktopAgentActivitySource[],
  now: number,
) {
  return activities.filter((activity) => {
    if (activity.phase !== "completed" && activity.phase !== "failed") return true;
    const updatedAt = Date.parse(activity.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt <= TERMINAL_VISIBILITY_MS;
  });
}

export const desktopAgentActivitiesAtom = Atom.make((get) => {
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const activities: DesktopAgentActivitySource[] = [];

  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (environmentId === primaryEnvironmentId) continue;
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;

    const projectById = new Map(
      shell.snapshot.value.projects.map((project) => [project.id, project]),
    );
    for (const thread of shell.snapshot.value.threads) {
      const project = projectById.get(thread.projectId);
      if (!project) continue;
      const awareness = projectThreadAwareness({
        environmentId: environmentId as EnvironmentId,
        project,
        thread,
      });
      if (!awareness) continue;
      activities.push({
        sourceId: `${environmentId}:${thread.id}`,
        label: `${entry.target.label} · ${thread.title || project.title}`,
        phase: awareness.phase,
        updatedAt: awareness.updatedAt,
      });
    }
  }

  return activities.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}).pipe(Atom.withLabel("desktop-agent-activities"));

export function DesktopAgentActivityBridge() {
  const activities = useAtomValue(desktopAgentActivitiesAtom);
  const settingsHydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.agentActivitySnapshotEnabled);

  useEffect(() => {
    if (!settingsHydrated) return;
    if (!enabled) {
      void window.desktopBridge?.clearAgentActivitySnapshot?.().catch((error: unknown) => {
        console.warn("Could not clear the desktop agent activity snapshot.", error);
      });
      return;
    }

    const publish = () => {
      const bridge = window.desktopBridge?.publishAgentActivitySnapshot;
      if (!bridge) return;
      const now = Date.now();
      const visibleActivities = visibleDesktopAgentActivities(activities, now);
      const snapshot: DesktopAgentActivitySnapshotInput = {
        schemaVersion: 1,
        generatedAt: new Date(now).toISOString(),
        activities: visibleActivities,
      };
      void bridge(snapshot).catch((error: unknown) => {
        console.warn("Could not publish the desktop agent activity snapshot.", error);
      });
    };

    publish();
    const heartbeat = window.setInterval(publish, HEARTBEAT_MS);
    return () => window.clearInterval(heartbeat);
  }, [activities, enabled, settingsHydrated]);

  return null;
}
