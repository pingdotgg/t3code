/**
 * OpenClawTextGeneration — text generation via the gateway's OpenAI-compatible
 * HTTP API.
 *
 * OpenClaw exposes `POST /v1/chat/completions` on the same port as the
 * WebSocket control plane (https://docs.openclaw.ai/gateway#openai-compatible-endpoints).
 * This service drives the shared gateway holder (see
 * {@link OpenClawGatewayHolder}) so a spawned gateway is started exactly once
 * per instance, then posts one-shot prompts and extracts the JSON payload the
 * same way the Pi/Grok text generation services do.
 *
 * Assumptions (documented because the HTTP auth header contract is not pinned
 * in the public docs):
 *
 * - The endpoints use the same shared-secret auth boundary as the rest of the
 *   gateway HTTP API. With `gateway.auth.mode: "token"` we send
 *   `Authorization: Bearer <token>`; a spawned gateway always has a generated
 *   token, an external gateway uses the configured `gatewayToken`.
 * - The standard `model` field selects the default agent; a `provider/model`
 *   slug is forwarded via the documented `x-openclaw-model` override header.
 *
 * @module textGeneration/OpenClawTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  TextGenerationError,
  type ModelSelection,
  type OpenClawSettings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
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
import { type OpenClawGatewayHolder } from "../provider/Layers/OpenClawAdapter.ts";

const OPENCLAW_TEXT_GENERATION_TIMEOUT_MS = 180_000;

export interface OpenClawTextGenerationLiveOptions {
  /** Shared gateway connection holder, owned by the driver. */
  readonly gateway: OpenClawGatewayHolder;
  readonly environment?: NodeJS.ProcessEnv;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function httpUrlFromGatewayUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice("wss://".length)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice("ws://".length)}`;
  }
  return wsUrl;
}

function extractChatCompletionText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  const message = choices[0] && isRecord(choices[0]) ? choices[0].message : undefined;
  if (isRecord(message)) {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
  }
  return "";
}

export const makeOpenClawTextGeneration = Effect.fn("makeOpenClawTextGeneration")(function* (
  openClawSettings: OpenClawSettings,
  options: OpenClawTextGenerationLiveOptions,
) {
  const httpClient = yield* HttpClient.HttpClient;

  const runOpenClawJson = Effect.fn("runOpenClawJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const connection = yield* options.gateway
      .acquire({
        binaryPath: openClawSettings.binaryPath,
        ...(openClawSettings.gatewayUrl?.trim() ? { gatewayUrl: openClawSettings.gatewayUrl } : {}),
        ...(openClawSettings.gatewayToken?.trim()
          ? { gatewayToken: openClawSettings.gatewayToken }
          : {}),
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: cause.detail,
              cause,
            }),
        ),
      );

    const baseUrl = httpUrlFromGatewayUrl(connection.url);
    const modelSlug = input.modelSelection.model;
    const body = {
      model: "openclaw",
      messages: [{ role: "user", content: input.prompt }],
    };
    let request = HttpClientRequest.post(`${baseUrl}/v1/chat/completions`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        ...(modelSlug.includes("/") ? { "x-openclaw-model": modelSlug } : {}),
      }),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    if (connection.gatewayToken) {
      request = request.pipe(HttpClientRequest.bearerToken(connection.gatewayToken));
    }

    const timedOut = yield* httpClient.execute(request).pipe(
      Effect.timeoutOption(OPENCLAW_TEXT_GENERATION_TIMEOUT_MS),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `OpenClaw gateway chat completion request failed: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    if (timedOut._tag === "None") {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenClaw gateway chat completion request timed out.",
      });
    }
    const response = timedOut.value;

    const bodyResult = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenClaw gateway returned an invalid chat completion payload.",
            cause,
          }),
      ),
    );
    const rawText = extractChatCompletionText(bodyResult).trim();
    if (rawText.length === 0) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenClaw returned empty output.",
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawText)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenClaw returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenClawTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenClawJson({
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
    Effect.fn("OpenClawTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenClawJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OpenClawTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenClawJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenClawTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runOpenClawJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
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
