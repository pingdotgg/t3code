import { ProjectIconSync } from "../../widgets/pseudocode/ProjectIconSync";
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { environmentCatalog } from "../../connection/catalog";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentShell, environmentShellSummaryAtom } from "../../state/shell";
import { agentWidgetContentKey, buildAgentWidgetSnapshot } from "../../widgets/agentWidgetSnapshot";
import { supportsAgentAwarenessPush } from "./capabilities";
import { saveWidgetSnapshot } from "../../widgets/widgetStorage";

const WIDGET_REFRESH_MS = 10 * 60_000;
const liveEnvironmentKeyAtom = Atom.make((get) =>
  [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))]
    .filter((environmentId) => get(environmentShell.statusAtom(environmentId)) === "live")
    .join("\n"),
);

// The React Compiler cannot lower `import()`, so it stays outside the component.
const loadWidgetLayouts = () =>
  Promise.all([
    import("../../widgets/AgentWidget"),
    import("../../widgets/pseudocode/OverviewWidget"),
  ]);

/** Updates the shared widget snapshot from existing connections, including
 * direct connections without a Cloud Connect account. No transcript subscriptions. */
function IosAgentWidgetSync() {
  const projects = useProjects();
  const threads = useThreadShells();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const shell = useAtomValue(environmentShellSummaryAtom);
  const liveEnvironmentKey = useAtomValue(liveEnvironmentKeyAtom);
  const previousContent = useRef<string | null>(null);
  const lastTick = useRef(0);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const onIcon = useCallback(
    (key: string, icon: string | null) =>
      setIcons((previous) => {
        if (previous[key] === (icon ?? undefined)) return previous;
        const next = { ...previous };
        if (icon) next[key] = icon;
        else delete next[key];
        return Object.fromEntries(Object.entries(next).slice(-32));
      }),
    [],
  );
  const activitySnapshot = useMemo(
    () => buildAgentWidgetSnapshot({ projects, threads, captureWork: true }),
    [projects, threads],
  );
  const visibleProjectKeys = new Set(
    [
      ...activitySnapshot.activities,
      ...(activitySnapshot.work?.recent ?? []),
      ...(activitySnapshot.work?.review ?? []),
    ].map((row) => `${row.environmentId}:${row.projectId}`),
  );
  const snapshot = useMemo(() => {
    const workProjectKeys = new Set(
      [...(activitySnapshot.work?.recent ?? []), ...(activitySnapshot.work?.review ?? [])].map(
        (row) => `${row.environmentId}:${row.projectId}`,
      ),
    );
    return {
      ...activitySnapshot,
      projectIcons: Object.fromEntries(
        Object.entries(icons).filter(([key]) => workProjectKeys.has(key)),
      ),
      activities: activitySnapshot.activities.map((row) => {
        const projectIcon = icons[`${row.environmentId}:${row.projectId}`];
        return { ...row, ...(projectIcon ? { projectIcon } : {}) };
      }),
    };
  }, [activitySnapshot, icons]);
  const contentKey = `${liveEnvironmentKey}:${agentWidgetContentKey(snapshot)}`;
  const canPublish = catalog.isReady && (catalog.entries.size === 0 || shell.hasSnapshot);
  const [refreshTick, setRefreshTick] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the timer that forces a periodic widget write
  useEffect(() => {
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), WIDGET_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the snapshot to the native widget's shared storage
  useEffect(() => {
    // Register the gallery layout even before a server snapshot is available.
    if (canPublish && previousContent.current === contentKey && refreshTick === lastTick.current)
      return;
    let cancelled = false;
    void loadWidgetLayouts()
      .then(async () => {
        if (cancelled || !canPublish) return;
        await saveWidgetSnapshot(
          snapshot,
          liveEnvironmentKey ? liveEnvironmentKey.split("\n") : [],
        );
        previousContent.current = contentKey;
        lastTick.current = refreshTick;
      })
      .catch((error: unknown) => {
        console.warn("Could not update the agent widget", error);
      });
    return () => {
      cancelled = true;
    };
  }, [canPublish, contentKey, liveEnvironmentKey, snapshot, refreshTick]);
  const visibleProjects = projects.filter((project) =>
    visibleProjectKeys.has(`${project.environmentId}:${project.id}`),
  );
  return visibleProjects.map((project) => (
    <ProjectIconSync
      key={`${project.environmentId}:${project.id}`}
      project={project}
      onIcon={onIcon}
    />
  ));
}

export function AgentWidgetSync() {
  return Platform.OS === "ios" && supportsAgentAwarenessPush() ? <IosAgentWidgetSync /> : null;
}
