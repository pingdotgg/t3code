import {
  type EnvironmentId,
  isProviderWorkspaceSnapshotCurrent,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { deadlineStore } from "./clock.ts";
import { type AtomCommand, runAtomCommand } from "./state/runtime.ts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Exclude disabled and agent-only skills (Claude Code's `user-invocable: false`).
 * Skills the agent cannot start on its own can still be invoked by users in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function hasCompleteProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(snapshot && !snapshot.slashCommandsPending);
}

function hasCurrentProviderWorkspaceSnapshot(
  provider: ServerProvider | null | undefined,
  cwd: string | null | undefined,
  nowMs: number,
): boolean {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  return Boolean(
    snapshot &&
    !snapshot.slashCommandsPending &&
    isProviderWorkspaceSnapshotCurrent(snapshot, nowMs),
  );
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;
// A cwd that never scans, such as a deleted worktree, would otherwise retry forever.
const WORKSPACE_SNAPSHOT_MAX_ATTEMPTS = 3;

interface ProviderWorkspaceSnapshotRefreshState {
  /**
   * When the last scan was requested. A request inside the TTL is not
   * repeated, so a client clock ahead of the server's cannot loop rescans.
   */
  readonly requestedAt: number | null;
  /** A failed scan is not retried before this time. */
  readonly retryNotBefore: number | null;
  /** Scans in a row that ended without a complete snapshot. */
  readonly failedAttempts: number;
  readonly hadSnapshot: boolean;
}

const initialProviderWorkspaceSnapshotRefreshState: ProviderWorkspaceSnapshotRefreshState = {
  requestedAt: null,
  retryNotBefore: null,
  failedAttempts: 0,
  hadSnapshot: false,
};

/**
 * Decides whether a composer looking at `cwd` should ask the server to rescan
 * the provider's workspace, and when to look again if a retry is due while the
 * server still reports the scan as pending.
 */
function planProviderWorkspaceSnapshotRefresh(
  previous: ProviderWorkspaceSnapshotRefreshState,
  provider: ServerProvider | null | undefined,
  cwd: string,
  now: number,
): {
  readonly state: ProviderWorkspaceSnapshotRefreshState;
  readonly refresh: boolean;
  readonly recheckAt: number | null;
} {
  const hasSnapshot = hasCompleteProviderWorkspaceSnapshot(provider, cwd);
  // Losing a snapshot (the server dropped it) lifts both the TTL and the retry
  // cooldown so the scan happens at once.
  const lost = previous.hadSnapshot && !hasSnapshot;
  const requestedAt = lost ? null : previous.requestedAt;
  const retryNotBefore =
    lost || (previous.retryNotBefore !== null && now >= previous.retryNotBefore)
      ? null
      : previous.retryNotBefore;
  const state = {
    requestedAt,
    retryNotBefore,
    // A complete snapshot ends the run of failures.
    failedAttempts: hasSnapshot ? 0 : previous.failedAttempts,
    hadSnapshot: hasSnapshot,
  };
  const refresh =
    (requestedAt === null || now - requestedAt >= PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS) &&
    !hasCurrentProviderWorkspaceSnapshot(provider, cwd, now) &&
    retryNotBefore === null;
  if (refresh) {
    return { state: { ...state, requestedAt: now }, refresh: true, recheckAt: null };
  }
  const pending =
    (provider && resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommandsPending) === true;
  return { state, refresh: false, recheckAt: pending ? retryNotBefore : null };
}

/**
 * A scan that failed, or finished without a complete snapshot, cools down
 * before retrying. After the last attempt the request marker stays, so only
 * the TTL (or a snapshot loss) lets the next scan through.
 */
function failProviderWorkspaceSnapshotRefresh(
  state: ProviderWorkspaceSnapshotRefreshState,
  requestedAt: number,
  now: number,
): ProviderWorkspaceSnapshotRefreshState {
  // A newer request, or a snapshot loss, already superseded this one.
  if (state.requestedAt !== requestedAt) return state;
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts >= WORKSPACE_SNAPSHOT_MAX_ATTEMPTS) return { ...state, failedAttempts };
  return {
    ...state,
    requestedAt: null,
    retryNotBefore: now + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
    failedAttempts,
  };
}

type WorkspaceSnapshotStatus = "absent" | "pending" | "complete";

