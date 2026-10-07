/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts, linked source
 * control context, and output sanitizing live here so providers cannot drift
 * on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildProviderFailureExplanationPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export type Operation = keyof TextGeneration.TextGeneration["Service"];

/** One prompt for a provider to run. */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  /**
   * The project to run in. Null means the prompt needs no project access, so
   * the provider runs in an empty temporary directory (see `resolveWorkingDirectory`).
   */
  readonly cwd: string | null;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/**
 * The directory a provider process runs in: the request's project, or a fresh
 * empty temporary directory removed with the scope when the request has none.
 */
export const resolveWorkingDirectory = (
  fileSystem: FileSystem.FileSystem,
  request: Pick<Request<Schema.Top>, "operation" | "cwd">,
): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
  request.cwd !== null
    ? Effect.succeed(request.cwd)
    : fileSystem.makeTempDirectoryScoped({ prefix: "t3code-text-generation-" }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: request.operation,
              detail: "Failed to create an isolated working directory.",
              cause,
            }),
        ),
      );

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
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

const MAX_EXPLANATION_SUMMARY_CHARS = 600;
const MAX_EXPLANATION_FIX_CHARS = 900;

/** Trims a model reply and caps it so a runaway answer cannot flood the banner. */
function boundExplanationText(raw: string, maxChars: number): string {
  const text = raw.trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(name: string, run: Runner): TextGeneration.TextGeneration["Service"] {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn(`${name}.generateCommitMessage`)(function* (input) {
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

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn(`${name}.generatePrContent`)(function* (input) {
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
        }),
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn(`${name}.generateBranchName`)(function* (input) {
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

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn(`${name}.generateThreadTitle`)(function* (input) {
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
        }),
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  const explainProviderFailure: TextGeneration.TextGeneration["Service"]["explainProviderFailure"] =
    Effect.fn(`${name}.explainProviderFailure`)(function* (input) {
      const generated = yield* run({
        operation: "explainProviderFailure",
        cwd: null,
        modelSelection: input.modelSelection,
        ...buildProviderFailureExplanationPrompt({
          context: input.context,
          knownIssues: input.knownIssues,
        }),
      });
      const named =
        "matchingIssueNumber" in generated && typeof generated.matchingIssueNumber === "number"
          ? generated.matchingIssueNumber
          : null;
      return {
        summary: boundExplanationText(generated.summary, MAX_EXPLANATION_SUMMARY_CHARS),
        likelyFix: boundExplanationText(generated.likelyFix, MAX_EXPLANATION_FIX_CHARS),
        // A number the model was not shown is invented, so it is no match.
        matchingIssueNumber:
          named !== null && (input.knownIssues ?? []).some((issue) => issue.number === named)
            ? named
            : null,
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    explainProviderFailure,
  } satisfies TextGeneration.TextGeneration["Service"];
}
