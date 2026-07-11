import {
  NonNegativeInt,
  TextGenerationError,
  type ChatAttachment,
  type KiloSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  KiloRuntime,
  kiloRuntimeErrorDetail,
  parseKiloModelSlug,
  runKiloSdk,
  toKiloFileParts,
} from "../provider/kiloRuntime.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import * as TextGeneration from "./TextGeneration.ts";

const FIXED_AGENT = "code";
const kiloTextGenerationErrorContext = {
  operation: Schema.String,
  cwd: Schema.String,
};

export class KiloTextGenerationSessionPayloadError extends Schema.TaggedErrorClass<KiloTextGenerationSessionPayloadError>()(
  "KiloTextGenerationSessionPayloadError",
  kiloTextGenerationErrorContext,
) {
  override get message(): string {
    return `Kilo session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

export class KiloTextGenerationEmptyOutputError extends Schema.TaggedErrorClass<KiloTextGenerationEmptyOutputError>()(
  "KiloTextGenerationEmptyOutputError",
  {
    ...kiloTextGenerationErrorContext,
    sessionId: Schema.String,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Kilo returned empty output for ${this.operation} in ${this.cwd} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

function textFromParts(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
}
export function sanitizeKiloBranchName(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, "").trim();
}

const CommitOutput = Schema.Struct({ subject: Schema.String, body: Schema.String });
const PrOutput = Schema.Struct({ title: Schema.String, body: Schema.String });
const decodeCommitOutput = Schema.decodeEffect(Schema.fromJsonString(CommitOutput));
const decodePrOutput = Schema.decodeEffect(Schema.fromJsonString(PrOutput));

export const makeKiloTextGeneration = Effect.fn("makeKiloTextGeneration")(function* (
  settings: KiloSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const runtime = yield* KiloRuntime;
  const config = yield* ServerConfig.ServerConfig;

  const run = Effect.fn("runKiloTextGeneration")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const model = parseKiloModelSlug(input.modelSelection.model);
    if (!model) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Kilo model selection must use the 'provider/model' format.",
      });
    }
    const result = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* runtime.startServer({
            binaryPath: settings.binaryPath,
            ...(environment ? { environment } : {}),
          });
          const client = runtime.createClient({ baseUrl: server.url, directory: input.cwd });
          const session = yield* runKiloSdk("session.create", () =>
            client.session.create(
              {
                title: `T3 Code ${input.operation}`,
                agent: FIXED_AGENT,
                model: { id: model.modelID, providerID: model.providerID },
                permission: [{ permission: "*", pattern: "*", action: "deny" }],
                platform: "t3code",
              },
              { throwOnError: true },
            ),
          );
          if (!session.data) {
            return yield* new KiloTextGenerationSessionPayloadError({
              operation: input.operation,
              cwd: input.cwd,
            });
          }
          const files = toKiloFileParts({
            attachments: input.attachments,
            resolveAttachmentPath: (attachment) =>
              resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
          });
          const response = yield* runKiloSdk("session.prompt", () =>
            client.session.prompt(
              {
                sessionID: session.data.id,
                model,
                agent: FIXED_AGENT,
                parts: [{ type: "text", text: input.prompt }, ...files],
              },
              { throwOnError: true },
            ),
          );
          const responseParts = response.data?.parts ?? [];
          const text = textFromParts(responseParts);
          if (!text) {
            return yield* new KiloTextGenerationEmptyOutputError({
              operation: input.operation,
              cwd: input.cwd,
              sessionId: session.data.id,
              responsePartCount: responseParts.length,
              textPartCount: responseParts.filter((part) => part.type === "text").length,
            });
          }
          return text;
        }),
      ),
    );
    if (Exit.isFailure(result)) {
      const cause = Cause.squash(result.cause);
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: kiloRuntimeErrorDetail(cause),
        cause,
      });
    }
    return result.value;
  });

  return TextGeneration.TextGeneration.of({
    generateCommitMessage: (input) =>
      run({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: `Return JSON with subject and body for this staged change.\nBranch: ${input.branch ?? "unknown"}\nSummary:\n${input.stagedSummary}\nPatch:\n${input.stagedPatch}`,
      }).pipe(
        Effect.flatMap((text) =>
          decodeCommitOutput(text).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "Kilo returned invalid commit JSON.",
                  cause,
                }),
            ),
          ),
        ),
      ),
    generatePrContent: (input) =>
      run({
        operation: "generatePrContent",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        prompt: `Return JSON with title and body for a pull request.\nBase: ${input.baseBranch}\nHead: ${input.headBranch}\nCommits:\n${input.commitSummary}\nDiff:\n${input.diffSummary}\nPatch:\n${input.diffPatch}`,
      }).pipe(
        Effect.flatMap((text) =>
          decodePrOutput(text).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generatePrContent",
                  detail: "Kilo returned invalid pull request JSON.",
                  cause,
                }),
            ),
          ),
        ),
      ),
    generateBranchName: (input) =>
      run({
        operation: "generateBranchName",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        prompt: `Return only a concise lowercase kebab-case git branch name for: ${input.message}`,
      }).pipe(Effect.map((branch) => ({ branch: sanitizeKiloBranchName(branch) }))),
    generateThreadTitle: (input) =>
      run({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        prompt: `Return only a concise thread title for: ${input.message}`,
      }).pipe(Effect.map((title) => ({ title: sanitizeThreadTitle(title) }))),
  });
});
