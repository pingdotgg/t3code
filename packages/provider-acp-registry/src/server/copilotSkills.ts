// Copilot's ACP `available_commands_update` lists skills as ordinary command names.
// The `$` prefix belongs to other agents, so the skill menu has to match these names
// against the folders Copilot itself reads.

import type { ServerProviderSkill } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const SKILL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MAX_FRONTMATTER_BYTES = 16_384;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES_PER_ROOT = 4_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "venv",
  "__pycache__",
]);

const PROJECT_SKILL_ROOTS = [".github/skills", ".agents/skills", ".claude/skills"] as const;

/** Registry id, or a local executable named `copilot`. Local installs have no registry id. */
export function isCopilotAcpSettings(settings: {
  readonly source: "registry" | "local";
  readonly agentId: string;
  readonly commandPath: string;
}): boolean {
  const registryAgentId = settings.source === "local" ? "" : settings.agentId;
  return (
    registryAgentId === "github-copilot-cli" ||
    (settings.source === "local" &&
      /^copilot(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? ""))
  );
}

function isSkillToken(name: string): boolean {
  return SKILL_TOKEN.test(name) && /[A-Za-z]/u.test(name);
}

function skillMetadata(
  contents: string,
  folderName: string,
): { readonly name: string; readonly description?: string } | undefined {
  const frontmatter = FRONTMATTER.exec(contents)?.[1];
  const declared = frontmatter
    ? /^name:[ \t]*(.+)$/m
        .exec(frontmatter)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "")
    : undefined;
  const name = declared && isSkillToken(declared) ? declared : folderName;
  if (!isSkillToken(name)) return undefined;
  const description = frontmatter
    ? /^description:[ \t]*(.+)$/m
        .exec(frontmatter)?.[1]
        ?.trim()
        .replace(/^["']|["']$/g, "")
    : undefined;
  return description ? { name, description: description.slice(0, 1_024) } : { name };
}

export const discoverCopilotSkills = Effect.fn("discoverCopilotSkills")(function* (
  cwd: string | null | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  const copilotHome = environment.COPILOT_HOME?.trim() || (home ? path.join(home, ".copilot") : "");
  // Personal roots first. A project skill with the same name replaces one.
  const roots: Array<{ readonly directory: string; readonly scope: "project" | "user" }> = [];
  if (copilotHome) {
    roots.push({ directory: path.join(copilotHome, "skills"), scope: "user" });
    roots.push({ directory: path.join(copilotHome, "installed-plugins"), scope: "user" });
  }
  if (home) roots.push({ directory: path.join(home, ".agents", "skills"), scope: "user" });
  if (cwd) {
    for (const relative of PROJECT_SKILL_ROOTS) {
      roots.push({ directory: path.join(cwd, relative), scope: "project" });
    }
  }

  const skills = new Map<string, ServerProviderSkill>();
  const seenRoots = new Set<string>();
  let remainingEntries = 0;

  // Untraced: this recurses once per scanned directory; discoverCopilotSkills is the span.
  const visit: (
    directory: string,
    scope: "project" | "user",
    depth: number,
  ) => Effect.Effect<void> = Effect.fnUntraced(function* (directory, scope, depth) {
    if (depth > MAX_SCAN_DEPTH || remainingEntries <= 0) return;
    const resolved = yield* fileSystem.realPath(directory).pipe(Effect.option);
    if (Option.isNone(resolved) || seenRoots.has(resolved.value)) return;
    seenRoots.add(resolved.value);

    const skillPath = path.join(directory, "SKILL.md");
    const skillInfo = yield* fileSystem.stat(skillPath).pipe(Effect.option);
    // The scan root is a folder of skills, not a skill named "skills".
    if (depth > 0 && Option.isSome(skillInfo) && skillInfo.value.type === "File") {
      const folderName = path.basename(directory);
      const head = yield* fileSystem.open(skillPath).pipe(
        Effect.flatMap((file) => file.readAlloc(MAX_FRONTMATTER_BYTES)),
        Effect.scoped,
        Effect.option,
        Effect.map(Option.flatten),
      );
      const metadata = Option.isSome(head)
        ? skillMetadata(new TextDecoder().decode(head.value), folderName)
        : isSkillToken(folderName)
          ? { name: folderName }
          : undefined;
      if (metadata) {
        skills.set(metadata.name.toLowerCase(), {
          name: metadata.name,
          path: skillPath,
          scope,
          enabled: true,
          ...(metadata.description ? { description: metadata.description } : {}),
        });
      }
      return;
    }

    const listed = yield* fileSystem.readDirectory(directory).pipe(Effect.option);
    if (Option.isNone(listed)) return;
    for (const entry of listed.value) {
      if (remainingEntries <= 0) return;
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      remainingEntries -= 1;
      const child = path.join(directory, entry);
      const info = yield* fileSystem.stat(child).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      yield* visit(child, scope, depth + 1);
    }
  });

  for (const root of roots) {
    remainingEntries = MAX_SCAN_ENTRIES_PER_ROOT;
    yield* visit(root.directory, root.scope, 0);
  }
  return [...skills.values()];
});

/** Copilot runs a skill as `/name`. The composer inserts `$name`. */
export function rewriteCopilotSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  const known = new Set([...skillNames].map((name) => name.toLowerCase()));
  return prompt.replace(
    new RegExp(SKILL_MENTION_PATTERN.source, "gu"),
    (match, prefix: string, name: string) =>
      known.has(name.toLowerCase()) ? `${prefix}/${name}` : match,
  );
}

export function hasCopilotSkillMention(prompt: string): boolean {
  return new RegExp(SKILL_MENTION_PATTERN.source, "u").test(prompt);
}
