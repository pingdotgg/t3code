import { delimiter, basename } from "node:path";
import { execFileSync } from "node:child_process";

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");

function getShellProbe(shellPath: string): ReadonlyArray<string> {
  const shellName = basename(shellPath).toLowerCase();
  if (shellName === "fish") {
    return ["-ilc", "string join : $PATH"];
  }
  return ["-ilc", 'printf "%s" "$PATH"'];
}

export function normalizeShellPathOutput(raw: string): string | undefined {
  const stripped = raw.replace(ANSI_ESCAPE_SEQUENCE, "").trim();
  if (stripped.length === 0) return undefined;

  const separator = stripped.includes(":") ? ":" : stripped.includes(";") ? ";" : undefined;
  if (!separator) return undefined;

  const segments = stripped
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return undefined;
  return segments.join(delimiter);
}

export function resolveLoginShellPath(shellPath: string, env: NodeJS.ProcessEnv = process.env) {
  const result = execFileSync(shellPath, [...getShellProbe(shellPath)], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...env,
      TERM: "dumb",
    },
  });

  return normalizeShellPathOutput(result);
}
