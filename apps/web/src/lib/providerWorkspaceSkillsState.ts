import {
  ServerProviderSkillsListError,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

export interface ProviderWorkspaceSkillsTarget {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly fallbackSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsState {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly isPending: boolean;
  readonly error: string | null;
}

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const isServerProviderSkillsListError = Schema.is(ServerProviderSkillsListError);

export interface ProviderWorkspaceSkillsSnapshotInput {
  readonly currentKey: string | null;
  readonly nextKey: string;
  readonly currentSkills: ReadonlyArray<ServerProviderSkill>;
}

export interface ProviderWorkspaceSkillsResolutionInput extends ProviderWorkspaceSkillsSnapshotInput {
  readonly nextSkills: ReadonlyArray<ServerProviderSkill> | null;
  readonly isPending: boolean;
}

export interface ProviderWorkspaceSkillsSnapshot {
  readonly key: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

function targetKey(target: Omit<ProviderWorkspaceSkillsTarget, "fallbackSkills">): string | null {
  if (
    !target.enabled ||
    target.environmentId === null ||
    target.instanceId === null ||
    target.cwd === null ||
    target.cwd.trim().length === 0
  ) {
    return null;
  }
  return `${target.environmentId}:${target.instanceId}:${target.cwd.trim()}`;
}

function providerSkillsListErrorDetail(error: unknown): {
  readonly detail: string | null;
} | null {
  if (!isServerProviderSkillsListError(error)) return null;
  return {
    detail:
      typeof error.detail === "string" && error.detail.trim().length > 0 ? error.detail : null,
  };
}

export function formatProviderWorkspaceSkillsError(input: {
  readonly error: string | null;
  readonly cause: Cause.Cause<unknown> | null;
}): string | null {
  if (input.error === null) return null;
  if (input.cause === null) return input.error;

  const providerError = providerSkillsListErrorDetail(Cause.squash(input.cause));
  if (providerError === null || providerError.detail === null) return input.error;
  if (input.error.includes(providerError.detail)) return input.error;
  return `${input.error} ${providerError.detail}`;
}

export function invalidateProviderWorkspaceSkills(): void {
  // Workspace skill requests are now owned by the environment query cache.
}

export function resolvePendingProviderWorkspaceSkills(
  input: ProviderWorkspaceSkillsSnapshotInput,
): ReadonlyArray<ServerProviderSkill> {
  return input.currentKey === input.nextKey && input.currentSkills.length > 0
    ? input.currentSkills
    : EMPTY_SKILLS;
}

/**
 * Query result arrays are readonly cache values, so these helpers preserve references
 * and rely on callers to keep them immutable.
 */
export function resolveProviderWorkspaceSkills(
  input: ProviderWorkspaceSkillsResolutionInput,
): ReadonlyArray<ServerProviderSkill> {
  if (input.nextSkills !== null) return input.nextSkills;
  if (!input.isPending) return EMPTY_SKILLS;
  return resolvePendingProviderWorkspaceSkills(input);
}

export function resolveNextProviderWorkspaceSkillsSnapshot(input: {
  readonly key: string | null;
  readonly skills: ReadonlyArray<ServerProviderSkill> | null;
  readonly isPending: boolean;
  readonly current: ProviderWorkspaceSkillsSnapshot | null;
}): ProviderWorkspaceSkillsSnapshot | null {
  if (input.key === null) return null;
  if (input.skills === null) return input.isPending ? input.current : null;
  return input.isPending ? input.current : { key: input.key, skills: input.skills };
}

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      instanceId: target.instanceId,
      cwd: target.cwd?.trim() || null,
      enabled: target.enabled,
    }),
    [target.cwd, target.enabled, target.environmentId, target.instanceId],
  );
  const key = targetKey(stableTarget);
  const query = useEnvironmentQuery(
    key !== null && stableTarget.environmentId !== null && stableTarget.instanceId !== null
      ? serverEnvironment.providerSkills({
          environmentId: stableTarget.environmentId,
          input: {
            instanceId: stableTarget.instanceId,
            cwd: stableTarget.cwd!,
          },
        })
      : null,
  );

  const previousFallbackSkillsRef = useRef(target.fallbackSkills);
  useEffect(() => {
    if (previousFallbackSkillsRef.current === target.fallbackSkills) return;
    previousFallbackSkillsRef.current = target.fallbackSkills;
    if (key !== null) query.refresh();
  }, [key, query, target.fallbackSkills]);
  const previousWorkspaceSkillsRef = useRef<ProviderWorkspaceSkillsSnapshot | null>(null);
  const querySkills = query.data?.skills ?? null;
  useEffect(() => {
    previousWorkspaceSkillsRef.current = resolveNextProviderWorkspaceSkillsSnapshot({
      key,
      skills: querySkills,
      isPending: query.isPending,
      current: previousWorkspaceSkillsRef.current,
    });
  }, [key, query.isPending, querySkills]);

  if (key === null) {
    return { skills: target.fallbackSkills, isPending: false, error: null };
  }
  const previousWorkspaceSkills = previousWorkspaceSkillsRef.current;
  return {
    skills: resolveProviderWorkspaceSkills({
      nextKey: key,
      nextSkills: querySkills,
      isPending: query.isPending,
      currentKey: previousWorkspaceSkills?.key ?? null,
      currentSkills: previousWorkspaceSkills?.skills ?? EMPTY_SKILLS,
    }),
    isPending: query.isPending,
    error: formatProviderWorkspaceSkillsError({ error: query.error, cause: query.errorCause }),
  };
}
