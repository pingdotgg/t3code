import {
  type DevinSettings,
  type ProviderInteractionMode,
  ProviderDriverKind,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
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
import * as NodeOS from "node:os";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { type AcpSessionModeState } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

/**
 * `devin-browser` opens the system browser for the interactive OAuth login. It
 * is sent only when the session runtime has no ambient credentials to reuse;
 * see {@link resolveDevinAuthMethodId}.
 */
export const DEVIN_BROWSER_AUTH_METHOD = "devin-browser";
export const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";
const DEVIN_CREDENTIALS_PATH_SEGMENTS = [".local", "share", "devin", "credentials.toml"] as const;

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

/**
 * Candidate locations for the `devin auth login` credentials file. The CLI's
 * documented path is `$XDG_DATA_HOME/devin/credentials.toml`, defaulting to
 * `~/.local/share`; on Windows it lives under `%LOCALAPPDATA%`. Checking every
 * candidate keeps the auth skip honest on non-default setups — a false
 * negative here sends `devin-browser` and opens a browser for a signed-in
 * user.
 */
export function devinCredentialsFilePaths(
  environment: NodeJS.ProcessEnv | undefined,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const xdgDataHome = environment?.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    candidates.add([xdgDataHome, "devin", "credentials.toml"].join("/"));
  }
  const localAppData = environment?.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.add([localAppData, "devin", "credentials.toml"].join("/"));
  }
  const home = environment?.HOME?.trim() || environment?.USERPROFILE?.trim() || NodeOS.homedir();
  candidates.add([home, ...DEVIN_CREDENTIALS_PATH_SEGMENTS].join("/"));
  return [...candidates];
}

/**
 * Whether the Devin CLI can authenticate without a browser round trip. Mirrors
 * the credential order `devin acp` itself applies: `WINDSURF_API_KEY` from the
 * environment first, then the `devin auth login` credentials file.
 */
export const devinHasAmbientCredentials = (
  environment: NodeJS.ProcessEnv | undefined,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (environment?.[DEVIN_API_KEY_ENV]?.trim()) {
      return true;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    for (const credentialsPath of devinCredentialsFilePaths(environment)) {
      const exists = yield* fileSystem
        .exists(credentialsPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) return true;
    }
    return false;
  });

/**
 * The `authenticate` call the runtime should issue at session start, if any.
 *
 * `devin acp` reads stored credentials on its own, so when ambient credentials
 * exist there is nothing to send — issuing `devin-browser` anyway would open a
 * browser on every session spawn. When credentials are absent and
 * `browserAuth` is allowed (user-initiated session starts only — background
 * probes and text generation must never open a browser), `devin-browser` is
 * returned so the sign-in flow can run.
 */
export const resolveDevinAuthMethodId = (input: {
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly browserAuth: boolean;
}): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.map(devinHasAmbientCredentials(input.environment), (hasCredentials) =>
    hasCredentials || !input.browserAuth ? undefined : DEVIN_BROWSER_AUTH_METHOD,
  );

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Whether a missing-credentials session may fall back to `devin-browser`
   * authentication. Pass `true` only on user-initiated paths (thread start);
   * background work like text generation and health probes must never open a
   * browser.
   */
  readonly browserAuth?: boolean;
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const authMethodId = yield* resolveDevinAuthMethodId({
      environment: input.environment,
      browserAuth: input.browserAuth === true,
    });
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId,
        clientCapabilities: {
          // Devin reads and writes workspace files through its own tools behind
          // `session/request_permission`; the client fs bridge is unused.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        cancelBehavior: "wait-for-prompt",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Maps T3's permission/intermission modes onto Devin's `mode` session option
 * (`accept-edits`, `smart`, `ask`, `plan`, `bypass`). Plan mode wins over the
 * permission mapping, matching the generic interaction-mode contract.
 */
export function devinModeFor(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode | undefined,
): string {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto":
      return "smart";
    case "auto-accept-edits":
      return "accept-edits";
    case "approval-required":
      return "ask";
  }
}

