import {
  PRIME_AGENT_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PrimeAgentSettings,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface PrimeAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "cancelBehavior"
  | "clientCapabilities"
  | "onStderr"
  | "transformStdout"
  | "transformSessionUpdate"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly primeAgentSettings: Pick<PrimeAgentSettings, "binaryPath"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export type PrimeAgentAcpRuntimeOptions = Omit<
  PrimeAgentAcpRuntimeInput,
  "spawn" | "childProcessSpawner" | "primeAgentSettings" | "environment"
>;

export function buildPrimeAgentAcpSpawnInput(
  primeAgentSettings: PrimeAgentAcpRuntimeInput["primeAgentSettings"],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: primeAgentSettings?.binaryPath?.trim() || "prime-agent",
    args: ["--mode", "acp"],
    cwd,
    env: { ...environment },
  };
}

export const makePrimeAgentAcpRuntime = Effect.fn("makePrimeAgentAcpRuntime")(function* (
  input: PrimeAgentAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope | Crypto.Crypto
> {
  const {
    childProcessSpawner,
    primeAgentSettings: _settings,
    environment: _env,
    ...options
  } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...options,
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export function primeAgentModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function resolvePrimeAgentModel(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly model: string | null | undefined;
}): string | undefined {
  const modelConfig = input.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  const requested = input.model?.trim();
  return requested && requested !== PRIME_AGENT_DEFAULT_MODEL ? requested : current;
}

export const applyPrimeAgentAcpModelSelection = Effect.fn("applyPrimeAgentAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel"
    >;
    readonly model: string | null | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelConfig = configOptions.find((option) => option.id === "model");
    const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
    const resolved = resolvePrimeAgentModel({ configOptions, model: input.model });
    if (resolved === undefined || resolved === current) return current;
    const options = primeAgentModelOptions(configOptions);
    if (!options.some((option) => option.value === resolved)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Prime Agent model '${resolved}' is not available for this session. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(resolved).pipe(Effect.mapError(input.mapError));
    return resolved;
  },
);

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const buildPrimeAgentPrompt = Effect.fn("buildPrimeAgentPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") || mimeType === "application/json");
    if (!image && !pdf && !textFile) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Prime Agent does not support '${attachment.name}' (${attachment.mimeType}). Attach a PNG, JPEG, WebP, GIF, PDF, or text file.`,
      );
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Invalid attachment '${attachment.name}'.`,
      );
    }
    const info = yield* fileSystem
      .stat(attachmentPath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Could not read attachment '${attachment.name}'.`,
          ),
        ),
      );
    const size = Number(info.size);
    const limit = image ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    totalBytes += size;
    if (info.type !== "File" || size > limit || totalBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' is too large. Prime Agent accepts images up to 10 MiB and ${PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024)} MiB total attachments.`,
      );
    }
    const uri = yield* path.toFileUrl(attachmentPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
      ),
    );
    if (pdf) {
      blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType });
      continue;
    }
    const bytes = yield* fileSystem.stream(attachmentPath, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Could not read attachment '${attachment.name}'.`,
        ),
      ),
    );
    if (bytes.length > limit) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
      continue;
    }
    const decoded = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Attachment '${attachment.name}' is not a UTF-8 text file.`,
        ),
    });
    if (decoded.includes("\0")) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' contains binary data.`,
      );
    }
    blocks.push({ type: "resource", resource: { uri, mimeType, text: decoded } });
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or a supported attachment.",
    );
  }
  return blocks;
});
