/**
 * SkillLibrary - the one copy behind a Global skill that is used in only some projects.
 *
 * Such a skill lives in `~/.agents/skill-library/<name>`, and each project that uses it has an
 * absolute link to that at `<project>/.agents/skills/<name>` (and one in another agent's own folder
 * when that agent needs it). An edit to the skill shows up in every project, and the links sit
 * outside git (see `SkillGitExclude`).
 *
 * No agent scans the library folder, which is why a skill kept there is used only where it is
 * linked. Each agent reads a folder named `skills` inside `.agents` or its own folder, never a
 * neighbour of it, and none of the patterns below matches `skill-library`:
 * - Claude Code reads `<config dir>/skills` and `<project>/.claude/skills` (`ClaudeSkills.ts`).
 * - Codex's roots are `<home>/.agents/skills` (`roots_from_layer_stack`) and each ancestor's
 *   `.agents/skills` (`repo_agents_skill_roots`), `AGENTS_DIR_NAME` and `SKILLS_DIR_NAME` in
 *   codex-rs/ext/skills/src/host_roots.rs (openai/codex@8e23d1836f).
 * - OpenCode scans `skills/**\/SKILL.md` under `~/.agents` and the project's `.agents`
 *   (`EXTERNAL_SKILL_PATTERN` in packages/opencode/src/skill/index.ts, anomalyco/opencode@4ac0d9c3d1).
 * - Pi reads `~/.agents/skills` and `.agents/skills` (`userAgentsSkillsDir` in
 *   packages/coding-agent/src/core/package-manager.ts and docs/skills.md, earendil-works/pi@43d3763991).
 * - Cursor, Grok and Antigravity read the folders in `AgentSkillFolders.ts`, none of them this one.
 *
 * @module SkillLibrary
 */
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  AGENT_SKILL_FOLDERS,
  STANDARD_SKILL_FOLDER,
} from "@t3tools/provider-core/server/AgentSkillFolders";

/** Under the home folder; the shared folder's neighbour, not inside it. */
export const LIBRARY_FOLDER = ".agents/skill-library";

/** Every folder an agent reads skills from inside a project, the shared one first. */
const PROJECT_SKILL_FOLDERS: readonly string[] = [
  ...new Set([
    STANDARD_SKILL_FOLDER,
    ...AGENT_SKILL_FOLDERS.flatMap((agent) =>
      agent.reads.filter((root) => root.scope === "project").map((root) => root.folder),
    ),
  ]),
];

/**
 * The workspace roots of this environment's registered projects. The server provides the real
 * list to the skill catalog; without one, no project is known and no library skill shows the
 * projects it is used in.
 */
export const RegisteredProjects = Context.Reference<Effect.Effect<ReadonlyArray<string>>>(
  "t3/skills/RegisteredProjects",
  { defaultValue: () => Effect.succeed([]) },
);

/** Whether a link at `linkPath` with this target, as written, leads to `entry`. */
export const linkLeadsTo = (
  path: Path.Path,
  link: { readonly path: string; readonly target: string },
  entry: string,
) => path.resolve(path.dirname(link.path), link.target) === entry;

/** A link in one project's skill folder that leads to a library entry. */
export interface LibraryLink {
  readonly project: string;
  readonly path: string;
  /** What the link points at, as written. */
  readonly target: string;
  /** The folder it is in, relative to the project. */
  readonly folder: string;
}

/**
 * Every link, in any agent's project folder in these projects, that leads to a library entry,
 * for each skill in `entries` (its name, then its library entry's path). A folder is read once
 * per project whatever the number of skills, and only a name that is a library skill is looked at
 * further. The links of a skill come in the order of the projects, then of the folders.
 */
export const libraryLinksIn = Effect.fn("SkillLibrary.libraryLinksIn")(function* (input: {
  readonly roots: ReadonlyArray<string>;
  readonly entries: ReadonlyMap<string, string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = new Map<string, LibraryLink[]>();
  if (input.entries.size === 0) return found;
  const perProject = yield* Effect.forEach(
    input.roots,
    (project) =>
      Effect.gen(function* () {
        const links: Array<readonly [string, LibraryLink]> = [];
        for (const folder of PROJECT_SKILL_FOLDERS) {
          const names = yield* fileSystem
            .readDirectory(path.join(project, folder))
            .pipe(Effect.orElseSucceed((): string[] => []));
          for (const name of names) {
            const entry = input.entries.get(name);
            if (entry === undefined) continue;
            const linkPath = path.join(project, folder, name);
            const target = yield* fileSystem.readLink(linkPath).pipe(
              Effect.map((value): string | undefined => value),
              Effect.orElseSucceed(() => undefined),
            );
            if (target !== undefined && linkLeadsTo(path, { path: linkPath, target }, entry)) {
              links.push([name, { project, path: linkPath, target, folder }]);
            }
          }
        }
        return links;
      }),
    { concurrency: 8 },
  );
  for (const links of perProject) {
    for (const [name, link] of links) found.set(name, [...(found.get(name) ?? []), link]);
  }
  return found;
});

/** Every link, in any agent's project folder in these projects, that leads to `entry`. */
export const libraryLinksOf = Effect.fn("SkillLibrary.libraryLinksOf")(function* (input: {
  readonly roots: ReadonlyArray<string>;
  readonly name: string;
  readonly entry: string;
}) {
  const found = yield* libraryLinksIn({
    roots: input.roots,
    entries: new Map([[input.name, input.entry]]),
  });
  return found.get(input.name) ?? [];
});

/**
 * Links to a project's library skills into a worktree that was just made from it. The links sit
 * outside git, so a worktree has none until they are made. Nothing in the way is replaced, and a
 * failure is logged and goes no further: a worktree without the links is still a worktree.
 *
 * A worktree is a checkout of the whole repository, so a project that is a folder inside its
 * repository is at `prefix` under the worktree's root.
 */
export const restoreLibraryLinks = Effect.fn("SkillLibrary.restoreLibraryLinks")(
  function* (input: {
    readonly project: string;
    readonly worktree: string;
    /** The project's folder relative to its repository's root, empty when it is the root. */
    readonly prefix: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const library = path.join(home, LIBRARY_FOLDER);
    for (const folder of PROJECT_SKILL_FOLDERS) {
      const names = yield* fileSystem
        .readDirectory(path.join(input.project, folder))
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const name of names) {
        const linkPath = path.join(input.project, folder, name);
        const target = yield* fileSystem.readLink(linkPath).pipe(
          Effect.map((value): string | undefined => value),
          Effect.orElseSucceed(() => undefined),
        );
        if (target === undefined) continue;
        // A relative link would lead somewhere else from the worktree's own depth, so the new
        // link names the library skill's absolute path.
        const entry = path.resolve(path.dirname(linkPath), target);
        if (path.dirname(entry) !== library) continue;
        const created = path.join(input.worktree, input.prefix, folder, name);
        yield* fileSystem.makeDirectory(path.dirname(created), { recursive: true });
        // A bare create: something already there, such as a skill the project commits, stays.
        yield* fileSystem.symlink(entry, created).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
          }),
        );
      }
    }
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("could not link library skills into the new worktree", {
              worktree: input.worktree,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
);
