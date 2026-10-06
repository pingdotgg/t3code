import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Where Codex reads skills for `cwd`, checked against codex-cli 0.160:
 * `$CODEX_HOME/skills` and `~/.agents/skills`, then `.agents/skills` and
 * `.codex/skills` in `cwd` and each parent up to the repository root.
 *
 * `homePath` is the home the app-server is started with; when it is blank the
 * app-server inherits `CODEX_HOME` from `environment`, then defaults to
 * `~/.codex`, and so does this.
 */
export const codexSkillRoots = Effect.fn("codexSkillRoots")(function* (input: {
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = input.environment.HOME ?? NodeOS.homedir();
  const codexHome = input.homePath.trim()
    ? path.resolve(expandHomePath(input.homePath.trim()))
    : input.environment.CODEX_HOME?.trim()
      ? path.resolve(input.environment.CODEX_HOME.trim())
      : path.join(userHome, ".codex");

  const start = path.resolve(input.cwd);
  let directories = [start];
  for (let current = start; ;) {
    const isRepositoryRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRepositoryRoot) break;
    const parent = path.dirname(current);
    if (parent === current) {
      directories = [start];
      break;
    }
    directories.push(parent);
    current = parent;
  }
  return [
    path.join(codexHome, "skills"),
    path.join(userHome, ".agents", "skills"),
    ...directories.flatMap((directory) => [
      path.join(directory, ".agents", "skills"),
      path.join(directory, ".codex", "skills"),
    ]),
  ];
});
