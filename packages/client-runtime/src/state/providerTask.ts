/**
 * Per-task stop command (fork f3).
 *
 * One unary RPC, no local mirror of "which tasks are stopping": the durable
 * answer is the thread's own `task.completed status=stopped` activity, which
 * already streams to every client. A surface that wants to disable a button
 * while the stop is in flight keeps that entirely in view state.
 *
 * @module client-runtime/state/providerTask
 */
import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createProviderTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Stop one agent task. Idempotent server-side, so a caller may fire it
     * again without checking whether the previous attempt landed.
     */
    stopTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:stop-task",
      tag: WS_METHODS.providerStopTask,
    }),
  };
}
