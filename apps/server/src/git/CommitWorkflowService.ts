import {
  GitManagerError,
  CommandId,
  GitStartCommitWorkflowInput,
  type GitStartCommitWorkflowResult,
  type GitCancelCommitWorkflowInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as GitManager from "./GitManager.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

const isGitManagerError = Schema.is(GitManagerError);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(GitStartCommitWorkflowInput));
interface Job {
  readonly fingerprint: string;
  readonly cwd: string;
  readonly done: Deferred.Deferred<GitStartCommitWorkflowResult, GitManagerError>;
  readonly cancel: Deferred.Deferred<void>;
  settled: boolean;
}

export class CommitWorkflowService extends Context.Service<
  CommitWorkflowService,
  {
    readonly start: (
      input: GitStartCommitWorkflowInput,
    ) => Effect.Effect<GitStartCommitWorkflowResult, GitManagerError>;
    readonly cancel: (input: GitCancelCommitWorkflowInput) => Effect.Effect<boolean>;
  }
>()("t3/git/CommitWorkflowService") {}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const gitManager = yield* GitManager.GitManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const jobs = new Map<string, Job>();
  const runningCheckouts = new Set<string>();

  const execute = Effect.fn("CommitWorkflowService.execute")(function* (
    input: GitStartCommitWorkflowInput,
  ) {
    const fail = (detail: string) =>
      new GitManagerError({ operation: "splitCommits", cwd: input.cwd, detail });
    return yield* Effect.gen(function* () {
      const thread = yield* threads.getThreadShell(input.threadId);
      if (thread === null) return yield* fail("The thread is unavailable.");
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return yield* fail("The thread's project is unavailable.");
      const cwd = yield* fs.realPath(thread.worktreePath ?? project.value.workspaceRoot);
      if ((yield* fs.realPath(input.cwd)) !== cwd)
        return yield* fail(
          "The thread's checkout changed. Reopen the commit dialog and try again.",
        );
      if (runningCheckouts.has(cwd))
        return yield* fail("Commit splitting is already running for this checkout.");
      runningCheckouts.add(cwd);
      return yield* withWorkspaceLease(
        cwd,
        Effect.gen(function* () {
          const status = yield* git.status({ cwd });
          if (!status.isRepo || (input.scope.type === "branch" && status.refName === null))
            return yield* fail("Switch to a Git branch before rebuilding commits.");
          if (status.refName !== input.expectedBranch)
            return yield* fail("The branch changed. Reopen the commit dialog and try again.");
          if (input.scope.type === "branch" && status.hasWorkingTreeChanges)
            return yield* fail(
              "Commit or set aside uncommitted changes before rebuilding branch history.",
            );
          if (input.scope.type === "branch" && status.isDefaultRef)
            return yield* fail("Switch to a feature branch before rebuilding branch history.");
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            thread.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providers.getProviders,
                  thread.projectId,
                );
          let request = input;
          if (input.scope.type === "working_tree_new_branch") {
            if (!status.hasWorkingTreeChanges)
              return yield* fail("There are no uncommitted changes to split on a new branch.");
            const branch = yield* gitManager.createFeatureBranch({
              cwd,
              expectedBranch: input.expectedBranch,
              ...(input.scope.filePaths ? { filePaths: input.scope.filePaths } : {}),
              settings: { modelSelection, style: settings.sourceControlWritingStyle },
            });
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`${input.commandId}:feature-branch`),
              threadId: input.threadId,
              branch,
              expectedBranch: thread.branch,
              expectedWorktreePath: thread.worktreePath,
            });
            request = {
              ...input,
              expectedBranch: branch,
              scope: { ...input.scope, type: "working_tree" },
            };
          }
          return yield* gitManager.runCommitWorkflow({
            request,
            modelSelection,
            style: settings.sourceControlWritingStyle,
          });
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => runningCheckouts.delete(cwd))));
    }).pipe(
      Effect.mapError((cause) =>
        isGitManagerError(cause)
          ? cause
          : new GitManagerError({
              operation: "splitCommits",
              cwd: input.cwd,
              detail: "Could not complete commit splitting.",
              cause,
            }),
      ),
    );
  });

  const start = Effect.fn("CommitWorkflowService.start")((input: GitStartCommitWorkflowInput) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fingerprint = encodeRequest(input);
        const existing = jobs.get(input.commandId);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            return yield* new GitManagerError({
              operation: "splitCommits",
              cwd: input.cwd,
              detail: "This action ID was already used for different changes.",
            });
          return yield* restore(Deferred.await(existing.done));
        }
        const job: Job = {
          fingerprint,
          cwd: input.cwd,
          done: yield* Deferred.make<GitStartCommitWorkflowResult, GitManagerError>(),
          cancel: yield* Deferred.make<void>(),
          settled: false,
        };
        jobs.set(input.commandId, job);
        const result = yield* restore(
          execute(input).pipe(
            Effect.raceFirst(
              Deferred.await(job.cancel).pipe(
                Effect.andThen(
                  new GitManagerError({
                    operation: "splitCommits",
                    cwd: input.cwd,
                    detail:
                      "Commit splitting was cancelled. Any recovery refs created by T3 are retained.",
                  }),
                ),
              ),
            ),
          ),
        ).pipe(Effect.exit);
        job.settled = true;
        yield* Deferred.done(job.done, result);
        if (Exit.isFailure(result)) jobs.delete(input.commandId);
        // Retain a bounded set of successful results so a transport retry cannot
        // rewrite the same history twice. In-flight actions are never evicted.
        for (const [id, previous] of jobs) {
          if (jobs.size <= 50) break;
          if (previous.settled) jobs.delete(id);
        }
        return yield* result;
      }),
    ),
  );
  const cancel = Effect.fn("CommitWorkflowService.cancel")(function* (
    input: GitCancelCommitWorkflowInput,
  ) {
    const job = jobs.get(input.commandId);
    if (!job || job.settled || job.cwd !== input.cwd) return false;
    return yield* Deferred.succeed(job.cancel, undefined);
  });
  return CommitWorkflowService.of({ start, cancel });
});

export const layer = Layer.effect(CommitWorkflowService, make);
