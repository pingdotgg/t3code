/**
 * Converts gitignore-style rules into glob patterns for tools like fast-glob's {@link https://github.com/mrmlnc/fast-glob#ignore `ignore`} option.
 *
 * Gitignore and glob differ (ordering, negation, escapes). This maps the common cases:
 *
 * - Rules with no `/` match at any depth → \`**\/name\`, \`**\/name\/\*\/`
 * - A leading `/` anchors to the ignore file's directory (use the same `cwd` in fast-glob) → `name`, `name/**`
 * - A `/` in the pattern (not only leading) uses path-aware matching → `a/b`, `a/b/**`
 * - A trailing `/` restricts to directories → adds `/**` as needed
 * - Lines starting with `!` (negation) are returned with a `!` prefix for use in **positive** glob
 *   lists; they are not valid in fast-glob's `ignore` array (filter them out if you only pass `ignore`)
 *
 * Does not implement full gitignore escaping (e.g. `\\ ` for trailing space) or `**` edge cases
 * identical to git; escape handling can be added later if needed.
 */
export function gitignoreRulesToGlobs(rules: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const raw of rules) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    let negated = false;
    let rest = line;
    if (rest.startsWith("!")) {
      negated = true;
      rest = rest.slice(1).trim();
      if (rest.length === 0 || rest.startsWith("#")) {
        continue;
      }
    }
    let dirOnly = rest.endsWith("/");
    if (dirOnly) {
      rest = rest.slice(0, -1);
    }
    rest = rest.replace(/\\/g, "/");
    if (rest.length === 0) {
      continue;
    }
    const anchored = rest.startsWith("/");
    if (anchored) {
      rest = rest.slice(1);
    }
    if (rest.length === 0) {
      continue;
    }
    const hasSlash = rest.includes("/");
    const globs = ruleBodyToGlobs(rest, { anchored, hasSlash, dirOnly });
    for (const g of globs) {
      out.push(negated ? `!${g}` : g);
    }
  }
  return out;
}

function ruleBodyToGlobs(
  body: string,
  opts: { anchored: boolean; hasSlash: boolean; dirOnly: boolean },
): string[] {
  const { anchored, hasSlash, dirOnly } = opts;
  if (dirOnly) {
    if (anchored) {
      return [`${body}/**`];
    }
    if (hasSlash) {
      return [`${body}/**`];
    }
    return [`**/${body}/**`];
  }
  if (anchored) {
    if (hasSlash) {
      return [body, `${body}/**`];
    }
    return [body, `${body}/**`];
  }
  if (hasSlash) {
    return [body, `${body}/**`];
  }
  return [`**/${body}`, `**/${body}/**`];
}
