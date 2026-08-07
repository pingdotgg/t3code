/**
 * Compact display label for a thread-owned process. Raw command lines are
 * dominated by absolute interpreter paths (`C:\Program Files\nodejs\node.exe
 * C:\repo\node_modules\pnpm\bin\pnpm.cjs build`); the interesting part is the
 * tail. Path tokens shrink to their basename and shell-wrapper prefixes
 * (`cmd /d /s /c …`) are stripped, so the row reads `node pnpm.cjs build`.
 */

/**
 * Split on whitespace outside double quotes; quote characters themselves are
 * dropped. Handles cmd's nested `""inner" tail"` quoting well enough for
 * display purposes.
 */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of commandLine) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Basename for path-like tokens; leaves flags such as `/d` or `-c` alone. */
function lastPathSegment(token: string): string {
  const separator = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  if (separator <= 0) return token;
  return token.slice(separator + 1) || token;
}

function stripExecutableSuffix(token: string): string {
  return token.replace(/\.exe$/i, "");
}

const CMD_WRAPPER_FLAGS = new Set(["/d", "/s", "/c", "/k", "-c"]);

export function formatProcessCommand(input: {
  readonly commandLine: string | null | undefined;
  readonly processName: string | null;
}): string {
  const commandLine = input.commandLine?.trim();
  if (!commandLine) return input.processName ?? "Process";

  let tokens = tokenize(commandLine).map(lastPathSegment);
  const head = stripExecutableSuffix(tokens[0] ?? "").toLowerCase();
  if ((head === "cmd" || head === "sh" || head === "bash" || head === "zsh") && tokens.length > 1) {
    const rest = tokens.slice(1).filter((token) => !CMD_WRAPPER_FLAGS.has(token.toLowerCase()));
    if (rest.length > 0) tokens = rest;
  }
  if (tokens.length > 0) {
    tokens[0] = stripExecutableSuffix(tokens[0] ?? "");
  }
  const label = tokens.join(" ").trim();
  return label || (input.processName ?? "Process");
}
