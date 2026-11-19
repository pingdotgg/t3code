import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrbitGatewayEnvironment,
  OrbitConversationRef,
} from "@t3tools/client-runtime/orbit-gateway";
import type { ScopedThreadRef } from "@t3tools/contracts";

export interface OrbitAgentNavigationPorts {
  readonly source: ScopedThreadRef;
  readonly isCurrent: () => boolean;
  readonly prepare: (target: OrbitConversationRef) => Promise<void>;
  readonly handoff: (source: ScopedThreadRef, target: ScopedThreadRef) => void;
  readonly navigate: (target: ScopedThreadRef) => Promise<void>;
}

/** Where a Tasks click starts: the board, a task, or one of its subtasks, of one thread. */
export function tasksNavigationPlace(
  threadKey: string,
  shown: { readonly taskId: number | null; readonly subtaskId: number | null } | null,
): string {
  if (shown === null || shown.taskId === null) return `${threadKey}|board`;
  return `${threadKey}|${shown.taskId}|${shown.subtaskId ?? "task"}`;
}

/**
 * Click work in Tasks belongs to the place it started (one task, or the board, of one thread).
 * Leaving that place, or starting newer work, makes the pending work stale.
 */
export function createTasksNavigationGuard() {
  let place: string | null = null;
  let latest = 0;
  return {
    enter: (next: string) => {
      if (next === place) return;
      place = next;
      latest += 1;
    },
    leave: () => {
      place = null;
      latest += 1;
    },
    /** Starts work; the returned check stays true until something newer happens. */
    begin: () => {
      const request = ++latest;
      return () => request === latest;
    },
  };
}

/** Only an explicit click calls this boundary; Orbit record ids never enter routing. */
export async function openOrbitAgentConversation(
  ref: OrbitConversationRef,
  ports: OrbitAgentNavigationPorts,
): Promise<void> {
  await ports.prepare(ref);
  if (!ports.isCurrent()) return;
  const target: ScopedThreadRef = { environmentId: ref.environmentId, threadId: ref.threadId };
  if (scopedThreadKey(target) !== scopedThreadKey(ports.source))
    ports.handoff(ports.source, target);
  await ports.navigate(target);
}

export async function prepareOrbitConversationEnvironment(
  environmentId: string,
  ports: {
    known: () => boolean;
    environments:
      | (() => Promise<
          ReadonlyArray<
            Pick<OrbitGatewayEnvironment, "environmentId" | "powerState" | "registeredAt">
          >
        >)
      | null;
    connect: (
      environment: Pick<OrbitGatewayEnvironment, "environmentId" | "powerState" | "registeredAt">,
    ) => Promise<boolean>;
    enable: () => Promise<void>;
  },
): Promise<void> {
  const environment = (await ports.environments?.())?.find(
    (entry) => entry.environmentId === environmentId,
  );
  if (environment?.powerState === "stopped")
    throw new Error("This workspace is asleep. Wake it in Connections, then try again.");
  if (!ports.known()) {
    if (!environment)
      throw new Error("This environment is not paired or is no longer available in Orbit.");
    if (!(await ports.connect(environment)))
      throw new Error("Could not pair with this environment. Open Connections to reconnect it.");
  }
  await ports.enable();
}
