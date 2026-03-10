import type { Sandbox } from "@daytonaio/sdk";

import type { GitCloneAuth } from "./git.service";

export type SandboxCommandResult = Awaited<ReturnType<Sandbox["process"]["executeCommand"]>>;

export function runSandboxCommand(
  sandbox: Sandbox,
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): Promise<SandboxCommandResult> {
  return sandbox.process.executeCommand(command, cwd, env);
}

export function collectSecretValues(
  value?: GitCloneAuth | ReadonlyArray<string | undefined>,
): string[] {
  if (!value) {
    return [];
  }

  if ("username" in value && "password" in value) {
    return [value.username, value.password].filter((entry) => entry.length > 0);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => entry?.trim() ?? "").filter((entry) => entry.length > 0);
  }

  return [];
}

export function redactUrlCredentials(value: string): string {
  return value.replace(/(https?:\/\/)([^/\s@]+)@/giu, "$1[REDACTED]@");
}

export function sanitizeText(value: string, secretValues: ReadonlyArray<string>): string {
  let sanitized = redactUrlCredentials(value);

  for (const secretValue of secretValues) {
    sanitized = sanitized.split(secretValue).join("[REDACTED]");
  }

  return sanitized;
}

export function sanitizeCause(cause: unknown, secretValues: ReadonlyArray<string>): unknown {
  if (cause instanceof Error) {
    return new Error(sanitizeText(cause.message, secretValues));
  }

  if (typeof cause === "string") {
    return sanitizeText(cause, secretValues);
  }

  return cause;
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createGitAskPassCommand(askPassPath: string): string {
  return [
    `cat > ${quoteShellArg(askPassPath)} <<'EOF'`,
    "#!/bin/sh",
    'case "$1" in',
    "  *Username*) printf '%s\\n' \"$JEVIN_GIT_USERNAME\" ;;",
    "  *) printf '%s\\n' \"$JEVIN_GIT_PASSWORD\" ;;",
    "esac",
    "EOF",
    `chmod 700 ${quoteShellArg(askPassPath)}`,
  ].join("\n");
}

export function createGitAuthEnv(auth: GitCloneAuth, askPassPath: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askPassPath,
    JEVIN_GIT_USERNAME: auth.username,
    JEVIN_GIT_PASSWORD: auth.password,
  };
}
