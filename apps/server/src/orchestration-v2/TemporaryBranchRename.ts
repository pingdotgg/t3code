import {
  CommandId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export interface TemporaryBranchRenameInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly message: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly context?: OrchestrationMessageContext | undefined;
  };
}

/**
 * Names a worktree thread's temporary `t3code/<hash>` branch from its first
 * message. Thread launch calls it when it has that message, and the thread's
 * first run start calls it too, which covers launches without one. Each thread
 * is attempted once per server, so the two callers never rename twice. A
 * failure is logged and the temporary name stays.
 */
export class TemporaryBranchRename extends Context.Service<
  TemporaryBranchRename,
  {
    readonly rename: (input: TemporaryBranchRenameInput) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/TemporaryBranchRename") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  // Optional: without it the writer model is used without an availability check.
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const attempted = new Set<ThreadId>();

  const rename = Effect.fn("TemporaryBranchRename.rename")(function* (
    input: TemporaryBranchRenameInput,
  ) {
    const { branch: oldBranch, worktreePath: cwd } = input;
    if (cwd === null || oldBranch === null || !isTemporaryWorktreeBranch(oldBranch)) return;
    const first = yield* Effect.sync(() => {
      if (attempted.has(input.threadId)) return false;
      attempted.add(input.threadId);
      return true;
    });
    if (!first) return;
    yield* Effect.gen(function* () {
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        input.projectId,
      ).settings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : ServerSettings.resolveSourceControlWriterModelSelection(
              settings,
              Option.isSome(providerRegistry)
                ? yield* providerRegistry.value.getProviders
                : undefined,
            );
      const generated = yield* textGeneration.generateBranchName({
        naming: {
          mode: settings.branchNamingMode,
          prefix: settings.branchNamePrefix,
          instructions: settings.branchNameInstructions,
        },
        cwd,
        message: input.message.text,
        attachments: input.message.attachments,
        ...(input.message.context ? { context: input.message.context } : {}),
        modelSelection,
      });
      const renamed = yield* git.renameBranch({
        cwd,
        oldBranch,
        newBranch: generated.branch,
        ...(settings.branchNamingMode === "custom" ? { exactName: true } : {}),
      });
      // The update is rejected if the thread moved to another worktree during
      // generation. Any failed update puts the old name back, so the thread
      // never points at a branch that no longer exists.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:branch-rename`),
          threadId: input.threadId,
          branch: renamed.branch,
          worktreePath: cwd,
          expectedWorktreePath: cwd,
        })
        .pipe(
          Effect.tapError(() =>
            git
              .renameBranch({
                cwd,
                oldBranch: renamed.branch,
                newBranch: oldBranch,
                exactName: true,
              })
              .pipe(Effect.ignore),
          ),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread worktree branch rename failed", {
          commandId: input.commandId,
          threadId: input.threadId,
          oldBranch,
          cause,
        }),
      ),
    );
  });

  return TemporaryBranchRename.of({ rename });
});

export const layer = Layer.effect(TemporaryBranchRename, make);
