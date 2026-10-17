import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { environmentSnapshotAtom } from "~/state/shell";
import { shouldLiveRefresh } from "./useLiveRefresh";

const completedTurns = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<{
      environmentId: EnvironmentId;
      projectId?: ProjectId | undefined;
    }>;
    return targets
      .map(({ environmentId, projectId }) => {
        let completedAt = 0;
        for (const thread of get(environmentSnapshotAtom(environmentId))?.threads ?? []) {
          if (projectId !== undefined && thread.projectId !== projectId) continue;
          if (thread.latestRunCompletedAt != null) {
            completedAt = Math.max(
              completedAt,
              DateTime.toEpochMillis(thread.latestRunCompletedAt),
            );
          }
        }
        return completedAt;
      })
      .join(",");
  }),
);

export function useIssueViewRefresh(
  refresh: () => void,
  targets: ReadonlyArray<{
    environmentId: EnvironmentId;
    input: { projectId?: ProjectId | undefined };
  }>,
  viewKey: string,
) {
  const revision = useAtomValue(
    completedTurns(
      JSON.stringify(
        targets.map(({ environmentId, input }) => ({ environmentId, projectId: input.projectId })),
      ),
    ),
  );
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  const lastRead = useRef(0);
  useEffect(() => {
    lastRead.current = Date.now();
  }, []);
  const previous = useRef({ viewKey, revision });

  useEffect(() => {
    const changed = previous.current.viewKey === viewKey && previous.current.revision !== revision;
    previous.current = { viewKey, revision };
    if (changed && document.visibilityState === "visible") {
      lastRead.current = Date.now();
      latest.current();
    }
  }, [viewKey, revision]);

  useEffect(() => {
    const refreshView = () => {
      const now = Date.now();
      if (
        !shouldLiveRefresh({
          visible: document.visibilityState === "visible",
          now,
          lastRefreshedAt: lastRead.current,
        })
      )
        return;
      lastRead.current = now;
      latest.current();
    };
    window.addEventListener("focus", refreshView);
    document.addEventListener("visibilitychange", refreshView);
    return () => {
      window.removeEventListener("focus", refreshView);
      document.removeEventListener("visibilitychange", refreshView);
    };
  }, []);
}
