/**
 * OpenCode 2 over ACP advertises only commands, never the skills it loads, so
 * T3 mirrors OpenCode 2.1's own skill discovery: `.claude/skills` and
 * `.agents/skills` (compatibility), then `skill(s)` in the global, project
 * `.opencode`, and system config directories. Skills named in `opencode.json`
 * and plugin-provided skills are not listed.
 */

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export const OPENCODE_V2_AGENT_ID = "opencode-v2";

// OpenCode stops descending at depth 6 and skips dot-directories and these.
const MAX_SKILL_DEPTH = 6;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
// `yaml` parses large mappings in quadratic time (16KB ≈ 70ms, 100KB ≈ 90s),
// so frontmatter beyond these caps is listed without being parsed.
const MAX_FRONTMATTER_BYTES = 8_192;
const MAX_FRONTMATTER_PARSE_BYTES = 262_144;

interface ScanBudget {
  entries: number;
  bytes: number;
  parseBytes: number;
}

interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

// Matches OpenCode's flag parsing, which neither trims nor accepts "yes".
const isTruthyFlag = (value: string | undefined) =>
  value === "1" || value?.toLowerCase() === "true";

// OpenCode retries unquoted colons in values ("description: Use when: x") as
// block scalars, as other agents accept them.
const sanitizeFrontmatter = (frontmatter: string) =>
  frontmatter
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line];
      const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
      const value = entry?.[2]?.trim();
      if (!entry || !value || value === ">" || value === "|") return [line];
      if (value.startsWith('"') || value.startsWith("'") || !value.includes(":")) return [line];
      return [`${entry[1]}: |-`, `  ${value}`];
    })
    .join("\n");

/**
 * Follows OpenCode's gray-matter reading: no frontmatter is a valid skill,
 * while unparseable YAML or a non-string `name`/`description` skips it.
 * `unchecked` means the frontmatter was too large to parse within budget.
 */
const readFrontmatter = (
  contents: string,
  budget: ScanBudget,
): SkillFrontmatter | "invalid" | "unchecked" => {
  const text = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
  if (!text.startsWith("---") || text[3] === "-") return {};
  const openerEnd = text.indexOf("\n", 3);
  // gray-matter reads any text after a line-less opener as an engine name and
  // throws, and reads an unclosed block through the end of the file.
  if (openerEnd === -1) return text.slice(3).trim() === "" ? {} : "invalid";
  const close = text.indexOf("\n---", 3);
  const frontmatter = text.slice(openerEnd, close === -1 ? text.length : close);
  if (frontmatter.length > MAX_FRONTMATTER_BYTES) return "unchecked";
  const blank = frontmatter.split("\n").every((line) => {
    const trimmed = line.trim();
    return trimmed === "" || (trimmed.startsWith("#") && trimmed.length > 1);
  });
  if (blank) return {};
  const parse = (source: string): { readonly value: unknown } | "invalid" | "unchecked" => {
    if (source.length > MAX_FRONTMATTER_BYTES || source.length > budget.parseBytes) {
      return "unchecked";
    }
    budget.parseBytes -= source.length;
    try {
      return { value: parseYamlDocument(source) };
    } catch {
      return "invalid";
    }
  };
  let result = parse(frontmatter);
  if (result === "invalid") result = parse(sanitizeFrontmatter(frontmatter));
  if (typeof result === "string") return result;
  const parsed = result.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
  const { name, description } = parsed as Record<string, unknown>;
  if (name !== undefined && typeof name !== "string") return "invalid";
  if (description !== undefined && typeof description !== "string") return "invalid";
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
};

const systemConfigDirectory = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
) => {
  if (platform === "darwin") return "/Library/Application Support/opencode";
  if (platform === "win32")
    return path.join(environment.ProgramData || "C:\\ProgramData", "opencode");
  return "/etc/opencode";
};

