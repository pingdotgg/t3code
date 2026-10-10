/**
 * InstructionTracking - tells which project instruction files git tracks, so a confirmation for
 * moving, merging or deleting one can say whether git can undo it.
 *
 * It is separate from `InstructionCatalog` because the catalog's list spawns nothing and loads on
 * every page open; this runs one `git ls-files` for all the files asked about, and only when a
 * person is about to confirm a change. Nothing is written.
 *
 * @module InstructionTracking
 */
import type {
  InstructionError,
  InstructionTrackedInput,
  InstructionTrackedResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { trackedFiles } from "../vcs/GitTrackedFiles.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as InstructionCatalog from "./InstructionCatalog.ts";

export class InstructionTracking extends Context.Service<
  InstructionTracking,
  {
    /**
     * The ids among `ids` of project files that git tracks. An id that doesn't name a project
     * file, a file that sits outside the repository, and every file when git fails count as not
     * tracked. A file is tracked by its own path, so a link git tracks counts, whatever it
     * points at. A folder that isn't a registered project's workspace root is refused.
     */
    readonly tracked: (
      input: InstructionTrackedInput,
    ) => Effect.Effect<InstructionTrackedResult, InstructionError>;
  }
>()("t3/instructions/InstructionTracking") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* InstructionCatalog.InstructionCatalog;
  const vcs = yield* VcsProcess.VcsProcess;

  const tracked: InstructionTracking["Service"]["tracked"] = Effect.fn(
    "InstructionTracking.tracked",
  )(function* (input) {
    const realCwd = yield* fileSystem
      .realPath(input.cwd)
      .pipe(Effect.orElseSucceed(() => input.cwd));

    // The path git knows each file by, from the project's real folder.
    const files = new Map<string, string>();
    for (const id of input.ids) {
      const entry = yield* catalog.resolve({ cwd: input.cwd, id }).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          // An id that names nothing here is just not tracked; the folder is refused outright.
          InstructionError: (error) =>
            error.reason === "unregisteredProject"
              ? Effect.fail(error)
              : Effect.succeed(Option.none()),
        }),
      );
      if (Option.isNone(entry) || entry.value.scope !== "project") continue;
      const folder = yield* fileSystem
        .realPath(path.dirname(entry.value.path))
        .pipe(Effect.orElseSucceed(() => path.dirname(entry.value.path)));
      const inside = path.relative(realCwd, path.join(folder, path.basename(entry.value.path)));
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue;
      files.set(inside.replaceAll("\\", "/"), id);
    }
    if (files.size === 0) return { tracked: [] };

    const trackedPaths = yield* trackedFiles(vcs, {
      operation: "InstructionTracking.tracked",
      cwd: input.cwd,
      files: [...files.keys()],
    });
    return { tracked: [...files].flatMap(([file, id]) => (trackedPaths.has(file) ? [id] : [])) };
  });

  return InstructionTracking.of({ tracked });
});

export const layer = Layer.effect(InstructionTracking, make);
