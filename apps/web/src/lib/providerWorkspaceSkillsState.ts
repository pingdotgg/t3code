import {
  EMPTY_PROVIDER_WORKSPACE_SKILLS,
  formatProviderWorkspaceSkillsError,
  PROVIDER_WORKSPACE_SKILLS_UNAVAILABLE_MESSAGE,
  providerWorkspaceSkillsTargetKey,
  resolveNextProviderWorkspaceSkillsSnapshot,
  resolveProviderWorkspaceSkills,
  type ProviderWorkspaceSkillsSnapshot,
  type ProviderWorkspaceSkillsState,
  type ProviderWorkspaceSkillsTarget,
} from "@t3tools/client-runtime/state/provider-workspace-skills";
import { useEffect, useMemo, useRef } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      cwd: target.cwd?.trim() || null,
      enabled: target.enabled,
      connectionAvailable: target.connectionAvailable !== false,
    }),
    [
      target.connectionAvailable,
      target.cwd,
      target.enabled,
      target.environmentId,
      target.instanceId,
    ],
  );
  const targetKey = providerWorkspaceSkillsTargetKey({ ...stableTarget, enabled: true });
  const key = stableTarget.enabled ? targetKey : null;
  const unavailable = key !== null && !stableTarget.connectionAvailable;
  const query = useEnvironmentQuery(
    key !== null &&
      !unavailable &&
      stableTarget.environmentId !== null &&
      stableTarget.instanceId !== null
      ? serverEnvironment.providerSkills({
          environmentId: stableTarget.environmentId,
          input: {
            instanceId: stableTarget.instanceId,
            cwd: stableTarget.cwd!,
          },
        })
      : null,
  );

  const previousWorkspaceSkillsRef = useRef<ProviderWorkspaceSkillsSnapshot | null>(null);
  const querySkills = query.data?.skills ?? null;
  useEffect(() => {
    previousWorkspaceSkillsRef.current = resolveNextProviderWorkspaceSkillsSnapshot({
      key: targetKey,
      skills: querySkills,
      isPending: query.isPending,
      error: query.error,
      inactive: key === null,
      unavailable,
      current: previousWorkspaceSkillsRef.current,
    });
  }, [key, query.error, query.isPending, querySkills, targetKey, unavailable]);

  if (key === null) {
    return { skills: target.fallbackSkills, isPending: false, error: null };
  }
  const previousWorkspaceSkills = previousWorkspaceSkillsRef.current;
  return {
    skills: resolveProviderWorkspaceSkills({
      nextKey: key,
      nextSkills: querySkills,
      isPending: query.isPending,
      error: query.error,
      unavailable,
      currentKey: previousWorkspaceSkills?.key ?? null,
      currentSkills: previousWorkspaceSkills?.skills ?? EMPTY_PROVIDER_WORKSPACE_SKILLS,
      fallbackSkills: target.fallbackSkills,
    }),
    isPending: unavailable ? false : query.isPending,
    error: unavailable
      ? PROVIDER_WORKSPACE_SKILLS_UNAVAILABLE_MESSAGE
      : formatProviderWorkspaceSkillsError({ error: query.error, cause: query.errorCause }),
  };
}
