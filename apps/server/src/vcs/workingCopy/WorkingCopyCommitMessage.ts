/**
 * fork: f4 AI commit message — the ✨ button's server half.
 *
 * **Why this is not `GitManager.resolveCommitAndBranchSuggestion`.** That path
 * starts at `GitVcsDriver.prepareCommitContext`, which runs `git reset` and
 * then `add -A` before reading the staged diff. The panel exists to let a user
 * hand-build the index; describing a diff produced by destroying that index is
 * worse than useless. So the context is read here, from the index as it stands,
 * through the same `WorkingCopyGit` runner every other panel operation uses.
 *
 * Everything *downstream* of the context is reused verbatim: the same
 * `TextGeneration.generateCommitMessage`, the same `TextGenerationPresets`
 * policies, the same `sourceControlWritingStyle` settings, the same
 * `sanitizeCommitSubject`. There is no second prompt in this fork.
 */
import * as Effect from "effect/Effect";

import {
  TextGenerationError,
  type ModelSelection,
  type SourceControlWritingStyleSettings,
  type WorkingCopyError,
  type WorkingCopyGeneratedCommitMessage,
} from "@t3tools/contracts";

import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../../textGeneration/TextGenerationPresets.ts";
import type { TextGenerationPolicy } from "../../textGeneration/TextGenerationPolicy.ts";
import { limitSection, sanitizeCommitSubject } from "../../textGeneration/TextGenerationUtils.ts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

export const OPERATION = "workingCopy.generateCommitMessage";

/** Matches `GitManager`'s budgets exactly, so the prompt is the same size. */
export const STAGED_SUMMARY_MAX_CHARS = 8_000;
export const STAGED_PATCH_MAX_CHARS = 50_000;
/** The patch is capped at the process level too; 1 MiB is far past the prompt budget. */
export const STAGED_PATCH_MAX_OUTPUT_BYTES = 1024 * 1024;
export const RECENT_SUBJECT_LIMIT = 20;

export interface CommitMessageContext {
  readonly branch: string | null;
  readonly stagedSummary: string;
  readonly stagedPatch: string;
  /** Only populated for the `repo_conventions` writing style. */
  readonly recentSubjects: ReadonlyArray<string>;
}

/**
 * Recent subjects are the `repo_conventions` style's examples. Best-effort: a
 * repository with no history still generates, it just has nothing to imitate.
 */
export const readRecentCommitSubjects = Effect.fn("workingCopy.readRecentCommitSubjects")(
  function* (git: WorkingCopyGit): Effect.fn.Return<ReadonlyArray<string>, never> {
    const output = yield* git
      .run({ operation: OPERATION, args: commands.recentCommitSubjectsArgs(RECENT_SUBJECT_LIMIT) })
      .pipe(Effect.orElseSucceed(() => null));
    if (output === null || output.exitCode !== 0) {
      return [];
    }
    return output.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  },
);

/**
 * The amend base: `HEAD~1`, or the empty tree when HEAD is a root commit.
 * `undefined` for a normal commit, where `diff --cached` already means
 * "index against HEAD".
 */
const resolveAmendBase = Effect.fn("workingCopy.resolveAmendBase")(function* (
  git: WorkingCopyGit,
): Effect.fn.Return<string | undefined, WorkingCopyError> {
  const parent = yield* git.run({ operation: OPERATION, args: commands.headParentArgs() });
  const hash = parent.stdout.trim();
  return parent.exitCode === 0 && hash.length > 0 ? hash : commands.EMPTY_TREE_OBJECT;
});

const readBranch = Effect.fn("workingCopy.readGenerationBranch")(function* (
  git: WorkingCopyGit,
): Effect.fn.Return<string | null, WorkingCopyError> {
  const output = yield* git.run({ operation: OPERATION, args: commands.currentBranchArgs() });
  const branch = output.stdout.trim();
  return output.exitCode === 0 && branch.length > 0 ? branch : null;
});

/**
 * Reads everything the prompt needs, and **nothing else** — no `add`, no
 * `reset`, no stash. Answers `null` when the staged summary is empty, which is
 * what the caller turns into `WorkingCopyNothingStagedError`.
 */
