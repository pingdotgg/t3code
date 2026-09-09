import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as NodeFsPromises from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterAll } from "vitest";

export const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E>,
  );

const tempDirs: Array<string> = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) =>
      NodeFsPromises.rm(dir, { recursive: true, force: true }),
    ),
  );
});

/** Create a temp project directory populated with the given files. */
export const makeProject = async (
  files: Record<string, string>,
): Promise<string> => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var); Vite resolves
  // module ids to real paths, so tests must compare against real paths too.
  const dir = await NodeFsPromises.realpath(
    await NodeFsPromises.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "framework-core-test-"),
    ),
  );
  tempDirs.push(dir);
  const withDefaults = {
    "package.json": JSON.stringify({
      name: "test-project",
      private: true,
      type: "module",
    }),
    ...files,
  };
  for (const [name, content] of Object.entries(withDefaults)) {
    const file = NodePath.join(dir, name);
    await NodeFsPromises.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFsPromises.writeFile(file, content);
  }
  return dir;
};
