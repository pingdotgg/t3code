import type { OrchestrationSessionStatus } from "@t3tools/contracts";

export type AgentStopSoundSource = "tone" | "system";
export type AgentStopStatusLabel = "finished" | "awaiting input" | "errored";

export interface AgentStopNotifySettings {
  readonly popup: boolean;
  readonly sound: boolean;
  readonly soundSource: AgentStopSoundSource;
}

/** Structural subset of EnvironmentThreadShell needed to decide notifications. */
export interface ThreadShellLike {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly title: string;
  readonly session: { readonly status: OrchestrationSessionStatus } | null;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingApprovals: boolean;
}

/** Structural subset of EnvironmentProject needed to resolve a project name. */
export interface ProjectLike {
  readonly id: string;
  readonly title: string;
}

export interface AgentStopNotification {
  readonly threadId: string;
  readonly environmentId: string;
  readonly title: string;
  readonly body: string;
  readonly status: AgentStopStatusLabel;
}

export interface AgentStopDecisionInput {
  readonly prevStatuses: ReadonlyMap<string, OrchestrationSessionStatus>;
  readonly threads: readonly ThreadShellLike[];
  readonly projects: readonly ProjectLike[];
  readonly settings: AgentStopNotifySettings;
  readonly activeThreadId: string | null;
  readonly isAppFocused: boolean;
}

export interface AgentStopDecisionResult {
  readonly notifications: readonly AgentStopNotification[];
  readonly nextStatuses: ReadonlyMap<string, OrchestrationSessionStatus>;
}

// Statuses that count as an agent finishing/erroring. A user-initiated session
// *stop* surfaces as "stopped"/"interrupted" and is excluded by being absent here.
//
// KNOWN LIMITATION (accepted for v1): a user *turn interrupt* (the chat stop
// button) is indistinguishable from a natural completion in the shell snapshot,
// so the observer fires a false "finished" when a user interrupts a thread they
// are NOT currently viewing (foreground/active-thread interrupts are suppressed
// by the focus check). Why indistinguishable: on interrupt the Codex provider
// reports `turn.completed` with an interrupted (not "failed") status, so
// ProviderRuntimeIngestion settles the session to "ready"
// (apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts), and the
// turn-diff-completed projection overwrites the turn row's transient
// "interrupted" state back to "completed"
// (apps/server/src/orchestration/Layers/ProjectionPipeline.ts ~line 1263). End
// state in the shell: session.status "ready", latestTurn.state "completed" —
// byte-for-byte a natural completion. (Provider caveat: OpenCode emits a
// distinct turn.aborted, so its shape may differ.)
//
// Do NOT "fix" this by removing "ready": natural completions also land on
// "ready", so dropping it suppresses the legitimate notification. Gating on
// `latestTurn.state` does NOT work either (it is "completed" at completion time).
// A correct fix must capture the interrupt at its source — client-side, record
// the user's interrupt at ChatView.onInterrupt and suppress within a time
// window; or server-side, stop overwriting the interrupted turn state. Follow-up.
const STOP_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set(["idle", "ready", "error"]);

function statusLabel(thread: ThreadShellLike): AgentStopStatusLabel {
  if (thread.session?.status === "error") return "errored";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "awaiting input";
  return "finished";
}

/**
 * Pure decision core. Given the previously-seen per-thread statuses and the
 * current shell snapshot, returns the notifications to emit and the new
 * status map. Fires once on a `running -> idle/ready/error` edge per thread;
 * never on first sighting (baseline), never on a user-initiated session stop (surfaces as "stopped"); a user turn *interrupt* is a known false-positive for background threads (see the STOP_STATUSES note),
 * and never when the user is already focused on that exact thread.
 * `nextStatuses` is always fully rebuilt so removed threads drop out.
 */
export function decideAgentStopNotifications(
  input: AgentStopDecisionInput,
): AgentStopDecisionResult {
  const nextStatuses = new Map<string, OrchestrationSessionStatus>();
  const notifications: AgentStopNotification[] = [];

  for (const thread of input.threads) {
    const status = thread.session?.status;
    if (status === undefined) continue; // no session -> not tracked
    nextStatuses.set(thread.id, status);

    const prev = input.prevStatuses.get(thread.id);
    const transitioned = prev === "running" && STOP_STATUSES.has(status);
    if (!transitioned) continue;

    if (!input.settings.popup && !input.settings.sound) continue;
    if (input.isAppFocused && input.activeThreadId === thread.id) continue;

    const projectName =
      input.projects.find((p) => p.id === thread.projectId)?.title ?? "Unknown project";
    const label = statusLabel(thread);
    notifications.push({
      threadId: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
      body: `${projectName} · ${label}`,
      status: label,
    });
  }

  return { notifications, nextStatuses };
}
