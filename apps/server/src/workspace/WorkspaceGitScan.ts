import * as NodeOS from "node:os";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { FilesystemScanGitReposInput, FilesystemScanGitReposResult } from "@t3tools/contracts";

export class WorkspaceGitScanError extends Schema.TaggedErrorClass<WorkspaceGitScanError>()(
  "WorkspaceGitScanError",
  {
    parentPath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface WorkspaceGitScanShape {
  readonly scan: (
    input: FilesystemScanGitReposInput,
  ) => Effect.Effect<FilesystemScanGitReposResult, WorkspaceGitScanError>;
}

export class WorkspaceGitScan extends Context.Service<WorkspaceGitScan, WorkspaceGitScanShape>()(
  "t3/workspace/WorkspaceGitScan",
) {}

const SCAN_CONCURRENCY = 32;

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") return NodeOS.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(NodeOS.homedir(), input.slice(2));
  return input;
}

export const makeWorkspaceGitScan = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hasGitMarker = (absolutePath: string) =>
    fileSystem.stat(path.join(absolutePath, ".git")).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    );

  const scan: WorkspaceGitScanShape["scan"] = Effect.fn("WorkspaceGitScan.scan")(function* (input) {
    const normalizedParent = path.resolve(expandHomePath(input.parentPath.trim(), path));

    const stat = yield* fileSystem.stat(normalizedParent).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceGitScanError({
            parentPath: input.parentPath,
            operation: "WorkspaceGitScan.scan:stat",
            detail: cause.message,
            cause,
          }),
      ),
    );
    if (stat.type !== "Directory") {
      return yield* new WorkspaceGitScanError({
        parentPath: input.parentPath,
        operation: "WorkspaceGitScan.scan:stat",
        detail: `Path is not a directory: ${normalizedParent}`,
      });
    }

    const entries = yield* fileSystem.readDirectory(normalizedParent).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceGitScanError({
            parentPath: input.parentPath,
            operation: "WorkspaceGitScan.scan:readDirectory",
            detail: cause.message,
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
  });

  return { scan } satisfies WorkspaceGitScanShape;
});

export const WorkspaceGitScanLive = Layer.effect(WorkspaceGitScan, makeWorkspaceGitScan);
