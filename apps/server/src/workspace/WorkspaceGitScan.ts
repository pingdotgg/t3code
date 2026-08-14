import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { FilesystemScanGitReposInput, FilesystemScanGitReposResult } from "@t3tools/contracts";
import { expandHomePath } from "../pathExpansion.ts";

class WorkspaceGitScanStatFailedError extends Schema.TaggedErrorClass<WorkspaceGitScanStatFailedError>()(
  "WorkspaceGitScanStatFailedError",
  {
    parentPath: Schema.String,
    normalizedParentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect workspace scan path '${this.normalizedParentPath}'.`;
  }
}

class WorkspaceGitScanNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceGitScanNotDirectoryError>()(
  "WorkspaceGitScanNotDirectoryError",
  {
    parentPath: Schema.String,
    normalizedParentPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace scan path is not a directory: '${this.normalizedParentPath}'.`;
  }
}

class WorkspaceGitScanReadDirectoryFailedError extends Schema.TaggedErrorClass<WorkspaceGitScanReadDirectoryFailedError>()(
  "WorkspaceGitScanReadDirectoryFailedError",
  {
    parentPath: Schema.String,
    normalizedParentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read workspace scan directory '${this.normalizedParentPath}'.`;
  }
}

type WorkspaceGitScanError =
  | WorkspaceGitScanStatFailedError
  | WorkspaceGitScanNotDirectoryError
  | WorkspaceGitScanReadDirectoryFailedError;

export class WorkspaceGitScan extends Context.Service<
  WorkspaceGitScan,
  {
    readonly scan: (
      input: FilesystemScanGitReposInput,
    ) => Effect.Effect<FilesystemScanGitReposResult, WorkspaceGitScanError>;
  }
>()("t3/workspace/WorkspaceGitScan") {}

const SCAN_CONCURRENCY = 32;

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hasGitMarker = (absolutePath: string) =>
    fileSystem.stat(path.join(absolutePath, ".git")).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );

  const scan: WorkspaceGitScan["Service"]["scan"] = Effect.fn("WorkspaceGitScan.scan")(
    function* (input) {
      const normalizedParent = path.resolve(expandHomePath(input.parentPath.trim()));

      const stat = yield* fileSystem.stat(normalizedParent).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceGitScanStatFailedError({
              parentPath: input.parentPath,
              normalizedParentPath: normalizedParent,
              cause,
            }),
        ),
      );
      if (stat.type !== "Directory") {
        return yield* new WorkspaceGitScanNotDirectoryError({
          parentPath: input.parentPath,
          normalizedParentPath: normalizedParent,
        });
      }

      const entries = yield* fileSystem.readDirectory(normalizedParent).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceGitScanReadDirectoryFailedError({
              parentPath: input.parentPath,
              normalizedParentPath: normalizedParent,
              cause,
            }),
        ),
      );

      const parentHasGit = yield* hasGitMarker(normalizedParent);

      const childInfos = yield* Effect.forEach(
        entries.toSorted((left, right) => left.localeCompare(right)),
        (name) =>
          Effect.gen(function* () {
            if (name === ".git") return null;
            const absolutePath = path.join(normalizedParent, name);
            const childStat = yield* fileSystem
              .stat(absolutePath)
              .pipe(Effect.orElseSucceed(() => null));
            if (!childStat || childStat.type !== "Directory") return null;
            const hasGit = yield* hasGitMarker(absolutePath);
            return { name, absolutePath, hasGit };
          }),
        { concurrency: SCAN_CONCURRENCY },
      );

      return {
        parentPath: normalizedParent,
        parentHasGit,
        children: Arr.filter(
          childInfos,
          (child): child is NonNullable<typeof child> => child !== null,
        ),
      };
    },
  );

  return WorkspaceGitScan.of({ scan });
});

export const layer = Layer.effect(WorkspaceGitScan, make);
