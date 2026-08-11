/**
 * Parse rule-editor globs. Newlines are list separators; commas are list
 * separators only outside brace alternation, preserving TypeScript/TSX-style
 * patterns while accepting the legacy comma-separated format.
 */
export function parseAgentRuleGlobs(value: string): ReadonlyArray<string> {
  const globs: string[] = [];
  let current = "";
  let braceDepth = 0;

  const flush = () => {
    const glob = current.trim();
    if (glob.length > 0) globs.push(glob);
    current = "";
  };

  for (const character of value) {
    if (character === "\n" || character === "\r") {
      flush();
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    }
    if (character === "," && braceDepth === 0) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return globs;
}

export function formatAgentRuleGlobs(globs: ReadonlyArray<string>): string {
  return globs.join("\n");
}
