import type {
  AgentctlActionResult,
  AgentctlSandboxNameInput,
  EnvironmentId,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { threadRuntimeIsActive, type ThreadStructureRuntime } from "../state/models.ts";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
  type AtomCommandResult,
} from "../state/runtime.ts";
import type { HostedSandbox } from "../state/sandboxes.ts";
import {
  deleteSandboxConfirmation,
  sandboxTitle,
  stopSandboxConfirmation,
  type SandboxConfirmation,
} from "./presentation.ts";

type HostCommand<Input, A, E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: Input },
  A,
  E
>;

/** A command's value, or why it failed, such as a host that is not connected. */
function commandOutcome<A, E>(
  result: AtomCommandResult<A, E>,
): { readonly value: A } | { readonly error: string } {
  if (result._tag === "Success") return { value: result.value };
  const failure = squashAtomCommandFailure(result);
  return { error: failure instanceof Error ? failure.message : String(failure) };
}

/** Runs one of the host's Sandbox commands, as every Sandbox view does. */
export async function runSandboxHostCommand<Input, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: HostCommand<Input, A, E>,
  hostEnvironmentId: EnvironmentId,
  input: Input,
) {
  return commandOutcome(
    await runAtomCommand(
      registry,
      command,
      { environmentId: hostEnvironmentId, input },
      { reportFailure: false },
    ),
  );
}

type LifecycleCommand = HostCommand<AgentctlSandboxNameInput, AgentctlActionResult, unknown>;

/**
 * Start, Stop and Delete as every client runs them: Stop and Delete confirm first, naming the
 * threads still working in the Sandbox, and a failure is reported with agentctl's own message.
 */
export function createSandboxActions(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly commands: {
    readonly start: LifecycleCommand;
    readonly stop: LifecycleCommand;
    readonly remove: LifecycleCommand;
  };
  readonly severalHostsAtom: Atom.Atom<boolean>;
  readonly threadShellsAtom: Atom.Atom<
    ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly runtime: ThreadStructureRuntime | null;
    }>
  >;
  readonly presentationsAtom: Atom.Atom<
    ReadonlyMap<EnvironmentId, { readonly entry: { readonly target: { readonly label: string } } }>
  >;
  readonly confirm: (confirmation: SandboxConfirmation) => Promise<boolean>;
  readonly reportError: (title: string, description: string) => void;
}) {
  const { registry } = input;

  async function runAction(title: string, command: LifecycleCommand, sandbox: HostedSandbox) {
    const outcome = await runSandboxHostCommand(registry, command, sandbox.hostEnvironmentId, {
      name: sandbox.name,
    });
    const error = "error" in outcome ? outcome.error : outcome.value.error;
    if (error === null) return true;
    input.reportError(title, error);
    return false;
  }

  // One request of each kind per Sandbox at a time, so a double tap does not
  // run it twice; a pending start does not block a stop or delete.
  const inFlight = new Set<string>();

  async function once(sandbox: HostedSandbox, kind: string, run: () => Promise<boolean>) {
    const key = `${kind}:${sandbox.hostEnvironmentId}:${sandbox.name}`;
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    // `.finally` rather than try/finally, which the React Compiler cannot compile.
    return run().finally(() => {
      inFlight.delete(key);
    });
  }

  /** Threads working in the Sandbox now, read at confirm time from any entry point. */
  function workingThreads(sandbox: HostedSandbox): number {
    if (sandbox.environmentId === null) return 0;
    return registry
      .get(input.threadShellsAtom)
      .filter(
        (thread) =>
          thread.environmentId === sandbox.environmentId && threadRuntimeIsActive(thread.runtime),
      ).length;
  }

  function title(sandbox: HostedSandbox): string {
    if (!registry.get(input.severalHostsAtom)) return sandbox.name;
    const host = registry.get(input.presentationsAtom).get(sandbox.hostEnvironmentId)?.entry
      .target.label;
    return sandboxTitle(sandbox.name, host ?? null);
  }

  return {
    start: (sandbox: HostedSandbox): Promise<boolean> =>
      once(sandbox, "start", () =>
        runAction(`Could not start ${title(sandbox)}`, input.commands.start, sandbox),
      ),
    stop: (sandbox: HostedSandbox): Promise<boolean> =>
      once(sandbox, "stop", async () => {
        const confirmed = await input.confirm(
          stopSandboxConfirmation(title(sandbox), workingThreads(sandbox)),
        );
        if (!confirmed) return false;
        return runAction(`Could not stop ${title(sandbox)}`, input.commands.stop, sandbox);
      }),
    remove: (sandbox: HostedSandbox): Promise<boolean> =>
      once(sandbox, "delete", async () => {
        const confirmed = await input.confirm(
          deleteSandboxConfirmation(title(sandbox), workingThreads(sandbox)),
        );
        if (!confirmed) return false;
        return runAction(`Could not delete ${title(sandbox)}`, input.commands.remove, sandbox);
      }),
  };
}
