import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deletePendingAttachment } from "../../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import type { ImportedWorkspace } from "../../orchestration-v2/ThreadImportService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import * as HandoffGit from "./HandoffGit.ts";

/**
 * The checkout a handed-off thread works in here: its bundle, uploaded as a
 * pending attachment, applied in a new worktree of the project. The upload is
 * spent either way; the worktree and branch are undone if the import fails.
 */
export const applyBundle = (input: {
  readonly repoRoot: string;
  readonly handoffId: string;
  readonly bundle: {
    readonly attachmentId: string;
    readonly branch: string | null;
    readonly tip: string;
    readonly snapshot: string;
  };
}): Effect.Effect<
  ImportedWorkspace,
  OrchestratorMcpFailure,
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | VcsProcess.VcsProcess
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const failure = (message: string) =>
      new OrchestratorMcpFailure({ code: "invalid_request", message });
    if (parseThreadSegmentFromAttachmentId(input.bundle.attachmentId) !== "pending") {
      return yield* failure(
        "The bundle must be a pending upload from t3_attachment_prepare_upload.",
      );
    }
    const bundlePath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: input.bundle.attachmentId,
    });
    if (bundlePath === null) {
      return yield* failure("The bundle upload was not found. Upload it again.");
    }
    const worktreesSetting = yield* settings.getSettings.pipe(
      Effect.map((current) => current.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const parent = resolveWorktreesDirectory(worktreesSetting, config.worktreesDir, path);
    if (parent === null) {
      return yield* failure(
        "This environment's worktree location is not usable. Fix it in Settings → Storage.",
      );
    }
    const name = (input.bundle.branch ?? `handoff-${input.handoffId}`).replace(/\//g, "-");
    const worktreePath = path.join(parent, path.basename(input.repoRoot), name);
    const git = yield* HandoffGit.HandoffGit.pipe(Effect.provide(HandoffGit.layer));
    const applied = yield* git
      .apply({
        repoRoot: input.repoRoot,
        worktreePath,
        handoffId: input.handoffId,
        bundlePath,
        branch: input.bundle.branch,
        tip: input.bundle.tip,
        snapshot: input.bundle.snapshot,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "git_failed" ? "orchestration_error" : "invalid_request",
              message: error.message,
            }),
        ),
        Effect.ensuring(deletePendingAttachment(input.bundle.attachmentId).pipe(Effect.ignore)),
      );
    const processes = yield* VcsProcess.VcsProcess;
    return {
      worktreePath,
      branch: applied.branch,
      undo: processes
        .run({
          operation: "HandoffImport.undo",
          command: "git",
          cwd: input.repoRoot,
          args: ["worktree", "remove", "--force", worktreePath],
        })
        .pipe(Effect.ignore),
    } satisfies ImportedWorkspace;
  });
