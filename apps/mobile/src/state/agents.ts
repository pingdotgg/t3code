import { useAtomValue } from "@effect/atom-react";
import {
  agentColorFor,
  selectScheduledWakeThreadKeys,
  type AgentScheduledWake,
} from "@t3tools/client-runtime/state/agents";
import {
  createAgentProfilesAtom,
  createEnvironmentAgentsAtom,
  resolveAgentIconId,
  type AgentIconId,
  type EnvironmentAgents,
} from "@t3tools/client-runtime/state/agentIdentity";
import type { EnvironmentId, McpGatewayProfile, ThreadProfileSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** Every connected environment's agents, merged into one library as web does. */
export const agentProfilesAtom = createAgentProfilesAtom(() => environmentServerConfigsAtom);

export function useAgentProfiles(): ReadonlyArray<McpGatewayProfile> {
  return useAtomValue(agentProfilesAtom);
}

const environmentAgentsAtom = createEnvironmentAgentsAtom((environmentId) =>
  serverEnvironment.configValueAtom(environmentId),
);

/** The agents `@` mentions can name and resolve on one environment: its own library only. */
export function useEnvironmentAgents(
  environmentId: EnvironmentId | null | undefined,
): EnvironmentAgents {
  return useAtomValue(environmentAgentsAtom(environmentId ?? null));
}

/** Keys of threads a scheduled task will wake later, so the board reads them as Waiting. */
const scheduledWakeThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const tasks: AgentScheduledWake[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.scheduledTasks !== true) continue;
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const task of snapshot?.tasks ?? []) tasks.push({ environmentId, task });
  }
  return selectScheduledWakeThreadKeys(tasks);
});

export function useScheduledWakeThreadKeys(): ReadonlySet<string> {
  return useAtomValue(scheduledWakeThreadKeysAtom);
}

export interface AgentAppearance {
  readonly profileId: string;
  readonly name: string;
  readonly icon: AgentIconId;
  /** Null for an agent that no longer exists in any connected library. */
  readonly color: string | null;
}

export function agentAppearance(
  profile: McpGatewayProfile,
  profiles: ReadonlyArray<McpGatewayProfile>,
): AgentAppearance {
  return {
    profileId: profile.profileId,
    name: profile.name,
    icon: resolveAgentIconId(profile),
    color: agentColorFor(profile, profiles),
  };
}

/**
 * The agent a thread runs as. The live profile wins so renames and recolors
 * show everywhere; a deleted agent keeps the name frozen onto the thread.
 */
export function threadAgentAppearance(
  snapshot: Pick<ThreadProfileSnapshot, "profileId" | "profileName"> | null | undefined,
  profiles: ReadonlyArray<McpGatewayProfile>,
): AgentAppearance | null {
  if (!snapshot?.profileId) return null;
  const profile = profiles.find((candidate) => candidate.profileId === snapshot.profileId);
  if (profile) return agentAppearance(profile, profiles);
  return {
    profileId: snapshot.profileId,
    name: snapshot.profileName ?? "Agent",
    icon: "orb",
    color: null,
  };
}

export function useThreadAgent(
  snapshot: Pick<ThreadProfileSnapshot, "profileId" | "profileName"> | null | undefined,
): AgentAppearance | null {
  const profiles = useAgentProfiles();
  const profileId = snapshot?.profileId;
  const profileName = snapshot?.profileName;
  return useMemo(
    () =>
      threadAgentAppearance(
        profileId ? { profileId, profileName: profileName ?? null } : null,
        profiles,
      ),
    [profileId, profileName, profiles],
  );
}

/** "Claude · Opus 4.6", from the readable labels the agent editor saves. */
export function agentModelLabel(profile: McpGatewayProfile): string | null {
  const label = [profile.providerLabel, profile.modelLabel ?? profile.modelSelection?.model]
    .filter(Boolean)
    .join(" · ");
  return label.length > 0 ? label : null;
}

export function useAgentAppearance(profileId: string | null | undefined): AgentAppearance | null {
  const profiles = useAgentProfiles();
  return useMemo(() => {
    const profile = profileId
      ? profiles.find((candidate) => candidate.profileId === profileId)
      : undefined;
    return profile ? agentAppearance(profile, profiles) : null;
  }, [profileId, profiles]);
}
