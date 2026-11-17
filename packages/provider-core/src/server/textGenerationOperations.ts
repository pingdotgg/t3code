import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ChatAttachment,
  type ModelSelection,
  TextGenerationError,
  TextGenerationOperation,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type { ProviderTextGeneration, ProviderTextGenerationRuntime } from "./textGeneration.ts";
import { buildModelEvaluationPrompt, validateModelEvaluationVerdict } from "./modelEvaluation.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildConversationSummaryPrompt,
  buildFactStandingCheckPrompt,
  buildKnowledgeCandidatesPrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export const TranscriptionPostProcessingOutput = Schema.Struct({ transcription: Schema.String });

export type Operation = TextGenerationOperation;

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Investigate cwd with read-only tools across turns; fail if the runner cannot guarantee read-only access. */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  const decodeOutput = Schema.decodeEffect(
    Schema.fromJsonString(request.outputSchema),
    request.operation === "generateModelEvaluation" ? { onExcessProperty: "error" } : undefined,
  );
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          kind: "invalid-output",
          cause,
        }),
    ),
  );
};

const generatedThreadTitle = (raw: string) => {
  const title = sanitizeThreadTitle(raw);
  // Some models echo the output schema's key instead of a title.
  return title.toLowerCase() === "title"
    ? Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: 'The model returned the placeholder title "title".',
        }),
      )
    : Effect.succeed(title);
};

export function fromRunner(
  name: string,
  run: Runner,
  options: {
    readonly supportsInvestigation: boolean;
    readonly supportsBlindEvaluation?: boolean;
  } = { supportsInvestigation: false },
): ProviderTextGenerationRuntime {
  const generateModelEvaluation: ProviderTextGeneration["generateModelEvaluation"] = Effect.fn(
    `${name}.generateModelEvaluation`,
  )(function* (input) {
    if (options.supportsBlindEvaluation !== true) {
      return yield* new TextGenerationError({
        operation: "generateModelEvaluation",
        detail:
          "This provider cannot isolate a blind evaluator from tools and workspace instructions. Choose a supported evaluator.",
      });
    }
    const verdict = yield* run({
      operation: "generateModelEvaluation",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildModelEvaluationPrompt(input.packet),
    });
    if (!validateModelEvaluationVerdict(verdict, input.packet)) {
      return yield* new TextGenerationError({
        operation: "generateModelEvaluation",
        detail: "The evaluator returned unsupported citations or an inconsistent verdict.",
      });
    }
    return verdict;
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
        projectTitle: input.projectTitle,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: yield* generatedThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateTranscriptionPostProcessing: ProviderTextGeneration["generateTranscriptionPostProcessing"] =
    Effect.fn(`${name}.generateTranscriptionPostProcessing`)(function* (input) {
      return yield* run({
        operation: "generateTranscriptionPostProcessing",
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: TranscriptionPostProcessingOutput,
        modelSelection: input.modelSelection,
      });
    });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    if (!options.supportsInvestigation) {
      return yield* investigationUnsupported("generateReviewGuide", name);
    }
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  const generateKnowledgeCandidates: ProviderTextGeneration["generateKnowledgeCandidates"] =
    Effect.fn(`${name}.generateKnowledgeCandidates`)(function* (input) {
      return yield* run({
        operation: "generateKnowledgeCandidates",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildKnowledgeCandidatesPrompt(input),
      });
    });

  // Fails closed: an omitted, repeated or out-of-range ref, or a standing statement that does not
  // name what it refers to, is stored as set aside. A reply off the schema fails the call instead.
  const checkFactStanding: ProviderTextGeneration["checkFactStanding"] = Effect.fn(
    `${name}.checkFactStanding`,
  )(function* (input) {
    if (input.statements.length === 0) return { verdicts: [] };
    const { results } = yield* run({
      operation: "checkFactStanding",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildFactStandingCheckPrompt(input.statements),
    });
    const answers = new Map<number, (typeof results)[number] | null>();
    for (const result of results) answers.set(result.ref, answers.has(result.ref) ? null : result);
    return {
      verdicts: input.statements.map((_, index) => {
        const answer = answers.get(index + 1);
        if (!answer) return "task" as const;
        return answer.verdict === "standing" && !answer.selfContained ? "task" : answer.verdict;
      }),
    };
  });

  const generateConversationSummary: ProviderTextGeneration["generateConversationSummary"] =
    Effect.fn(`${name}.generateConversationSummary`)(function* (input) {
      return yield* run({
        operation: "generateConversationSummary",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildConversationSummaryPrompt(input),
      });
    });

  return {
    supportedOperations: TextGenerationOperation.literals.filter(
      (operation) =>
        (operation !== "generateReviewGuide" || options.supportsInvestigation) &&
        // The standing check must not see tools or workspace instructions either.
        ((operation !== "generateModelEvaluation" && operation !== "checkFactStanding") ||
          options.supportsBlindEvaluation === true),
    ),
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateKnowledgeCandidates,
    generateConversationSummary,
    generateModelEvaluation,
    generateTranscriptionPostProcessing,
    checkFactStanding,
  } satisfies ProviderTextGenerationRuntime;
}
