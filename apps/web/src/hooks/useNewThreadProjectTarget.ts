import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  buildProjectGroups,
  resolveNewThreadProjectRef,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useProjects } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useClientSettings } from "./useSettings";

export function useNewThreadProjectTarget(
  members?: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id">>,
) {
  const projects = useProjects();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const connectedIds = useMemo(() => new Set(connectedEnvironmentIds), [connectedEnvironmentIds]);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const settingsByEnvironment = useMemo(
    () => new Map([...configs].map(([id, config]) => [id, config.settings])),
    [configs],
  );
  const membersByProjectKey = useMemo(() => {
    if (members) return null;
    return new Map(
      buildProjectGroups({ projects, settings }).flatMap((group) => {
        const groupMembers = group.members.map((member) => member.project);
        return group.memberProjectRefs.map((ref) => [scopedProjectKey(ref), groupMembers] as const);
      }),
    );
  }, [members, projects, settings]);
  return useCallback(
    (projectRef: ScopedProjectRef, options?: { readonly manual?: boolean }) => {
      return resolveNewThreadProjectRef({
        members: members ?? membersByProjectKey?.get(scopedProjectKey(projectRef)) ?? [],
        settingsByEnvironment,
        connectedEnvironmentIds: connectedIds,
        contextProjectRef: projectRef,
        primaryEnvironmentId,
        manualProjectRef: options?.manual ? projectRef : null,
      });
    },
    [connectedIds, members, membersByProjectKey, primaryEnvironmentId, settingsByEnvironment],
  );
}
