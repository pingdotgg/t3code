import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderSession } from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type ThreadStartMarkers = Pick<
  EnvironmentThreadShell,
  "latestRun" | "latestUserMessageAt" | "runtime"
>;

function threadShellHasStarted(thread: ThreadStartMarkers | null | undefined): boolean {
  return Boolean(
    thread &&
    (thread.latestRun !== null || thread.latestUserMessageAt !== null || thread.runtime !== null),
  );
}

/**
 * Whether this thread's model picker may offer providers other than the one it
 * runs on, matching web's locked-provider rule: a thread that never ran a turn
 * is bound to nothing, and a started thread stays on its provider only when its
 * session cannot hand the conversation to another one.
 */
export function threadAllowsProviderSwitch(input: {
  readonly thread: ThreadStartMarkers | null | undefined;
  readonly projection: OrchestrationV2ThreadProjection | null | undefined;
}): boolean {
  const session = input.projection ? resolveThreadProviderSession(input.projection) : null;
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  return !threadShellHasStarted(input.thread);
}
