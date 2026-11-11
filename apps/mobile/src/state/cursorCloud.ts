import {
  CURSOR_CLOUD_MACHINE_LABELS,
  createCursorCloudAtoms,
} from "@t3tools/client-runtime/state/cursorCloud";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const cursorCloud = createCursorCloudAtoms(connectionAtomRuntime);

/** The cloud thread's VM state for headers, or null for host threads. */
export function useCursorCloudMachineLabel(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): string | null {
  const machine = useEnvironmentQuery(
    thread === null
      ? null
      : cursorCloud.machine({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
  );
  if (thread === null) return null;
  const state = machine.data?.state;
  return `Cloud · ${state === undefined ? "Checking" : CURSOR_CLOUD_MACHINE_LABELS[state]}`;
}
