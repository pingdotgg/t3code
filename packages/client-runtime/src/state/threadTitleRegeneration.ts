import type {
  CommandId,
  OrchestrationV2ShellSnapshot,
  ThreadId,
  ThreadTitleRegenerationOutcome,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

export interface TitleRegenerationRequest {
  readonly threadId: ThreadId;
  readonly requestId: CommandId;
  readonly sequence: number;
}

export interface TitleRegenerationSources {
  readonly snapshot: Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly disconnected: Atom.Atom<boolean>;
}

function settledOutcome(
  snapshot: OrchestrationV2ShellSnapshot | null,
  request: TitleRegenerationRequest,
): ThreadTitleRegenerationOutcome | null | undefined {
  if (snapshot === null) return undefined;
  if (snapshot.snapshotSequence < request.sequence) return undefined;
  const thread =
    snapshot.threads.find((candidate) => candidate.id === request.threadId) ??
    snapshot.archivedThreads.find((candidate) => candidate.id === request.threadId);
  if (thread === undefined) return null;
  const last = thread.lastTitleRegeneration;
  if (last?.requestId === request.requestId) {
    return last.message === undefined
      ? { status: last.status }
      : { status: last.status, message: last.message };
  }
  return thread.titleRegeneration?.requestId === request.requestId ? undefined : null;
}

export function waitForTitleRegenerationOutcome(
  registry: AtomRegistry.AtomRegistry,
  sources: TitleRegenerationSources,
  request: TitleRegenerationRequest,
): Promise<ThreadTitleRegenerationOutcome | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribes: ReadonlyArray<() => void> = [];
    const release = () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    const check = () => {
      if (settled) return;
      let outcome = settledOutcome(registry.get(sources.snapshot), request);
      if (outcome === undefined && registry.get(sources.disconnected)) outcome = null;
      if (outcome === undefined) return;
      settled = true;
      release();
      resolve(outcome);
    };
    unsubscribes = [
      registry.subscribe(sources.snapshot, check),
      registry.subscribe(sources.disconnected, check),
    ];
    if (settled) release();
    else check();
  });
}
