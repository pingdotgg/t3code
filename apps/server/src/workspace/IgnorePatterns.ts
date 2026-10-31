/**
 * Gitignore-syntax matching for `.ignore` files, which git cannot evaluate for us.
 *
 * Patterns come from the repository, so matching must stay linear: each pattern runs as an NFA
 * over the path (O(pattern × path)) rather than a backtracking regex, which a pattern such as
 * `a*a*a*…b` can stall for seconds. Supported: `#` comments, `!` negation, `\` escapes, trailing
 * `/` for folders, anchoring by an inner or leading `/`, `*`, `?`, `[…]` classes with `!`/`^` and
 * ranges, and `**` as a leading, inner, or trailing segment. POSIX `[:class:]` names are not.
 */

type Token =
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "one" }
  | { readonly type: "class"; readonly negated: boolean; readonly ranges: ReadonlyArray<string> }
  | { readonly type: "star" }
  | { readonly type: "any" }
  /** A leading or inner `**` segment: nothing, or anything ending in `/`. */
  | { readonly type: "folders" };

interface Pattern {
  readonly tokens: ReadonlyArray<Token>;
  readonly negated: boolean;
  readonly folderOnly: boolean;
}

export type IgnoreDecision = "ignored" | "included";

function parseClass(chars: ReadonlyArray<string>, start: number) {
  let index = start + 1;
  const negated = chars[index] === "!" || chars[index] === "^";
  if (negated) index += 1;
  const ranges: string[] = [];
  for (let first = true; index < chars.length; first = false) {
    let char = chars[index]!;
    if (char === "]" && !first)
      return { token: { type: "class", negated, ranges } as const, end: index };
    if (char === "\\" && index + 1 < chars.length) char = chars[++index]!;
    if (chars[index + 1] === "-" && index + 2 < chars.length && chars[index + 2] !== "]") {
      let last = chars[index + 2]!;
      index += 2;
      if (last === "\\" && index + 1 < chars.length) last = chars[++index]!;
      ranges.push(char, last);
    } else {
      ranges.push(char, char);
    }
    index += 1;
  }
  return undefined;
}

function parseLine(rawLine: string): Pattern | undefined {
  let line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  // Trailing spaces are dropped unless escaped.
  while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
  if (line === "" || line.startsWith("#")) return undefined;
  const negated = line.startsWith("!");
  if (negated) line = line.slice(1);
  else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
  const folderOnly = line.endsWith("/") && !line.endsWith("\\/");
  if (folderOnly) line = line.slice(0, -1);
  if (line === "") return undefined;
  const anchored = line.slice(0, -1).includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  const chars = Array.from(line);
  const tokens: Token[] = anchored ? [] : [{ type: "folders" }];
  // A `[` that never closes leaves every later `[` unclosed too, so one failed scan settles them
  // all; rescanning the suffix for each would make `[[[[…` quadratic.
  let classesClose = true;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "*" && chars[index + 1] === "*") {
      const atSegmentStart = index === 0 || chars[index - 1] === "/";
      const next = chars[index + 2];
      if (atSegmentStart && next === "/") {
        tokens.push({ type: "folders" });
        index += 2;
        continue;
      }
      if (atSegmentStart && next === undefined) {
        tokens.push({ type: "any" });
        index += 1;
        continue;
      }
    }
    if (char === "*") tokens.push({ type: "star" });
    else if (char === "?") tokens.push({ type: "one" });
    else if (char === "[") {
      const parsed = classesClose ? parseClass(chars, index) : undefined;
      if (!parsed) classesClose = false;
      if (parsed) {
        tokens.push(parsed.token);
        index = parsed.end;
      } else tokens.push({ type: "char", char });
    } else if (char === "\\" && index + 1 < chars.length) {
      tokens.push({ type: "char", char: chars[++index]! });
    } else tokens.push({ type: "char", char });
  }
  return { tokens, negated, folderOnly };
}

/**
 * States are token positions. A `folders` token that has consumed part of a segment is `~position`
 * instead: it may only finish after the next `/`, so an inner globstar never matches `xbar` as `bar`.
 */
function matches(tokens: ReadonlyArray<Token>, path: ReadonlyArray<string>): boolean {
  let states = new Set<number>();
  const add = (set: Set<number>, position: number) => {
    // Wildcards also match nothing, so reaching one reaches the token after it.
    for (; position <= tokens.length && !set.has(position); position += 1) {
      set.add(position);
      const type = tokens[position]?.type;
      if (type !== "star" && type !== "any" && type !== "folders") return;
    }
  };
  add(states, 0);
  for (const char of path) {
    const next = new Set<number>();
    for (const state of states) {
      const position = state < 0 ? ~state : state;
      const token = tokens[position];
      if (!token) continue;
      switch (token.type) {
        case "char":
          if (token.char === char) add(next, position + 1);
          break;
        case "one":
          if (char !== "/") add(next, position + 1);
          break;
        case "class": {
          let inRange = false;
          for (let index = 0; index < token.ranges.length && !inRange; index += 2) {
            inRange = token.ranges[index]! <= char && char <= token.ranges[index + 1]!;
          }
          if (char !== "/" && inRange !== token.negated) add(next, position + 1);
          break;
        }
        case "star":
          if (char !== "/") add(next, position);
          break;
        case "any":
          add(next, position);
          break;
        case "folders":
          if (char === "/") add(next, position);
          else next.add(~position);
          break;
      }
    }
    if (next.size === 0) return false;
    states = next;
  }
  return states.has(tokens.length);
}

export interface IgnoreFile {
  /** The last pattern that matches decides; `undefined` when none does. */
  readonly decide: (relativePath: string, isFolder: boolean) => IgnoreDecision | undefined;
}

export function parseIgnoreFile(contents: string): IgnoreFile {
  const patterns = contents.split("\n").flatMap((line) => parseLine(line) ?? []);
  return {
    decide: (relativePath, isFolder) => {
      const path = Array.from(relativePath);
      for (let index = patterns.length - 1; index >= 0; index -= 1) {
        const pattern = patterns[index]!;
        if (pattern.folderOnly && !isFolder) continue;
        if (matches(pattern.tokens, path)) return pattern.negated ? "included" : "ignored";
      }
      return undefined;
    },
  };
}
