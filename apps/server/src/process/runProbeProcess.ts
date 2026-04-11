import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../processRunner";

type ProcessRunner = typeof runProcess;

export type ProbeProcessOptions = Omit<ProcessRunOptions, "stdin" | "outputMode">;

export function runProbeProcess(
  command: string,
  args: readonly string[],
  options: ProbeProcessOptions = {},
  runner: ProcessRunner = runProcess,
): Promise<ProcessRunResult> {
  return runner(command, args, {
    ...options,
    outputMode: "truncate",
  });
}