export const readCommitMessageContext = Effect.fn("workingCopy.readCommitMessageContext")(
  function* (
    git: WorkingCopyGit,
    options: { readonly amend: boolean; readonly wantsRecentSubjects: boolean },
  ): Effect.fn.Return<CommitMessageContext | null, WorkingCopyError> {
    const base = options.amend ? yield* resolveAmendBase(git) : undefined;

    const summary = yield* git.ok({
      operation: OPERATION,
      args: commands.stagedSummaryArgs(base),
    });
    const stagedSummary = summary.stdout.trim();
    if (stagedSummary.length === 0) {
      return null;
    }

    const patch = yield* git.ok({
      operation: OPERATION,
      args: commands.stagedPatchArgs(base),
      maxOutputBytes: STAGED_PATCH_MAX_OUTPUT_BYTES,
    });

    return {
      branch: yield* readBranch(git),
      stagedSummary,
      stagedPatch: patch.stdout,
      recentSubjects: options.wantsRecentSubjects ? yield* readRecentCommitSubjects(git) : [],
    };
  },
);

/**
 * The writing style → policy mapping, pure so the branch table can be tested
 * without a repository. Identical in behaviour to `GitManager.resolveStylePolicy`;
 * only the source of the examples differs (this one is handed them).
 */
export function resolveCommitStylePolicy(
  style: SourceControlWritingStyleSettings,
  recentSubjects: ReadonlyArray<string>,
): TextGenerationPolicy {
  switch (style.mode) {
    case "conventional_commits":
      return conventionalCommitsTextGenerationPolicy;
    case "custom":
      return customTextGenerationPolicy(
        style.customInstructions
          ? {
              commitInstructions: style.customInstructions,
              changeRequestInstructions: style.customInstructions,
            }
          : {},
      );
    case "repo_conventions": {
      if (recentSubjects.length === 0) {
        return repositoryConventionsTextGenerationPolicy;
      }
      const examples = ["Recent commit subjects from this repository:", ...recentSubjects].join(
        "\n",
      );
      return {
        ...repositoryConventionsTextGenerationPolicy,
        commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
        changeRequestInstructions: `${repositoryConventionsTextGenerationPolicy.changeRequestInstructions}\n\n${examples}`,
      };
    }
  }
}

/** `repo_conventions` is the only style that needs history read for it. */
export function styleNeedsRecentSubjects(style: SourceControlWritingStyleSettings): boolean {
  return style.mode === "repo_conventions";
}

/** `subject`, or `subject` + blank line + `body`. */
export function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody.length === 0 ? subject : `${subject}\n\n${trimmedBody}`;
}

/** The same normalisation `GitManager` applies before a message reaches git. */
export function toGeneratedCommitMessage(generated: {
  readonly subject: string;
  readonly body: string;
}): WorkingCopyGeneratedCommitMessage {
  const subject = sanitizeCommitSubject(generated.subject);
  const body = generated.body.trim();
  return { subject, body, message: formatCommitMessage(subject, body) };
}

export interface CommitMessageGenerationRequest {
  readonly cwd: string;
  readonly context: CommitMessageContext;
  readonly style: SourceControlWritingStyleSettings;
  readonly modelSelection: ModelSelection;
}

export interface CommitMessageGenerator {
  readonly generateCommitMessage: (input: {
    readonly cwd: string;
    readonly branch: string | null;
    readonly stagedSummary: string;
    readonly stagedPatch: string;
    readonly policy?: TextGenerationPolicy | undefined;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<{ readonly subject: string; readonly body: string }, TextGenerationError>;
}

/**
 * The model call. Kept out of the repository semaphore by its caller: a
 * generation can take tens of seconds and must not block staging or committing
 * in the same repository while it runs.
 */
export const generateCommitMessage = Effect.fn("workingCopy.generateCommitMessage")(function* (
  textGeneration: CommitMessageGenerator,
  request: CommitMessageGenerationRequest,
): Effect.fn.Return<WorkingCopyGeneratedCommitMessage, TextGenerationError> {
  const policy = resolveCommitStylePolicy(request.style, request.context.recentSubjects);
  const generated = yield* textGeneration.generateCommitMessage({
    cwd: request.cwd,
    branch: request.context.branch,
    stagedSummary: limitSection(request.context.stagedSummary, STAGED_SUMMARY_MAX_CHARS),
    stagedPatch: limitSection(request.context.stagedPatch, STAGED_PATCH_MAX_CHARS),
    policy,
    modelSelection: request.modelSelection,
  });
  return toGeneratedCommitMessage(generated);
});

/** Settings failures are the user's problem to fix, so they arrive typed too. */
export function settingsFailure(cause: unknown): TextGenerationError {
  return new TextGenerationError({
    operation: OPERATION,
    detail: "Could not read the text generation settings.",
    cause,
  });
}
