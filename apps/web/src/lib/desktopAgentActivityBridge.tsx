import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopBridge,
  DesktopAgentActivitySnapshotInput,
  DesktopAgentActivitySource,
  EnvironmentId,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { environmentShell } from "../state/shell";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

const HEARTBEAT_MS = 15_000;
const TERMINAL_VISIBILITY_MS = 15 * 60_000;

type SnapshotOperation =
  | { readonly type: "publish"; readonly snapshot: DesktopAgentActivitySnapshotInput }
  | { readonly type: "clear" };

type SnapshotBridge = Pick<
  DesktopBridge,
  "publishAgentActivitySnapshot" | "clearAgentActivitySnapshot"
>;

export function createDesktopAgentActivityWriter(
  bridge: SnapshotBridge | undefined,
  onError: (operation: SnapshotOperation["type"], error: unknown) => void,
) {
  let pending: SnapshotOperation | null = null;
  let running = false;
  let idleResolvers: Array<() => void> = [];

  const drain = async () => {
    running = true;
    while (pending) {
      const operation = pending;
      pending = null;
      try {
        if (operation.type === "publish") {
          await bridge?.publishAgentActivitySnapshot?.(operation.snapshot);
        } else {
          await bridge?.clearAgentActivitySnapshot?.();
        }
      } catch (error) {
        onError(operation.type, error);
      }
    }
    running = false;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const enqueue = (operation: SnapshotOperation): Promise<void> => {
    pending = operation;
    const idle = new Promise<void>((resolve) => idleResolvers.push(resolve));
    if (!running) void drain();
    return idle;
  };

  return {
    publish: (snapshot: DesktopAgentActivitySnapshotInput) =>
      enqueue({ type: "publish", snapshot }),
    clear: () => enqueue({ type: "clear" }),
  };
}

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
  const writerRef = useRef<ReturnType<typeof createDesktopAgentActivityWriter> | null>(null);
  writerRef.current ??= createDesktopAgentActivityWriter(
    window.desktopBridge,
    (operation, error) => {
      console.warn(`Could not ${operation} the desktop agent activity snapshot.`, error);
    },
  );
  const writer = writerRef.current;

  useEffect(() => {
    if (!settingsHydrated) return;
    if (!enabled) {
      void writer.clear();
      return;
    }

    let active = true;
    const publish = () => {
      if (!active) return;
      const now = Date.now();
      const visibleActivities = visibleDesktopAgentActivities(activities, now);
      const snapshot: DesktopAgentActivitySnapshotInput = {
        schemaVersion: 1,
        generatedAt: new Date(now).toISOString(),
        activities: visibleActivities,
      };
      void writer.publish(snapshot);
    };

    publish();
    const heartbeat = window.setInterval(publish, HEARTBEAT_MS);
    return () => {
      active = false;
      window.clearInterval(heartbeat);
    };
  }, [activities, enabled, settingsHydrated, writer]);

  return null;
}
