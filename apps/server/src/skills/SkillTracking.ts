/**
 * SkillTracking - tells which project skills git tracks, so a confirmation for moving or deleting
 * them can say whether git can undo it.
 *
 * It is separate from `SkillCatalog` because the catalog's list spawns nothing and loads on every
 * page open; this runs one `git ls-files` for all the skills asked about, and only when a person
 * is about to confirm a change. Nothing is written.
 *
 * @module SkillTracking
 */
import type { SkillRequestError, SkillTrackedInput, SkillTrackedResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SkillCatalog from "./SkillCatalog.ts";

const SKILL_FILE = "SKILL.md";

export class SkillTracking extends Context.Service<
  SkillTracking,
  {
    /**
     * The names of the project skills among `skills` whose SKILL.md git tracks. A skill that
     * isn't where the client said, isn't a project skill, sits outside the repository, or whose
     * folder is only reached through a link counts as not tracked, and so does every skill when
     * git fails. The folder must be a registered project's workspace root, or the request is
     * refused before git runs.
     */
    readonly tracked: (
      input: SkillTrackedInput,
    ) => Effect.Effect<SkillTrackedResult, SkillRequestError>;
  }
>()("t3/skills/SkillTracking") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* SkillCatalog.SkillCatalog;
  const vcs = yield* VcsProcess.VcsProcess;

  const tracked: SkillTracking["Service"]["tracked"] = Effect.fn("SkillTracking.tracked")(
    function* (input) {
      const asked = input.skills.filter((ref) => ref.scope === "project");
      const resolved = yield* catalog.resolve({ cwd: input.cwd, skills: asked });
      const realCwd = yield* fileSystem
        .realPath(input.cwd)
        .pipe(Effect.orElseSucceed(() => input.cwd));

      // The path git knows each skill's SKILL.md by, from the project's real folder.
      const files = new Map<string, string>();
      for (const ref of asked) {
        const skill = resolved.find(
          (item) =>
            item.scope === "project" && item.name === ref.name && item.displayHome === ref.home,
        );
        if (skill === undefined || !skill.own) continue;
        const inside = path.relative(realCwd, skill.home);
        if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue;
        files.set(`${inside.replaceAll("\\", "/")}/${SKILL_FILE}`, ref.name);
      }
      if (files.size === 0) return { tracked: [] };

      const result = yield* vcs
        .run({
          operation: "SkillTracking.tracked",
          command: "git",
          args: [
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--cached",
            "-z",
            "--",
            ...files.keys(),
          ],
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1024,
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (result === undefined || result.exitCode !== 0) return { tracked: [] };

      const listed = new Set(result.stdout.split("\0"));
      return {
        tracked: [...files].flatMap(([file, name]) => (listed.has(file) ? [name] : [])),
      };
    },
  );

  return SkillTracking.of({ tracked });
});

export const layer = Layer.effect(SkillTracking, make);
