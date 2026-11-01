import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravityAuthMethod,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  makeAntigravityStderrHandler,
  makeAntigravityStdoutTransform,
} from "../antigravityAuthSupport.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { normalizeAntigravitySessionUpdate } from "./AntigravityProtocol.ts";

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateEagerly"
  | "cancelBehavior"
  | "clientCapabilities"
  | "clientInfo"
  | "onStderr"
  | "resumeMethod"
  | "sessionMeta"
  | "transformSessionUpdate"
  | "transformStdout"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Serve `fs/read_text_file` for runtimes whose native reader is not qualified. */
  readonly clientFileReads?: boolean;
  /** The installed version, known before `initialize`; it picks the file reader. */
  readonly runtimeVersion?: string | null;
  /** Conversational sessions only; helpers and probes leave the system prompt untouched. */
  readonly sessionSystemPromptAppend?: string;
  readonly authMethod?: AntigravityAuthMethod;
}

function parseAntigravityVersion(version: string | null | undefined) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: ReadonlyArray<number>, right: ReadonlyArray<number>) {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * 1.4.2 through 1.4.5 create or overwrite skills/system/run-workflow/SKILL.md in the workspace
 * unless `run_workflow` is disabled. Older builds offer the tool and leave the file alone.
 */
function antigravityWritesRunWorkflowSkill(version: string | null | undefined): boolean {
  const parsed = parseAntigravityVersion(version);
  return (
    parsed !== undefined &&
    compareVersions(parsed, [1, 4, 2]) >= 0 &&
    compareVersions(parsed, [1, 4, 5]) <= 0
  );
}

/**
 * Releases T3 qualified for native range reads and linked video. On 1.4.5 the client-read path
 * sends a whole file to serve one line, and the native reader keeps diff edits.
 */
export function isQualifiedAntigravityRelease(version: string | null | undefined): boolean {
  return version?.trim() === "1.4.5";
}

/**
 * 1.4.5 appends `systemPrompt.append` to its system instructions on new, load and resume, and
 * keeps none of it between processes, so every activation sends it again.
 */
export const antigravityAppendsSystemPrompt = (
  initializeResult: EffectAcpSchema.InitializeResponse,
) => isQualifiedAntigravityRelease(initializeResult.agentInfo?.version);

export function antigravitySessionMeta(
  initializeResult: EffectAcpSchema.InitializeResponse,
  systemPromptAppend?: string,
): EffectAcpSchema.NewSessionRequest["_meta"] | undefined {
  const antigravity = {
    ...(antigravityWritesRunWorkflowSkill(initializeResult.agentInfo?.version)
      ? { disabledTools: ["run_workflow"] }
      : {}),
    ...(systemPromptAppend !== undefined && antigravityAppendsSystemPrompt(initializeResult)
      ? { systemPrompt: { append: systemPromptAppend } }
      : {}),
  };
  return Object.keys(antigravity).length === 0 ? undefined : { antigravity };
}

export const makeAntigravityAcpRuntime = Effect.fn("makeAntigravityAcpRuntime")(function* (
  input: AntigravityAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: input.authMethod ?? "oauth-personal",
      authenticateEagerly: true,
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      // The agent offers non-Gemini models only to allowlisted clients such as Zed.
      clientInfo: { name: "zed", version: "0.0.0" },
      sessionMeta: (initializeResult) =>
        antigravitySessionMeta(initializeResult, input.sessionSystemPromptAppend),
      clientCapabilities: {
        // Advertising writes swaps the agent's diff edits for whole-file client_edit_file.
        fs: {
          readTextFile:
            input.clientFileReads === true && !isQualifiedAntigravityRelease(input.runtimeVersion),
          writeTextFile: false,
        },
        terminal: false,
      },
      transformStdout: makeAntigravityStdoutTransform(
        input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {},
      ),
      onStderr: makeAntigravityStderrHandler(
        input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {},
      ),
      transformSessionUpdate: normalizeAntigravitySessionUpdate,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

/**
 * Model-facing, once per migration: earlier native history names uploads at stored paths the
 * agent now refuses, so give their new paths and the rule for any file not listed.
 */
export function antigravityMovedUploadsNotice(
  text: string,
  moved: { readonly root: string; readonly files: ReadonlyArray<string>; readonly more: number },
): string {
  const notice = [
    `[Files attached earlier in this conversation have moved to ${moved.root}. Their old saved paths no longer work.`,
    ...(moved.files.length === 0
      ? []
      : ["Read them at:", ...moved.files.map((file) => `- ${file}`)]),
    "Any other earlier file keeps the file name from its old saved path, in that folder.]",
  ].join("\n");
  return text ? `${text}\n\n${notice}` : notice;
}

export function antigravityPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "auto_edit";
    case "auto":
    case "approval-required":
      return "default";
  }
}

/** The runtime mode an Antigravity session mode grants; the inverse of `antigravityPermissionMode`. */
export function antigravityRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "yolo":
      return "full-access";
    case "auto_edit":
      return "auto-accept-edits";
    case "default":
      return "approval-required";
    default:
      return undefined;
  }
}

export function antigravityModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/** Runtime 1.4 reports thinking as its own option; 1.3 encoded it in the model ID. */
export function antigravityThinkingConfig(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
) {
  const option = configOptions?.find((candidate) => candidate.category === "thought_level");
  return option?.type === "select" ? option : undefined;
}

