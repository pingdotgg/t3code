import type { EnvironmentId, ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  compareWorktreeSetupSnapshots,
  resolveVisibleWorktreeSetup,
} from "@t3tools/client-runtime/worktree-setup";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  preparing: boolean;
  /** Reads a worktree thread's snapshot until one is held; after that only `preparing` reopens it. */
  hasWorktree: boolean;
  turnStarted: boolean;
  followUpSent: boolean;
}) {
  const key = JSON.stringify([input.environmentId, input.threadId]);
  const [held, setHeld] = useState<{ key: string; snapshot: WorktreeSetupSnapshot } | null>(null);
  const live = held?.key === key ? held.snapshot : null;
  const [wasPreparing, setWasPreparing] = useState(input.preparing);
  const [retried, setRetried] = useState<{ key: string; after: WorktreeSetupSnapshot } | null>(
    null,
  );
  if (retried && retried.key !== key) setRetried(null);
  if (input.preparing !== wasPreparing) {
    setWasPreparing(input.preparing);
    // A retry can fail before the reopened read delivers, so read until a newer attempt arrives.
    if (input.preparing && live && live.phase !== "running") setRetried({ key, after: live });
  }
  const awaitingRetry = retried?.key === key;
  const query = useEnvironmentQuery(
    input.environmentId &&
      input.threadId &&
      (input.preparing ||
        awaitingRetry ||
        live?.phase === "running" ||
        (!live && input.hasWorktree))
      ? vcsEnvironment.worktreeSetup({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const snapshot = resolveWorktreeSetupSnapshot(input.threadId, query.data, live);
  // Hold the newest snapshot so it survives the subscription closing once setup stops running.
  // Set during render so each emission commits once; the resolver returns `live` by identity
  // on the next pass, which ends the update.
  if (snapshot && snapshot !== live) setHeld({ key, snapshot });
  if (awaitingRetry && snapshot && compareWorktreeSetupSnapshots(snapshot, retried.after) > 0) {
    setRetried(null);
  }
  return {
    snapshot,
    visible: resolveVisibleWorktreeSetup({
      live: snapshot,
      recorded: null,
      turnStarted: input.turnStarted,
      followUpSent: input.followUpSent,
    }),
  };
}
