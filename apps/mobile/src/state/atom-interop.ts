import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import {
  awaitAtomResult,
  reportAtomCommandResult,
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandReporter,
  type AtomCommandResult,
  type AtomQueryOptions,
} from "@t3tools/client-runtime/state/runtime";

export async function settleAsyncResult<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
): Promise<AtomCommandResult<A, E>> {
  try {
    return AsyncResult.fromExit(await execute());
  } catch (defect) {
    return AsyncResult.failure(Cause.die(defect));
  }
}

export async function runAtomCommand<W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
  input: W,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const result = await settleAsyncResult(() =>
    Effect.runPromiseExit(command.run(registry, input), { signal: options.signal }),
  );
  reportAtomCommandResult(result, { ...options, label: options.label ?? command.label }, reporter);
  return result;
}

export async function executeAtomQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: AtomQueryOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const result = await settleAsyncResult(() =>
    Effect.runPromiseExit(awaitAtomResult(registry, atom, options), { signal: options.signal }),
  );
  reportAtomCommandResult(result, options, reporter);
  return result;
}
