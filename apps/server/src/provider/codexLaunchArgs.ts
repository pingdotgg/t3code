import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

function configValue(
  argument: string | undefined,
  nextArgument: string | undefined,
): string | undefined {
  if (argument === "-c" || argument === "--config") return nextArgument;
  if (argument?.startsWith("-c=")) return argument.slice(3);
  if (argument?.startsWith("--config=")) return argument.slice("--config=".length);
  return undefined;
}

function configAssignment(value: string | undefined): readonly [string, string] | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("=");
  if (separator < 0) return undefined;
  const key = value.slice(0, separator).trim();
  const assignment = value.slice(separator + 1).trim();
  if (!key || !assignment) return undefined;
  return [key, assignment.replace(/^(['"])(.*)\1$/, "$2")];
}

/**
 * External model providers do not implement Codex's OpenAI account quota RPC.
 * A provider can opt out explicitly with `requires_openai_auth=false`.
 */
export const codexUsageProbeDisabled = (launchArgs?: string): boolean => {
  const args = codexAppServerArgs(launchArgs);
  const assignments = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const value = configValue(args[index], args[index + 1]);
    const assignment = configAssignment(value);
    if (assignment) assignments.set(assignment[0], assignment[1]);
  }
  const selectedProvider = assignments.get("model_provider") ?? "openai";
  return (
    assignments.get(`model_providers.${selectedProvider}.requires_openai_auth`)?.toLowerCase() ===
    "false"
  );
};

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
