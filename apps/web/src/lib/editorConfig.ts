import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { braceExpand, Minimatch } from "minimatch";

export const DEFAULT_TAB_WIDTH = 2;

interface EditorConfigSection {
  readonly matcher: { match(relativePath: string): boolean };
  readonly properties: Record<string, string>;
}

type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "star"; crossesSlash: boolean }
  | { kind: "directory" }
  | { kind: "character"; characters: ReadonlySet<string>; negated: boolean }
  | { kind: "range"; min: string; max: string; padding: number };

function normalizeInteger(value: string) {
  const digits = value.replace(/^-/, "").replace(/^0+/, "") || "0";
  return value.startsWith("-") && digits !== "0" ? `-${digits}` : digits;
}

function compareIntegers(left: string, right: string) {
  const leftNegative = left.startsWith("-");
  const rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const magnitude = left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
  return leftNegative ? -magnitude : magnitude;
}

/** Each token advances a set of path positions, so ambiguous ranges never backtrack. */
function matchTokens(tokens: ReadonlyArray<GlobToken>, path: string, directoryRelative: boolean) {
  let positions = new Set([0]);
  if (!directoryRelative) {
    for (let index = 0; index < path.length; index++) {
      if (path[index] === "/") positions.add(index + 1);
    }
  }
  for (const token of tokens) {
    const next = new Set<number>();
    for (const start of positions) {
      switch (token.kind) {
        case "literal":
          if (path.startsWith(token.value, start)) next.add(start + token.value.length);
          break;
        case "character":
          if (start < path.length && token.characters.has(path.charAt(start)) !== token.negated) {
            next.add(start + 1);
          }
          break;
        case "star":
        case "directory":
          next.add(start);
          for (let end = start; end < path.length; end++) {
            if (token.kind === "star") {
              if (!token.crossesSlash && path[end] === "/") break;
              next.add(end + 1);
            } else if (path[end] === "/") next.add(end + 1);
          }
          break;
        case "range": {
          const digitStart = path[start] === "-" ? start + 1 : start;
          const limit = Math.min(
            path.length,
            start + Math.max(token.min.length, token.max.length, token.padding),
          );
          for (let end = digitStart; end < limit && /[0-9]/.test(path.charAt(end)); end++) {
            const candidate = path.slice(start, end + 1);
            const value = normalizeInteger(candidate);
            // Padding counts the sign too; reject noncanonical spellings without
            // constructing a padded string as large as the section's bounds.
            if (
              candidate.length !== Math.max(value.length, token.padding) ||
              candidate.startsWith("-") !== value.startsWith("-")
            )
              continue;
            if (compareIntegers(token.min, value) <= 0 && compareIntegers(value, token.max) <= 0) {
              next.add(end + 1);
            }
          }
          break;
        }
      }
    }
    positions = next;
    if (positions.size === 0) return false;
  }
  return positions.has(path.length);
}

function sectionMatcher(pattern: string) {
  // Keep numeric bounds as strings: compilation must not enumerate their values or
  // grow a regex with their digit count. Classes also protect literal braces/slashes.
  let tokenPrefix = "EDITORCONFIGTOKEN";
  while (pattern.includes(tokenPrefix)) tokenPrefix += "X";
  const sources = new Map<string, GlobToken>();
  const protect = (source: GlobToken) => {
    const token = `${tokenPrefix}${sources.size}END`;
    sources.set(token, source);
    return token;
  };
  let directoryRelative = false;
  let needsTokenMatcher = false;
  const glob = pattern.replace(
    /\\.|\[(?:\\.|[^\]\\])+\]|\{(-?\d+)\.\.(-?\d+)\}|\*\*|\//g,
    (token: string, lower: string | undefined, upper: string | undefined) => {
      if (token.startsWith("[")) {
        needsTokenMatcher = true;
        const negated = token.startsWith("[!");
        // EditorConfig classes are literal sets, not regex ranges; only ! negates.
        const characters = token.slice(negated ? 2 : 1, -1).replace(/\\(.)/g, "$1");
        return protect({ kind: "character", characters: new Set(characters.split("")), negated });
      }
      if (lower !== undefined && upper !== undefined) {
        const min = normalizeInteger(lower);
        const max = normalizeInteger(upper);
        const padding =
          /^-?0\d/.test(lower) || /^-?0\d/.test(upper) ? Math.max(lower.length, upper.length) : 0;
        if (compareIntegers(min, max) >= 0) return token;
        needsTokenMatcher = true;
        return protect({ kind: "range", min, max, padding });
      }
      if (token.includes("/")) directoryRelative = true;
      return token;
    },
  );
  const options = {
    dot: true,
    matchBase: !directoryRelative,
    nonegate: true,
    nocomment: true,
    noext: true,
    platform: "linux" as const,
    braceExpandMax: 1024,
  };
  if (!needsTokenMatcher) {
    return new Minimatch(pattern.replace(/^\//, "").replace(/\*\*/g, "{*,**/**/**}"), options);
  }
  const alternatives = braceExpand(glob.replace(/^\//, ""), options).map((expanded) => {
    const tokens: GlobToken[] = [];
    const expression = new RegExp(`${tokenPrefix}\\d+END|\\\\.|\\*\\*/?|\\*|\\?|.`, "g");
    for (const match of expanded.matchAll(expression)) {
      const value = match[0];
      const protectedToken = sources.get(value);
      if (protectedToken) tokens.push(protectedToken);
      else if (value === "**/" && (match.index === 0 || expanded[match.index - 1] === "/")) {
        tokens.push({ kind: "directory" });
      } else if (value.startsWith("*")) {
        tokens.push({ kind: "star", crossesSlash: value.startsWith("**") });
        if (value.endsWith("/")) tokens.push({ kind: "literal", value: "/" });
      } else if (value === "?") {
        tokens.push({ kind: "character", characters: new Set(["/"]), negated: true });
      } else {
        const literal = value.startsWith("\\") ? value.slice(1) : value;
        const previous = tokens.at(-1);
        if (previous?.kind === "literal") previous.value += literal;
        else tokens.push({ kind: "literal", value: literal });
      }
    }
    return tokens;
  });
  return {
    match(relativePath: string) {
      return alternatives.some((tokens) => matchTokens(tokens, relativePath, directoryRelative));
    },
  };
}

/** Only indentation display properties are consumed; no editing policy is applied. */
export function parseEditorConfig(contents: string) {
  const sections: EditorConfigSection[] = [];
  let section: EditorConfigSection | undefined;
  let root = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1);
      section = {
        matcher: sectionMatcher(pattern),
        properties: {},
      };
      sections.push(section);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (section === undefined) {
      if (key === "root") root = value === "true";
    } else if (key === "tab_width" || key === "indent_size") {
      section.properties[key] = value;
    }
  }
  return { root, sections };
}

