import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { runAtomCommand } from "./atom-interop";
import { useContext } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | Omit<AtomCommandOptions, "signal">,
): (value: W, call?: Pick<AtomCommandOptions, "signal">) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  return (value, call) =>
    runAtomCommand(registry, command, value, { label, reportFailure, reportDefect, ...call });
}
