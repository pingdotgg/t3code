import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  subscribeProviderInvalidations,
} from "../environments/runtime";

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

interface InternalProviderWorkspaceSkillsState extends ProviderWorkspaceSkillsState {
  readonly key: string | null;
}

const cache = new Map<string, ReadonlyArray<ServerProviderSkill>>();
const CACHE_MAX_ENTRIES = 100;

const listeners = new Set<() => void>();
let unsubscribeEnvironmentConnections: (() => void) | null = null;
let unsubscribeProviderInvalidations: (() => void) | null = null;

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function clearCacheAndNotify(): void {
  invalidateProviderWorkspaceSkills();
  notifyListeners();
}

function setCachedSkills(key: string, skills: ReadonlyArray<ServerProviderSkill>): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, skills);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function subscribeWorkspaceSkillChanges(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribeEnvironmentConnections = subscribeEnvironmentConnections(clearCacheAndNotify);
    unsubscribeProviderInvalidations = subscribeProviderInvalidations(clearCacheAndNotify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeEnvironmentConnections?.();
      unsubscribeEnvironmentConnections = null;
      unsubscribeProviderInvalidations?.();
      unsubscribeProviderInvalidations = null;
      invalidateProviderWorkspaceSkills();
    }
  };
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

export function invalidateProviderWorkspaceSkills(): void {
  cache.clear();
}

export function useProviderWorkspaceSkills(
  target: ProviderWorkspaceSkillsTarget,
): ProviderWorkspaceSkillsState {
  const fallbackSkillsRef = useRef(target.fallbackSkills);
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
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [state, setState] = useState<InternalProviderWorkspaceSkillsState>(() => ({
    key,
    skills: target.fallbackSkills,
    isPending: false,
    error: null,
  }));

  useEffect(() => {
    fallbackSkillsRef.current = target.fallbackSkills;
    if (key === null) {
      setState({ key: null, skills: target.fallbackSkills, isPending: false, error: null });
    }
  }, [key, target.fallbackSkills]);

  useEffect(
    () => subscribeWorkspaceSkillChanges(() => setConnectionVersion((version) => version + 1)),
    [],
  );

  useEffect(() => {
    if (
      key === null ||
      stableTarget.environmentId === null ||
      stableTarget.instanceId === null ||
      stableTarget.cwd === null
    ) {
      setState({ key, skills: fallbackSkillsRef.current, isPending: false, error: null });
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      setState({ key, skills: cached, isPending: false, error: null });
      return;
    }

    const connection = readEnvironmentConnection(stableTarget.environmentId);
    if (!connection) {
      setState({
        key,
        skills: fallbackSkillsRef.current,
        isPending: false,
        error: "Remote connection is not ready.",
      });
      return;
    }

    let cancelled = false;
    setState((current) => ({
      key,
      skills:
        current.key === key && current.skills.length > 0
          ? current.skills
          : fallbackSkillsRef.current,
      isPending: true,
      error: null,
    }));
    void connection.client.server
      .listProviderSkills({
        instanceId: stableTarget.instanceId,
        cwd: stableTarget.cwd,
      })
      .then((result) => {
        if (cancelled) return;
        setCachedSkills(key, result.skills);
        setState({ key, skills: result.skills, isPending: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          key,
          skills: fallbackSkillsRef.current,
          isPending: false,
          error: error instanceof Error ? error.message : "Failed to list provider skills.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    connectionVersion,
    key,
    stableTarget.cwd,
    stableTarget.enabled,
    stableTarget.environmentId,
    stableTarget.instanceId,
  ]);

  return {
    skills: state.skills,
    isPending: state.isPending,
    error: state.error,
  };
}
