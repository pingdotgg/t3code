import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import { isWithinRoot } from "../../../workspace/KnownWorkspaces.ts";
import * as WorkspaceFolders from "../../../workspace/WorkspaceFolders.ts";

/**
 * The files among `paths` that are not the thread's own: outside the folders it works in and
 * not one of its attachments. Each is named by what it resolves to, links followed, so a link
 * inside a folder to a file elsewhere is that file. A path that cannot be resolved, or a thread
 * whose folders cannot be read, is placed nowhere, and so is outside.
 */
export const filesOutsideThread = Effect.fn("PreviewToolkit.filesOutsideThread")(function* (
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath">,
  paths: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
  const resolved = (target: string) =>
    path.isAbsolute(target)
      ? fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => undefined))
      : Effect.undefined;

  const cwd =
    thread.worktreePath ??
    (yield* projects.get(thread.projectId).pipe(
      Effect.map(Option.match({ onNone: () => undefined, onSome: (row) => row.workspaceRoot })),
      Effect.orElseSucceed(() => undefined),
    ));
  const folders = yield* workspaceFolders
    .forThread({ projectId: thread.projectId, worktreePath: thread.worktreePath })
    .pipe(
      Effect.map((workspace) => workspace.folders.map((folder) => folder.path)),
      Effect.orElseSucceed(() => []),
    );
  const roots = (yield* Effect.forEach([...(cwd === undefined ? [] : [cwd]), ...folders], resolved))
    // A filesystem root as a folder would place every file inside it.
    .filter((root) => root !== undefined && path.dirname(root) !== root);
  const attachments = yield* resolved(config.attachmentsDir);
  const segment = toSafeThreadAttachmentSegment(thread.id);
  const isOwnAttachment = (real: string) =>
    attachments !== undefined &&
    segment !== null &&
    path.dirname(real) === attachments &&
    path.basename(real).startsWith(`${segment}-`);

  const outside: Array<string> = [];
  for (const given of paths) {
    const real = yield* resolved(given);
    if (
      real !== undefined &&
      (roots.some((root) => isWithinRoot(path, real, root!)) || isOwnAttachment(real))
    )
      continue;
    outside.push(real ?? given);
  }
  return outside;
});
