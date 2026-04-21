export interface ParsedCliArgs {
  readonly flags: Record<string, string | null>;
  readonly positionals: string[];
}

export interface ParseCliArgsOptions {
  readonly booleanFlags?: readonly string[];
}

/**
 * Parse CLI-style arguments into flags and positionals.
 *
 * Accepts a string (split by whitespace) or a pre-split argv array.
 * Supports `--key value`, `--key=value`, and `--flag` (boolean) syntax.
 *
 *   parseCliArgs("")
 *     → { flags: {}, positionals: [] }
 *
 *   parseCliArgs("--chrome")
 *     → { flags: { chrome: null }, positionals: [] }
 *
 *   parseCliArgs("--chrome --effort high")
 *     → { flags: { chrome: null, effort: "high" }, positionals: [] }
 *
 *   parseCliArgs("--effort=high")
 *     → { flags: { effort: "high" }, positionals: [] }
 *
 *   parseCliArgs(["1.2.3", "--root", "/path", "--github-output"], { booleanFlags: ["github-output"] })
 *     → { flags: { root: "/path", "github-output": null }, positionals: ["1.2.3"] }
 */
export function parseCliArgs(
  args: string | readonly string[],
  options?: ParseCliArgsOptions,
): ParsedCliArgs {
  const tokens =
    typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : Array.from(args);
  const booleanSet = options?.booleanFlags ? new Set(options.booleanFlags) : undefined;

  const flags: Record<string, string | null> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      if (!rest) continue;

      // Handle --key=value syntax
      const eqIndex = rest.indexOf("=");
      if (eqIndex !== -1) {
        flags[rest.slice(0, eqIndex)] = rest.slice(eqIndex + 1);
        continue;
      }

      // Known boolean flag — never consumes next token
      if (booleanSet?.has(rest)) {
        flags[rest] = null;
        continue;
      }

      // Handle --key value or --flag (boolean)
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[rest] = next;
        i++;
      } else {
        flags[rest] = null;
      }
    } else {
      positionals.push(token);
    }
  }

  return { flags, positionals };
}