export const discoverOpenCodeAcpSkills = Effect.fn("discoverOpenCodeAcpSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const orUndefined = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.orElseSucceed(() => undefined));
  const resolve = (target: string) =>
    fileSystem
      .realPath(path.resolve(target))
      .pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const isDirectory = (target: string) =>
    orUndefined(fileSystem.stat(target)).pipe(Effect.map((info) => info?.type === "Directory"));

  const configHome = environment.XDG_CONFIG_HOME || path.join(home, ".config");
  const globalConfig = environment.OPENCODE_CONFIG_DIR || path.join(configHome, "opencode");
  const systemConfig = systemConfigDirectory(platform, environment, path);
  const globalClaude = path.join(home, ".claude");
  const globalAgents = path.join(home, ".agents");
  const includeClaude = !(
    isTruthyFlag(environment.OPENCODE_DISABLE_CLAUDE_CODE) ||
    isTruthyFlag(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)
  );
  const includeProject = !isTruthyFlag(
    environment.OPENCODE_CONFIG_PROJECT_DISABLE ?? environment.OPENCODE_DISABLE_PROJECT_CONFIG,
  );

  const globalRoots = yield* Effect.forEach(
    [systemConfig, globalConfig, globalClaude, globalAgents],
    resolve,
  );
  // Project directories nearest the root come first so the workspace's own win.
  const project = { claude: [] as string[], agents: [] as string[], opencode: [] as string[] };
  const current = yield* resolve(cwd);
  if (includeProject && !globalRoots.slice(0, 2).includes(current)) {
    const ancestors: Array<string> = [];
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      ancestors.unshift(directory);
      if (path.dirname(directory) === directory) break;
    }
    for (const directory of ancestors) {
      const parent = yield* resolve(directory);
      for (const [name, list] of [
        [".claude", project.claude],
        [".agents", project.agents],
        [".opencode", project.opencode],
      ] as const) {
        if (globalRoots.includes(yield* resolve(path.join(parent, name)))) continue;
        if (name !== ".opencode" || (yield* isDirectory(path.join(directory, name)))) {
          list.push(path.join(directory, name));
        }
      }
    }
  }
  const compatibilityRoots = [
    ...new Set([
      ...(includeClaude ? [globalClaude, ...project.claude] : []),
      globalAgents,
      ...project.agents,
    ]),
  ].map((root) => path.join(root, "skills"));
  const configDirectories = [
    globalConfig,
    ...project.opencode,
    ...((yield* isDirectory(systemConfig)) ? [systemConfig] : []),
  ];
  const configRoots = [
    ...new Set(
      configDirectories.flatMap((directory) => [
        path.join(directory, "skill"),
        path.join(directory, "skills"),
      ]),
    ),
  ];

  const budget: ScanBudget = {
    entries: MAX_SCAN_ENTRIES,
    bytes: MAX_SCAN_BYTES,
    parseBytes: MAX_FRONTMATTER_PARSE_BYTES,
  };
  const scan = Effect.fn("scanOpenCodeAcpSkillRoot")(function* (root: string) {
    const files: Array<string> = [];
    const queue = [{ directory: root, depth: 0 }];
    for (const { directory, depth } of queue) {
      if (budget.entries <= 0) break;
      const entries = yield* orUndefined(fileSystem.readDirectory(directory));
      if (!entries) continue;
      const visible = entries
        .filter((entry) => !entry.startsWith(".") && !IGNORED_DIRECTORIES.has(entry))
        .toSorted()
        .slice(0, budget.entries);
      budget.entries -= visible.length;
      const children = yield* Effect.forEach(visible, (entry) =>
        orUndefined(fileSystem.stat(path.join(directory, entry))).pipe(
          Effect.map((info) => ({ entry, child: path.join(directory, entry), type: info?.type })),
        ),
      );
      const skill = children.find(({ entry, type }) => entry === "SKILL.md" && type === "File");
      if (skill) {
        files.push(skill.child);
        continue;
      }
      for (const { entry, child, type } of children) {
        if (depth === 0 && type === "File" && entry.endsWith(".md")) files.push(child);
        if (depth < MAX_SKILL_DEPTH && type === "Directory") {
          queue.push({ directory: child, depth: depth + 1 });
        }
      }
    }
    return files.toSorted();
  });

  // A later root replaces an earlier skill with the same ID, as in OpenCode.
  const skills = new Map<string, ServerProviderSkill>();
  const load = Effect.fn("loadOpenCodeAcpSkillRoot")(function* (root: string) {
    for (const skillPath of yield* scan(root)) {
      const name =
        path.dirname(skillPath) === root && path.basename(skillPath) !== "SKILL.md"
          ? path.basename(skillPath, ".md")
          : path.basename(path.dirname(skillPath));
      const info = yield* orUndefined(fileSystem.stat(skillPath));
      if (!name.trim() || !info) continue;
      const size = Number(info.size);
      // OpenCode skips empty and unreadable files; past the byte caps T3
      // lists the skill without reading it.
      if (size === 0) continue;
      let frontmatter: ReturnType<typeof readFrontmatter> = "unchecked";
      if (size <= MAX_SKILL_BYTES && size <= budget.bytes) {
        const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
        if (!contents) continue;
        budget.bytes -= size;
        frontmatter = readFrontmatter(contents, budget);
      }
      if (frontmatter === "invalid") continue;
      const displayName = frontmatter === "unchecked" ? undefined : frontmatter.name?.trim();
      const description = frontmatter === "unchecked" ? undefined : frontmatter.description?.trim();
      skills.set(name, {
        name,
        path: skillPath,
        enabled: true,
        ...(displayName && displayName !== name ? { displayName } : {}),
        ...(description ? { description } : {}),
      });
    }
  });

  for (const root of compatibilityRoots) {
    const resolved = yield* orUndefined(fileSystem.realPath(root));
    if (resolved) yield* load(resolved);
  }
  for (const root of configRoots) {
    if (yield* isDirectory(root)) yield* load(root);
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
});
