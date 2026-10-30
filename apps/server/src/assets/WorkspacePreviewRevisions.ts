import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { mediaFileRevision, openMediaFile } from "./MediaFile.ts";

interface PreviewDirectory {
  readonly workspaceRoot: string;
  readonly baseRelativePath: string;
}

export class WorkspacePreviewRevisions extends Context.Service<
  WorkspacePreviewRevisions,
  {
    readonly observe: (
      input: PreviewDirectory & { readonly relativePath: string },
    ) => Effect.Effect<void>;
    readonly revision: (
      input: PreviewDirectory & { readonly fileRevision: string },
    ) => Effect.Effect<string | undefined>;
  }
>()("t3/assets/WorkspacePreviewRevisions") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directories = yield* Cache.make({
    capacity: 64,
    lookup: (_key: string) =>
      crypto.randomUUIDv4().pipe(
        Effect.orDie,
        Effect.map((generation) => ({
          generation,
          version: 0,
          files: new Map<string, string | null>(),
          overflow: false,
        })),
      ),
  });
  const readRevision = Effect.fn("WorkspacePreviewRevisions.readFile")(function* (
    workspaceRoot: string,
    relativePath: string,
  ) {
    const canonical = yield* fs
      .realPath(path.join(workspaceRoot, relativePath))
      .pipe(Effect.orElseSucceed(() => null));
    if (canonical === null || !isWithinRoot(path, canonical, workspaceRoot)) return null;
    return yield* openMediaFile(canonical).pipe(
      Effect.map((file) => (file === null ? null : mediaFileRevision(file.info))),
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
  });
  const observe = Effect.fn("WorkspacePreviewRevisions.observe")(function* (
    input: PreviewDirectory & { readonly relativePath: string },
  ) {
    const entry = yield* Cache.get(
      directories,
      `${input.workspaceRoot}\0${input.baseRelativePath}`,
    );
    if (entry.overflow) return;
    const revision = yield* readRevision(input.workspaceRoot, input.relativePath);
    if (entry.overflow) return;
    if (!entry.files.has(input.relativePath) && entry.files.size >= 256) {
      entry.overflow = true;
      return;
    }
    if (entry.files.has(input.relativePath) && entry.files.get(input.relativePath) !== revision)
      entry.version++;
    entry.files.set(input.relativePath, revision);
  });
  const revision = Effect.fn("WorkspacePreviewRevisions.revision")(function* (
    input: PreviewDirectory & { readonly fileRevision: string },
  ) {
    const entry = yield* Cache.get(
      directories,
      `${input.workspaceRoot}\0${input.baseRelativePath}`,
    );
    // Large pages keep workspace refreshes rather than retaining unbounded dependency metadata.
    if (entry.overflow) return undefined;
    yield* Effect.forEach(
      [...entry.files.keys()],
      // The revision and readFile spans already cover these per-path rechecks.
      Effect.fnUntraced(function* (relativePath) {
        const revision = yield* readRevision(input.workspaceRoot, relativePath);
        if (entry.files.get(relativePath) !== revision) {
          entry.version++;
          entry.files.set(relativePath, revision);
        }
      }),
      { concurrency: 4, discard: true },
    );
    return `${input.fileRevision}:${entry.generation}:${entry.version}`;
  });
  return WorkspacePreviewRevisions.of({ observe, revision });
});

export const layer = Layer.effect(WorkspacePreviewRevisions, make);
