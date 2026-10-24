import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type {
  CommitDescriptionsGenerationInput,
  CommitDescriptionsGenerationResult,
  ProviderTextGeneration,
} from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildCommitDescriptionsPrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitDescription,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /**
   * Set when the model must investigate `cwd` before answering: it may read files and run
   * read-only commands there, over as many turns as it needs, and must change nothing. A
   * runner that cannot guarantee read-only tools fails rather than answering blind.
   */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateCommitDescriptions: ProviderTextGeneration["generateCommitDescriptions"] =
    Effect.fn(`${name}.generateCommitDescriptions`)(function* (input) {
      yield* validateCommitDescriptionsInput(input.commits);
      const generated = yield* run({
        operation: "generateCommitDescriptions",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildCommitDescriptionsPrompt(input.commits),
      });
      return yield* validateCommitDescriptionsResult(input.commits, generated);
    });

  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
        threadContext: input.threadContext,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  return {
    generateCommitDescriptions,
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
  } satisfies ProviderTextGeneration;
}

export function validateCommitDescriptionsInput(
  commits: CommitDescriptionsGenerationInput["commits"],
): Effect.Effect<void, TextGenerationError> {
  if (commits.length < 1 || commits.length > 10) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateCommitDescriptions",
        detail: "Expected 1 to 10 commits.",
      }),
    );
  }
  if (
    commits.some((commit) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit.sha)) ||
    new Set(commits.map((commit) => commit.sha)).size !== commits.length
  ) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateCommitDescriptions",
        detail: "Commit SHAs must be valid and unique.",
      }),
    );
  }
  return Effect.void;
}

export function validateCommitDescriptionsResult(
  commits: CommitDescriptionsGenerationInput["commits"],
  generated: CommitDescriptionsGenerationResult,
): Effect.Effect<CommitDescriptionsGenerationResult, TextGenerationError> {
  const bySha = new Map(generated.descriptions.map((item) => [item.sha, item.description]));
  if (
    generated.descriptions.length !== commits.length ||
    bySha.size !== commits.length ||
    commits.some((commit) => !bySha.has(commit.sha))
  ) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateCommitDescriptions",
        detail: "Generated descriptions must match the requested commit SHAs exactly.",
      }),
    );
  }
  const descriptions = commits.map((commit) => ({
    sha: commit.sha,
    description: sanitizeCommitDescription(bySha.get(commit.sha)!),
  }));
  if (descriptions.some((item) => item.description.length === 0)) {
    return Effect.fail(
      new TextGenerationError({
        operation: "generateCommitDescriptions",
        detail: "Generated descriptions must not be empty.",
      }),
    );
  }
  return Effect.succeed({ descriptions });
}