/**
 * Resolves the requested mode to a Devin-advertised mode id. Returns
 * `undefined` when the mode is not offered — the session keeps its current
 * mode rather than failing.
 */
export function resolveDevinModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;
  const requested = devinModeFor(input.runtimeMode, input.interactionMode);
  const mode = modeState.availableModes.find(
    (candidate) => candidate.id === requested || candidate.name.trim().toLowerCase() === requested,
  );
  return mode?.id;
}

export function resolveDevinModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return normalizeModelSlug(trimmed, DEVIN_DRIVER_KIND) ?? trimmed;
}

/**
 * Devin does not advertise `SessionModelState`; its models ride the standard
 * `category: "model"` configuration option. Returns the option's current
 * value, or `undefined` when the option is absent or has none.
 */
export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return currentDevinModelIdFromConfigOptions(sessionSetupResult.configOptions ?? []);
}

export function currentDevinModelIdFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const modelOption = findDevinModelConfigOption(configOptions);
  const current = modelOption?.currentValue;
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

/** A session config option that can carry select-style `options`. */
export type DevinSelectConfigOption = Exclude<
  EffectAcpSchema.SessionConfigOption,
  { readonly type: "boolean" }
>;

/** The session config option carrying Devin's model catalog, if advertised. */
export function findDevinModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): DevinSelectConfigOption | undefined {
  return configOptions.find(
    (candidate): candidate is DevinSelectConfigOption =>
      (candidate.category === "model" || candidate.id === "model") && candidate.type !== "boolean",
  );
}

/** The flattened `value` list of a select config option (groups included). */
export function devinModelOptionValues(option: DevinSelectConfigOption): ReadonlyArray<string> {
  return (option.options ?? []).flatMap((entry) =>
    "value" in entry ? [entry.value] : (entry.options ?? []).map((nested) => nested.value),
  );
}

/**
 * Applies a model selection through the session `model` config option. A no-op
 * when the selection is already current — or when the session advertises no
 * model option at all, in which case there is nothing to switch with and
 * `undefined` is returned. Otherwise returns the applied model id.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel"
  >;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requested = resolveDevinModelId(input.model);
    if (!requested) return undefined;
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelOption = findDevinModelConfigOption(configOptions);
    if (!modelOption) return undefined;
    const current =
      typeof modelOption.currentValue === "string"
        ? modelOption.currentValue.trim() || undefined
        : undefined;
    if (requested === current) {
      return current;
    }
    yield* input.runtime.setModel(requested).pipe(Effect.mapError(input.mapError));
    return requested;
  });
}

const DEVIN_IMAGE_MIME_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DEVIN_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const DEVIN_TEXT_FILE_EXTENSIONS = new Set([
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
const DEVIN_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

/**
 * Sends uploads as native ACP content. Devin advertises `image` and
 * `embeddedContext` prompt capabilities, so images go base64 inline, text
 * files embed as `resource` blocks, and everything else ships as a
 * `resource_link` the agent can open itself (the attachments directory is
 * granted as an additional session directory).
 */
export const buildDevinPrompt = Effect.fn("buildDevinPrompt")(function* (input: {
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
    const image = attachment.type === "image" && DEVIN_IMAGE_MIME_TYPES.has(mimeType);
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        DEVIN_TEXT_MIME_TYPES.has(mimeType) ||
        DEVIN_TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
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
    const limit = image
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : textFile
        ? DEVIN_MAX_TEXT_ATTACHMENT_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    totalBytes += size;
    if (info.type !== "File" || size > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' is too large. Devin accepts text files up to 1 MiB, images up to 10 MiB, and 50 MiB total attachments.`,
      );
    }
    const uri = yield* path.toFileUrl(attachmentPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
      ),
    );
    if (!image && !textFile) {
      // Binary or unknown files are referenced by link; Devin can read them
      // itself through the granted attachments directory.
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
    totalBytes += bytes.length - size;
    if (bytes.length > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' changed while being read and is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
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
