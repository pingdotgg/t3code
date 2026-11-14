import {
  type ProviderInstanceId,
  type ServerConfig,
  type ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

type ServerProviderEntry = ServerConfig["providers"][number];

/**
 * The provider-wide fields a workspace snapshot builds on. A live session, a sign-out, or a
 * /usage-limits change shows up here, so a snapshot fetched before it no longer applies.
 */
const snapshotBasis = (provider: ServerProviderEntry | undefined) =>
  provider && {
    enabled: provider.enabled,
    slashCommands: provider.slashCommands,
    skills: provider.skills,
  };

export interface FetchedWorkspaceSnapshot {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: ServerProviderWorkspaceSnapshot;
  readonly basis: ReturnType<typeof snapshotBasis>;
}

const MAX_FETCHED_WORKSPACE_SNAPSHOTS = 32;

/**
 * Servers with `providerWorkspaceSnapshotsOnDemand` leave per-cwd snapshots out of the config,
 * so the ones this client fetched are merged back in. Older servers send every snapshot and
 * their drops, so their config is used as is.
 */
export function withFetchedWorkspaceSnapshots(
  config: ServerConfig,
  fetched: ReadonlyArray<FetchedWorkspaceSnapshot>,
): ServerConfig {
  if (
    fetched.length === 0 ||
    config.environment.capabilities.providerWorkspaceSnapshotsOnDemand !== true
  ) {
    return config;
  }
  return {
    ...config,
    providers: config.providers.map((provider) => {
      // A dropped snapshot reads as lost, and the composer fetches it again.
      const own = fetched.filter(
        (entry) =>
          entry.instanceId === provider.instanceId &&
          Equal.equals(entry.basis, snapshotBasis(provider)),
      );
      return own.length === 0
        ? provider
        : { ...provider, workspaceSnapshots: own.map((entry) => entry.snapshot) };
    }),
  };
}

export function recordFetchedWorkspaceSnapshot(
  current: ReadonlyArray<FetchedWorkspaceSnapshot>,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string; readonly fresh: boolean },
  providers: ServerConfig["providers"],
  configProvider: ServerProviderEntry | undefined,
): ReadonlyArray<FetchedWorkspaceSnapshot> {
  const basis = snapshotBasis(configProvider);
  const snapshot = providers
    .find((provider) => provider.instanceId === input.instanceId)
    ?.workspaceSnapshots?.find((candidate) => candidate.cwd === input.cwd);
  const stored = current.find(
    (entry) => entry.instanceId === input.instanceId && entry.snapshot.cwd === input.cwd,
  );
  // A cached answer from the server would otherwise re-render every config reader.
  if (
    !input.fresh &&
    snapshot &&
    stored &&
    Equal.equals(stored.snapshot, snapshot) &&
    Equal.equals(stored.basis, basis)
  ) {
    return current;
  }
  // A fresh scan drops the cwd's snapshots for every provider, as the server does.
  const kept = current.filter(
    (entry) =>
      entry.snapshot.cwd !== input.cwd || (!input.fresh && entry.instanceId !== input.instanceId),
  );
  if (!snapshot) return kept.length === current.length ? current : kept;
  return [...kept, { instanceId: input.instanceId, snapshot, basis }].slice(
    -MAX_FETCHED_WORKSPACE_SNAPSHOTS,
  );
}
