import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { threadHandoffEnvironment } from "../state/threadHandoff";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** How long a menu waits for the move targets before opening without them. */
const TARGETS_TIMEOUT_MS = 1_500;

/** Whether this environment can move threads, so its menus should ask where to. */
export function readThreadHandoffSupported(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .peerLinks === true
  );
}

/**
 * Where a thread can move, read as its menu opens. Empty when the environment
 * cannot move threads, or does not answer in time; the menu then shows no
 * "Continue on…".
 */
export async function readThreadHandoffTargets(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<
  ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly reason: string | null;
  }>
> {
  if (!readThreadHandoffSupported(environmentId)) return [];
  const result = await Effect.runPromise(
    AtomRegistry.getResult(
      appAtomRegistry,
      threadHandoffEnvironment.options({ environmentId, input: { threadId } }),
      { suspendOnWaiting: true },
    ).pipe(
      Effect.timeoutOption(TARGETS_TIMEOUT_MS),
      Effect.map((found) => (found._tag === "Some" ? found.value.options : [])),
      Effect.orElseSucceed(() => []),
    ),
  );
  return result.map((option) => ({
    environmentId: option.environmentId,
    label: option.label,
    reason: option.reason,
  }));
}

/** Starts the move a "Continue on…" choice asked for; the thread's banner shows how it goes. */
export async function startThreadHandoff(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  targetEnvironmentId: string,
): Promise<void> {
  const result = await runAtomCommand(appAtomRegistry, threadHandoffEnvironment.start, {
    environmentId,
    input: { threadId, environmentId: targetEnvironmentId as EnvironmentId },
  });
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not move the thread",
        description: String(squashAtomCommandFailure(result)),
      }),
    );
  }
}
