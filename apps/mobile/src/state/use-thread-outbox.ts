import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));

export function useThreadOutboxMessages() {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

export function useThreadOutboxShellStatuses() {
  return useAtomValue(threadOutboxShellStatusesAtom);
}
