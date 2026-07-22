import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const PI_MINIMUM_VERSION = "0.81.1";

const MANAGED_FLAGS = new Set(["mode", "session", "session-dir"]);

export type PiLaunchPlan =
  | {
      readonly _tag: "Success";
      readonly args: ReadonlyArray<string>;
      readonly environment: NodeJS.ProcessEnv;
    }
  | { readonly _tag: "Failure"; readonly message: string };

export function validatePiLaunchArgs(launchArgs: string): string | undefined {
  const managedFlag = tokenizeCliArgs(launchArgs).find((arg) => {
    if (!arg.startsWith("--")) return false;
    return MANAGED_FLAGS.has(arg.slice(2).split("=", 1)[0]!);
  });
  return managedFlag
    ? `${managedFlag} is managed by T3 Code and cannot be set in Pi launch arguments.`
    : undefined;
}

export function buildPiLaunchPlan(input: {
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
}): PiLaunchPlan {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const validationError = validatePiLaunchArgs(input.launchArgs);
  if (validationError) {
    return {
      _tag: "Failure",
      message: validationError,
    };
  }

  return {
    _tag: "Success",
    args: [
      ...userArgs,
      "--mode",
      "rpc",
      "--session-dir",
      input.sessionDirectory,
      "--session",
      input.sessionId,
    ],
    environment: input.configDirectory ? { PI_AGENT_DIR: input.configDirectory } : {},
  };
}

export type PiVersionStatus =
  | { readonly _tag: "Supported"; readonly version: string }
  | { readonly _tag: "Unsupported"; readonly version: string }
  | { readonly _tag: "Invalid" };

export function parsePiVersion(output: string): PiVersionStatus {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return { _tag: "Invalid" };

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const parsed = match.slice(1).map(Number);
  const minimum = PI_MINIMUM_VERSION.split(".").map(Number);
  for (const [index, part] of parsed.entries()) {
    const minimumPart = minimum[index]!;
    if (part > minimumPart) return { _tag: "Supported", version };
    if (part < minimumPart) return { _tag: "Unsupported", version };
  }
  return { _tag: "Supported", version };
}