function resolveWorkspaceSnapshotStatus(
  provider: ServerProvider | undefined,
  cwd: string,
): WorkspaceSnapshotStatus {
  const snapshot = provider && resolveProviderWorkspaceSnapshot(provider, cwd);
  if (!snapshot) return "absent";
  return snapshot.slashCommandsPending ? "pending" : "complete";
}

interface ProviderWorkspaceSnapshotRefreshTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}

/**
 * Keeps one environment/provider/cwd workspace snapshot fresh while mounted:
 * reading scans when it is missing or stale, and refreshing re-checks (the
 * composer does as the user types). It owns the retry timer, so the timer dies
 * with the last subscriber.
 */
export function createProviderWorkspaceSnapshotRefreshAtomFamily(input: {
  readonly providers: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<ServerProvider> | null>;
  readonly refreshProviders: AtomCommand<
    {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly instanceId: ProviderInstanceId; readonly cwd: string };
    },
    { readonly providers: ReadonlyArray<ServerProvider> },
    unknown
  >;
}) {
  // Plain-object keys compare structurally (Effect `Equal`/`Hash`).
  const family = Atom.family((target: ProviderWorkspaceSnapshotRefreshTarget) => {
    const { environmentId, instanceId, cwd } = target;
    const key = `${environmentId}:${instanceId}:${cwd}`;
    const findProvider = (providers: ReadonlyArray<ServerProvider> | null) =>
      providers?.find((provider) => provider.instanceId === instanceId);
    const statusAtom = Atom.make((get) =>
      resolveWorkspaceSnapshotStatus(findProvider(get(input.providers(environmentId))), cwd),
    ).pipe(Atom.withLabel(`provider-workspace-snapshot-status:${key}`));
    type Update = (
      state: ProviderWorkspaceSnapshotRefreshState,
    ) => ProviderWorkspaceSnapshotRefreshState;
    const refreshAtom: Atom.Writable<ProviderWorkspaceSnapshotRefreshState, Update> = Atom.writable(
      (get): ProviderWorkspaceSnapshotRefreshState => {
        get(statusAtom);
        // `once`: unrelated provider updates must not trigger a check.
        const provider = findProvider(get.once(input.providers(environmentId)));
        // @effect-diagnostics-next-line globalDate:off
        const now = Date.now();
        const previous = get.self<ProviderWorkspaceSnapshotRefreshState>();
        const plan = planProviderWorkspaceSnapshotRefresh(
          previous._tag === "Some" ? previous.value : initialProviderWorkspaceSnapshotRefreshState,
          provider,
          cwd,
          now,
        );
        if (plan.recheckAt !== null) {
          get.addFinalizer(deadlineStore(plan.recheckAt).subscribe(() => get.refreshSelf()));
        }
        if (!plan.refresh) return plan.state;
        const registry = get.registry;
        // Outlives this build on purpose: a rebuild must not drop the retry.
        // Once nothing subscribes, the retry state dies with the node; writing
        // would recreate and rebuild it, which scans again with no subscriber.
        const retryLater = () => {
          const node = registry.getNodes().get(refreshAtom);
          if (node === undefined || node.canBeRemoved) return;
          registry.set(refreshAtom, (state) =>
            // @effect-diagnostics-next-line globalDate:off
            failProviderWorkspaceSnapshotRefresh(state, now, Date.now()),
          );
        };
        void runAtomCommand(
          registry,
          input.refreshProviders,
          { environmentId, input: { instanceId, cwd } },
          { reportFailure: false },
        ).then((result) => {
          const refreshed =
            result._tag === "Success" &&
            hasCompleteProviderWorkspaceSnapshot(findProvider(result.value.providers), cwd);
          if (!refreshed) retryLater();
        }, retryLater);
        return plan.state;
      },
      (ctx, update: Update) => {
        ctx.setSelf(update(ctx.get(refreshAtom)));
        ctx.refreshSelf();
      },
    ).pipe(Atom.withLabel(`provider-workspace-snapshot-refresh:${key}`));
    return refreshAtom;
  });
  return (target: ProviderWorkspaceSnapshotRefreshTarget): Atom.Atom<unknown> =>
    family({ environmentId: target.environmentId, instanceId: target.instanceId, cwd: target.cwd });
}
