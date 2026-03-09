import { runProcess } from "./processRunner";
import { createTerminalSpawnEnv } from "./terminal/spawnEnv";

const PROJECT_LIFECYCLE_SCRIPT_TIMEOUT_MS = 300_000;
const PROJECT_LIFECYCLE_SCRIPT_MAX_OUTPUT_BYTES = 1_000_000;

interface ProjectLifecycleScriptInput {
  cwd: string;
  command: string;
  env?: Record<string, string> | undefined;
}

interface ProjectLifecycleScriptDependencies {
  runProcess?: typeof runProcess;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, "");
}

function resolveShellCommand(): string {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec?.trim();
    return shell && shell.length > 0 ? shell : "cmd.exe";
  }

  const shell = process.env.SHELL?.trim();
  if (!shell) {
    return "/bin/sh";
  }
  const [firstToken] = shell.split(/\s+/g);
  return firstToken ? stripWrappingQuotes(firstToken) : "/bin/sh";
}

function shellArgsForCommand(command: string): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
}

function buildLifecycleScriptError(message: string): Error {
  return new Error(`Project lifecycle script failed: ${message}`);
}

export async function runProjectLifecycleScript(
  input: ProjectLifecycleScriptInput,
  dependencies: ProjectLifecycleScriptDependencies = {},
): Promise<void> {
  const run = dependencies.runProcess ?? runProcess;
  const shellCommand = resolveShellCommand();

  let result;
  try {
    result = await run(shellCommand, shellArgsForCommand(input.command), {
      cwd: input.cwd,
      env: createTerminalSpawnEnv(process.env, input.env),
      timeoutMs: PROJECT_LIFECYCLE_SCRIPT_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: PROJECT_LIFECYCLE_SCRIPT_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
    });
  } catch (error) {
    throw buildLifecycleScriptError(
      error instanceof Error ? error.message : "Unable to start the script.",
    );
  }

  if (result.timedOut) {
    throw buildLifecycleScriptError(
      `timed out after ${Math.round(PROJECT_LIFECYCLE_SCRIPT_TIMEOUT_MS / 1000)} seconds.`,
    );
  }
  if (result.code === 0) {
    return;
  }

  const detail = result.stderr.trim() || result.stdout.trim();
  const exitSummary = `exited with code ${result.code ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}.`;
  throw buildLifecycleScriptError(detail.length > 0 ? `${exitSummary} ${detail}` : exitSummary);
}
