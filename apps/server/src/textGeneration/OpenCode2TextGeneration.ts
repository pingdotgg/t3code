import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  TextGenerationError,
  type ModelSelection,
  type OpenCode2Settings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCode2Runtime from "../provider/opencode2Runtime.ts";

const OpenCode2TextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
]);

type OpenCode2TextGenerationOperation = typeof OpenCode2TextGenerationOperation.Type;

/**
 * v2's `generate.text` runs on the connected server with no session and no
 * tool access (the endpoint is generation-only), so unlike the v1 helper
 * there is no spawned server to own and no permission ruleset to inject —
 * the deny-by-default guarantee comes from the endpoint itself.
 */
export const makeOpenCode2TextGeneration = (openCode2Settings: OpenCode2Settings) =>
  Effect.gen(function* () {
    const openCode2Runtime = yield* OpenCode2Runtime.OpenCode2Runtime;

    const generate = <A>(input: {
      readonly operation: OpenCode2TextGenerationOperation;
      readonly prompt: string;
      readonly outputSchema: Schema.Codec<A, unknown, never, never>;
      readonly modelSelection: ModelSelection;
    }) =>
      Effect.gen(function* () {
        const parsedModel = OpenCode2Runtime.withOpenCode2Variant(
          OpenCode2Runtime.parseOpenCode2ModelSlug(input.modelSelection.model),
          getModelSelectionStringOptionValue(input.modelSelection, "variant"),
        );
        if (!parsedModel) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode 2 model selection must use the 'provider/model' format.",
          });
        }

        const connection = yield* openCode2Runtime.connect({
          ...(openCode2Settings.serverUrl ? { serverUrl: openCode2Settings.serverUrl } : {}),
          ...(openCode2Settings.serverPassword
            ? { serverPassword: openCode2Settings.serverPassword }
            : {}),
          binaryPath: openCode2Settings.binaryPath,
        });

        const result = yield* connection.client.generate
          .text({
            prompt: input.prompt,
            model: parsedModel,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OpenCode 2 generate request failed.",
                  cause,
                }),
            ),
          );

        const rawText = result.text.trim();
        if (rawText.length === 0) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode 2 returned empty output.",
          });
        }

        // `extractJsonObject` returns the JSON *text*; decode it through
        // `fromJsonString` so the output schema is applied to the parsed
        // object rather than to a string (mirrors the other providers).
        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
        return yield* decodeOutput(extractJsonObject(rawText)).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "OpenCode 2 returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.catchTags({
          OpenCode2RuntimeError: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause.detail,
              cause,
            }),
        }),
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      (input) =>
        Effect.gen(function* () {
          const { prompt, outputSchema } = buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          });
          const generated = yield* generate({
            operation: "generateCommitMessage",
            prompt,
            outputSchema,
            modelSelection: input.modelSelection,
          });

          return {
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          };
        });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* generate({
          operation: "generatePrContent",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* generate({
          operation: "generateBranchName",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          branch: sanitizeBranchFragment(generated.branch),
        };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
        });
        const generated = yield* generate({
          operation: "generateThreadTitle",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        });

        return {
          title: sanitizeThreadTitle(generated.title),
        };
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"];
  });