export type ParsedEditorConfig = ReturnType<typeof parseEditorConfig>;

// Repository roots from Git may use forward-slash UNC paths.
function isWindowsConfigPath(path: string): boolean {
  return isWindowsAbsolutePath(path) || /^\/\/[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(path);
}

/** Workspace files share the relative query key refreshed by the file editor's save flow. */
export function editorConfigQueryPath(cwd: string, configPath: string): string {
  const windows = isWindowsConfigPath(cwd);
  const directory = (windows ? cwd.replaceAll("\\", "/") : cwd).replace(/\/+$/, "");
  const prefix = `${directory}/`;
  const withinWorkspace = windows
    ? configPath.toLowerCase().startsWith(prefix.toLowerCase())
    : configPath.startsWith(prefix);
  return withinWorkspace ? configPath.slice(prefix.length) : configPath;
}

/** Nearest directory first, including ancestors outside the workspace until the filesystem root. */
export function editorConfigCandidates(cwd: string, filePath: string) {
  const windows = isWindowsConfigPath(filePath) || isWindowsConfigPath(cwd);
  const normalize = (path: string) => (windows ? path.replaceAll("\\", "/") : path);
  const file = normalize(filePath);
  const absolute =
    file.startsWith("/") || /^[a-z]:\//i.test(file)
      ? file
      : `${normalize(cwd).replace(/\/$/, "")}/${file}`;
  const root =
    absolute.match(/^[a-z]:\//i)?.[0] ??
    (windows && absolute.startsWith("//") ? absolute.match(/^\/\/[^/]+\/[^/]+\//)?.[0] : "/");
  if (root === undefined) return [];
  const segments: string[] = [];
  for (const segment of absolute.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const filename = segments.pop();
  if (!filename) return [];
  let relativePath = filename;
  const candidates: { configPath: string; relativePath: string }[] = [];
  while (true) {
    const directory = segments.length === 0 ? root : `${root}${segments.join("/")}/`;
    candidates.push({ configPath: `${directory}.editorconfig`, relativePath });
    const parent = segments.pop();
    if (parent === undefined) break;
    relativePath = `${parent}/${relativePath}`;
  }
  return candidates;
}

/** Merge matching pairs from farthest to nearest, then resolve tab_width before indent_size. */
export function resolveEditorConfigTabWidth(
  configs: ReadonlyArray<{ config: ParsedEditorConfig; relativePath: string }>,
): number {
  const properties: Record<string, string> = {};
  for (const { config, relativePath } of configs.toReversed()) {
    for (const section of config.sections) {
      if (!section.matcher.match(relativePath)) continue;
      for (const [key, value] of Object.entries(section.properties)) {
        if (value === "unset") delete properties[key];
        else properties[key] = value;
      }
    }
  }
  for (const value of [properties.tab_width, properties.indent_size]) {
    if (value === undefined || !/^\d+$/.test(value)) continue;
    const width = Number(value);
    if (Number.isSafeInteger(width) && width > 0) return width;
  }
  return DEFAULT_TAB_WIDTH;
}