/**
 * Runtime 1.4 lists `gemini-3.8-flash` where 1.3 listed `gemini-3.8-flash-high`. The agent
 * still accepts the old IDs, so pass them through; the current model may have no thinking option.
 */
function legacyAntigravityFamily(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  model: string,
) {
  return antigravityModelOptions(configOptions)
    .map((option) => option.value)
    .filter((family) => model.startsWith(`${family}-`))
    .toSorted((left, right) => right.length - left.length)[0];
}

function resolveAntigravityModel(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly model: string | null | undefined;
  readonly defaultModel?: string | undefined;
}): string | undefined {
  const modelConfig = input.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) return input.model;
  const options = antigravityModelOptions(input.configOptions);
  return input.defaultModel &&
    (options.some((option) => option.value === input.defaultModel) ||
      legacyAntigravityFamily(input.configOptions, input.defaultModel) !== undefined)
    ? input.defaultModel
    : current;
}

/** Never replace a saved selection with the default returned by a cold resume. */
export const applyAntigravityAcpModelSelection = Effect.fn("applyAntigravityAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setConfigOption"
    >;
    readonly model: string | null | undefined;
    readonly defaultModel?: string | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelConfig = configOptions.find((option) => option.id === "model");
    const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
    const resolved = resolveAntigravityModel({
      configOptions,
      model: input.model,
      defaultModel: input.defaultModel,
    });
    const explicit = Boolean(input.model) && input.model !== ANTIGRAVITY_DEFAULT_MODEL;
    if (resolved === undefined || (!explicit && resolved === current)) return current;
    const options = antigravityModelOptions(configOptions);
    const legacyFamily = options.some((option) => option.value === resolved)
      ? undefined
      : legacyAntigravityFamily(configOptions, resolved);
    if (legacyFamily !== undefined) {
      yield* input.runtime
        .setConfigOption("model", resolved, { allowUnlistedValue: true })
        .pipe(Effect.mapError(input.mapError));
      return legacyFamily;
    }
    if (!options.some((option) => option.value === resolved)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Antigravity model '${resolved}' is unavailable for this Google account. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(resolved).pipe(Effect.mapError(input.mapError));
    return resolved;
  },
);

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);
const ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// The agent inlines linked video bytes into one model request, so keep it under the inline limit.
const ANTIGRAVITY_MAX_VIDEO_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Only Gemini takes video. The evidence is the session's resolved model, so an account default
 * counts once the agent reports it; opaque ids such as `agy-model` need a Gemini display name.
 */
function antigravityModelAcceptsVideo(
  model: { readonly id: string; readonly name: string | undefined } | undefined,
): boolean {
  return model !== undefined && (/^gemini-/i.test(model.id) || /^gemini\b/i.test(model.name ?? ""));
}
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".svelte",
  ".vue",
  ".log",
  ".diff",
  ".patch",
  ".ini",
  ".conf",
]);
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

export const buildAntigravityPrompt = Effect.fn("buildAntigravityPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly resolveAttachmentPath: (
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) => string | null;
  readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
  /** Linked video needs a runtime whose `resource_link` handling is qualified and a Gemini model. */
  readonly agentVersion?: string | undefined;
  readonly currentModel?: { readonly id: string; readonly name: string | undefined } | undefined;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The agent runs on this host.
  const platform = yield* HostProcess.Platform;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    const isPastedText =
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text";
    // The text already carries the path; keep folded pastes lazy so agents can search without embedding the whole file.
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const audio = attachment.type === "file" && AUDIO_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
    const video =
      attachment.type === "file" &&
      mimeType === "video/mp4" &&
      isQualifiedAntigravityRelease(input.agentVersion) &&
      // The agent turns a file URI into a path with unquote(urlparse(uri).path), which drops
      // Windows drives and UNC hosts. Keep the saved path there until Windows is qualified.
      platform !== "win32" &&
      antigravityModelAcceptsVideo(input.currentModel);
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        TEXT_MIME_TYPES.has(mimeType) ||
        TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
    const isPathOnly =
      (attachment.type === "image" && (!image || input.promptCapabilities?.image !== true)) ||
      (attachment.type === "file" &&
        (isPastedText ||
          (audio
            ? input.promptCapabilities?.audio !== true
            : pdf || textFile
              ? input.promptCapabilities?.embeddedContext !== true
              : !video)));
    const attachmentPath = input.resolveAttachmentPath(attachment);
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
    if (info.type !== "File") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Could not read attachment '${attachment.name}'.`,
      );
    }
    if (isPathOnly) continue;
    const size = Number(info.size);
    const limit = image
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : audio
        ? ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES
        : pdf
          ? MAX_TOTAL_ATTACHMENT_BYTES
          : video
            ? ANTIGRAVITY_MAX_VIDEO_ATTACHMENT_BYTES
            : ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES;
    if (
      attachment.type === "file" &&
      (size > limit || totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES)
    ) {
      continue;
    }
    totalBytes += size;
    if (size > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Image '${attachment.name}' is too large. Antigravity accepts images up to 10 MiB and 50 MiB of native attachments per message.`,
      );
    }
    const uri = yield* path.toFileUrl(attachmentPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
      ),
    );
    if (pdf || video) {
      blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType, size });
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
    totalBytes += bytes.length - size;
    if (bytes.length > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' changed while being read and is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else if (audio) {
      blocks.push({ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else {
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
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or supported attachments.",
    );
  }
  return blocks;
});
