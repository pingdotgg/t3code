import { TextGenerationError, type ModelSelection, type PiAgentSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  spawnPiRpcClient,
  type PiRpcClient,
  type PiRpcClientError,
} from "../provider/pi/PiRpcClient.ts";
import type { PiRpcResponse } from "../provider/pi/PiRpcProtocol.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;
const TEXT_GENERATION_ARGS = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
] as const;
const isTextGenerationError = Schema.is(TextGenerationError);

interface PiTextClientFactoryInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args: ReadonlyArray<string>;
}

type PiTextClientFactory = (
  input: PiTextClientFactoryInput,
) => Effect.Effect<
  PiRpcClient,
  PiRpcClientError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
>;

export interface PiTextGenerationOptions {
  readonly createClient?: PiTextClientFactory;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function splitPiModel(value: string): { provider: string; modelId: string } | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function lastAssistantText(response: PiRpcResponse): string | null {
  if (!response.success) return null;
  const data = asRecord(response.data);
  return typeof data?.text === "string" ? data.text : null;
}

const defaultCreateClient: PiTextClientFactory = (input) => spawnPiRpcClient(input);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: PiTextGenerationOptions = {},
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const createClient = options.createClient ?? defaultCreateClient;
  const processEnvironment = {
    ...environment,
    ...(settings.homePath ? { PI_CODING_AGENT_DIR: settings.homePath } : {}),
  };

  const runPiJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const model = splitPiModel(input.modelSelection.model);
      if (!model) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `Pi model '${input.modelSelection.model}' must use provider/model format.`,
        });
      }
      const client = yield* createClient({
        binaryPath: settings.binaryPath || "pi",
        cwd: input.cwd,
        env: processEnvironment,
        args: TEXT_GENERATION_ARGS,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to start Pi RPC text generation.",
              cause,
            }),
        ),
      );

      yield* client.request({ type: "set_model", ...model }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to set the Pi text generation model.",
              cause,
            }),
        ),
      );
      const effort = getModelSelectionStringOptionValue(input.modelSelection, "effort");
      if (effort) {
        yield* client.request({ type: "set_thinking_level", level: effort }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to set the Pi thinking level.",
                cause,
              }),
          ),
        );
      }

      const agentEnd = yield* client.events.pipe(
        Stream.filter((event) => event.type === "agent_end"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* client.request({ type: "prompt", message: input.prompt }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi rejected the text generation prompt.",
              cause,
            }),
        ),
      );
      const completion = Fiber.join(agentEnd).pipe(
        Effect.raceFirst(
          client.terminated.pipe(
            Effect.flatMap((cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi RPC exited before text generation completed.",
                  cause,
                }),
              ),
            ),
          ),
        ),
        Effect.timeoutOption(PI_TIMEOUT_MS),
      );
      const completed = yield* completion;
      if (Option.isNone(completed) || Option.isNone(completed.value)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: Option.isNone(completed)
            ? "Pi text generation timed out."
            : "Pi text generation ended without an agent completion event.",
        });
      }

      const response = yield* client.request({ type: "get_last_assistant_text" }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to read Pi text generation output.",
              cause,
            }),
        ),
      );
      const output = lastAssistantText(response)?.trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Pi returned empty text generation output.",
        });
      }
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi returned invalid structured text generation output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
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

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
