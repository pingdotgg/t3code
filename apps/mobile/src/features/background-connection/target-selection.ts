import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

function refKey(ref: ScopedThreadRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

/**
 * Keep one user-relevant settled thread plus every thread that is currently doing work.
 * The retained thread is deliberately first and the shell order is preserved.
 */
export function selectBackgroundConnectionThreadTargets(
  retainedThread: ScopedThreadRef | null,
  threadShells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<ScopedThreadRef> {
  const targets: ScopedThreadRef[] = [];
  const seen = new Set<string>();
  const append = (ref: ScopedThreadRef) => {
    const key = refKey(ref);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(ref);
  };

  if (retainedThread !== null) {
    append(retainedThread);
  }
  for (const thread of threadShells) {
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      append({ environmentId: thread.environmentId, threadId: thread.id });
    }
  }
  return targets;
}
