import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravityAuthMethod,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
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
import {
  acpPermissionDisposition,
  unknownRecord,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import packageJson from "../../../package.json" with { type: "json" };
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
  /** Serve `fs/read_text_file` from T3 instead of the agent's native reader. */
  readonly clientFileReads?: boolean;
  readonly clientCapabilities?: AcpSessionRuntime.AcpSessionRuntimeOptions["clientCapabilities"];
  /** The installed version, known before `initialize`; it picks the client name. */
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

// `agy acp` 1.5.1 offers every model to every ACP client; older runtimes allowlist editors.
const OPEN_MODEL_ACCESS_RELEASE = [1, 5, 1] as const;
// `agy acp` 1.5.0 steers a running turn with the next prompt; the 1.4 harness queues it.
const PROMPT_STEERING_RELEASE = [1, 5, 0] as const;

export const antigravitySteersWithPrompt = (
  initializeResult: EffectAcpSchema.InitializeResponse,
) => {
  const parsed = parseAntigravityVersion(initializeResult.agentInfo?.version);
  return parsed !== undefined && compareVersions(parsed, PROMPT_STEERING_RELEASE) >= 0;
};

export const antigravityAppendsSystemPrompt = (
  initializeResult: EffectAcpSchema.InitializeResponse,
) => {
  const extension = initializeResult.agentCapabilities?._meta?.antigravity;
  return (
    Predicate.isObject(extension) &&
    Predicate.isObject(extension.systemPrompt) &&
    extension.systemPrompt.append === true
  );
};

export function antigravitySessionMeta(
  initializeResult: EffectAcpSchema.InitializeResponse,
  systemPromptAppend?: string,
): EffectAcpSchema.NewSessionRequest["_meta"] | undefined {
  return systemPromptAppend !== undefined && antigravityAppendsSystemPrompt(initializeResult)
    ? { antigravity: { systemPrompt: { append: systemPromptAppend } } }
    : undefined;
}

/** Older releases offer non-Gemini models only to allowlisted clients such as Zed. */
export function antigravityClientInfo(version: string | null | undefined) {
  const parsed = parseAntigravityVersion(version);
  return parsed !== undefined && compareVersions(parsed, OPEN_MODEL_ACCESS_RELEASE) >= 0
    ? { name: "t3-code", title: "T3 Code", version: packageJson.version }
    : { name: "zed", version: "0.0.0" };
}

export const makeAntigravityAcpRuntime = Effect.fn("makeAntigravityAcpRuntime")(function* (
  input: AntigravityAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  SecureRandom.SecureRandom | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: input.authMethod ?? "oauth-personal",
      authenticateEagerly: true,
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientInfo: antigravityClientInfo(input.runtimeVersion),
      sessionMeta: (initializeResult) =>
        antigravitySessionMeta(initializeResult, input.sessionSystemPromptAppend),
      clientCapabilities: {
        ...input.clientCapabilities,
        // Advertising writes swaps the agent's diff edits for whole-file client_edit_file.
        fs: {
          readTextFile: input.clientFileReads === true,
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

export function antigravityPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "auto_edit";
    case "auto":
      return "auto";
    case "approval-required":
      return "default";
  }
}

/**
 * The agy CLI rejects `yolo` and `auto_edit`, and sessions without native Auto reject `auto`.
 * Those stay in `default`, where it asks before acting and T3 answers from the live runtime
 * policy, so permission changes apply on the next turn without a restart.
 */
export function antigravitySessionMode(
  modeId: string,
  modeState: AcpSessionModeState | undefined,
): string {
  if (modeId === "auto") {
    return modeState?.availableModes.some((mode) => mode.id === "auto") === true
      ? "auto"
      : "default";
  }
  return modeId === "yolo" || modeId === "auto_edit" ? "default" : modeId;
}

// Only calls that name T3's server: before agy 1.5.8 "Running <tool>" names no server, so another
// MCP server's tool of the same name would pass.
const ANTIGRAVITY_T3_MCP_TITLE = /^Run mcp_t3-code_(?<tool>[A-Za-z0-9_]+)\??$/;

function isAntigravityT3McpRequest(request: EffectAcpSchema.RequestPermissionRequest): boolean {
  const rawInput = unknownRecord(request.toolCall.rawInput);
  if (rawInput?.ServerName !== undefined) {
    return (
      rawInput.ServerName === "t3-code" &&
      typeof rawInput.ToolName === "string" &&
      T3_MCP_TOOL_NAMES.has(rawInput.ToolName)
    );
  }
  if (typeof rawInput?.CommandLine === "string") return false;
  const tool = ANTIGRAVITY_T3_MCP_TITLE.exec(request.toolCall.title?.trim() ?? "")?.groups?.tool;
  return tool !== undefined && T3_MCP_TOOL_NAMES.has(tool);
}

export function antigravityPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
) {
  const disposition = acpPermissionDisposition(policy, request);
  if (disposition === "deny") return "deny";
  // T3 authorizes its own MCP server, so Auto and Auto-accept edits run it unasked, as Claude does.
  if (
    (policy.runtimeMode === "auto" || policy.runtimeMode === "auto-accept-edits") &&
    (policy.approvalPolicy === undefined || policy.approvalPolicy === "never") &&
    isAntigravityT3McpRequest(request)
  ) {
    return "allow";
  }
  // agy's Auto has already reviewed what it sends; the user decides unless the sandbox forbids it.
  return policy.runtimeMode === "auto" ? "ask" : disposition;
}

/** The runtime mode an Antigravity session mode grants; the inverse of `antigravityPermissionMode`. */
export function antigravityRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "yolo":
      return "full-access";
    case "auto_edit":
      return "auto-accept-edits";
    case "auto":
      return "auto";
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
    if (resolved === current) return resolved;
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
    const isPastedText =
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text";
    // The text already carries the path; keep folded pastes lazy so agents can search without embedding the whole file.
    const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const audio = attachment.type === "file" && AUDIO_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
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
            : !(pdf || textFile) || input.promptCapabilities?.embeddedContext !== true)));
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
    if (pdf) {
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
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? "UTF-16LE"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "UTF-16BE"
            : "UTF-8";
      const decoded = yield* Effect.try({
        try: () => new TextDecoder(encoding, { fatal: true }).decode(bytes),
        catch: () =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Attachment '${attachment.name}' is not a ${encoding} text file.`,
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
