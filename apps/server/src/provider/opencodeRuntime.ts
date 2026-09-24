import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import { OpenCode } from "@opencode/client";
import type {
  AgentInfo,
  CommandInfo,
  ModelInfo,
  PermissionRuleset,
  ProviderInfo,
  SkillInfo,
  FormInfo,
  FormInfo1,
  FormAnswer,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
export const MINIMUM_OPENCODE_VERSION = "2.0.12";
const OPENCODE_HEALTH_TIMEOUT = "5 seconds";

const OpenCodeInfoSchema = Schema.Struct({ version: Schema.String });
const decodeOpenCodeInfo = Schema.decodeUnknownEffect(OpenCodeInfoSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return (
    inputEnvironment?.OPENCODE_CONFIG_CONTENT ??
    inheritedEnvironment.OPENCODE_CONFIG_CONTENT
  );
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  const environment = input.environment ?? inheritedEnvironment;
  return environment.OPENCODE_PASSWORD ?? environment.OPENCODE_SERVER_PASSWORD;
}

const OPENCODE_SERVER_READY_PREFIX = "server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpenCodeClient,
) {
  const healthOption = yield* runOpenCodeSdk("server.info", (signal) =>
    client.server.info({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(healthOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const health = yield* decodeOpenCodeInfo(healthOption.value).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "server.info",
          detail: `OpenCode server returned an invalid health response. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  if (parseSemver(health.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode server returned an invalid version. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(health.version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode v${health.version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  return health.version;
});

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providers: ReadonlyArray<ProviderInfo>;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly skills: ReadonlyArray<SkillInfo>;
  readonly commands: ReadonlyArray<CommandInfo>;
}

/** Command templates stay in OpenCode, which expands arguments and runs MCP prompts. */
export const loadOpenCodeCommands = (client: OpenCodeClient, directory: string) =>
  runOpenCodeSdk("command.list", (signal) =>
    client.command.list({ location: { directory } }, { signal }),
  ).pipe(Effect.map((result) => result.data));

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly serverPassword?: string;
  }) => OpenCodeClient;
  readonly loadOpenCodeInventory: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<ReadonlyArray<SkillInfo>, OpenCodeRuntimeError>;
}

function parseServerUrlFromOutput(output: string): {
  readonly url: string;
  /** Whether the readiness line was newline-terminated (definitely complete). */
  readonly terminated: boolean;
} | null {
  // Every line except the last is newline-terminated and therefore complete.
  // The trailing fragment may be a complete readiness line that never got a
  // newline, or a partial chunk of a line still in flight — the caller keeps
  // a trailing candidate pending until the output settles instead of
  // resolving with a truncated URL.
  const lines = output.split("\n");
  for (const line of lines.slice(0, -1)) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    if (match?.[1]) {
      return { url: match[1], terminated: true };
    }
  }
  const trailing = lines[lines.length - 1] ?? "";
  if (trailing.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
    const match = trailing.match(/on\s+(https?:\/\/[^\s]+)/);
    if (match?.[1]) {
      return { url: match[1], terminated: false };
    }
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

/**
 * Attachments OpenCode can hand to a model as a native file part. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<{ uri: string; name?: string }> {
  const parts: Array<{ uri: string; name?: string }> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      name: attachment.name,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults. Allow reads and task
  // updates, but keep its default approval rules for environment files.
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "lsp", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "todowrite", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: editAction },
    { action: "webfetch", resource: "*", effect: "ask" },
    { action: "websearch", resource: "*", effect: "ask" },
    { action: "codesearch", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "doom_loop", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: FormInfo | FormInfo1,
  answers: Record<string, unknown>,
): FormAnswer {
  const result: FormAnswer = {};
  for (const field of request.fields) {
    if (field.type === "external") continue;
    const raw = answers[field.key];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    if (values.length === 0 && !field.required) continue;
    const options = "options" in field ? field.options : undefined;
    // Match the UI's submitted identifier: `normalizeOpenCodeForm` round-trips
    // the native option `value` through `UserInputQuestionOption.value`, and
    // the web client submits that value (`option.value ?? option.label`).
    // Values win over labels across the whole option list so a duplicate
    // label can never shadow another option's native value; labels remain a
    // display fallback for answers authored by hand.
    const value = (item: unknown) =>
      options?.find((option) => option.value === item)?.value ??
      options?.find((option) => option.label === item)?.value ??
      item;
    const first = value(values[0]);
    if (field.type === "multiselect")
      result[field.key] = values
        .map(value)
        .filter((item): item is string => typeof item === "string");
    else if (field.type === "boolean") {
      if (typeof first === "boolean") result[field.key] = first;
      else if (first === "true" || first === "false") result[field.key] = first === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const number =
        typeof first === "number"
          ? first
          : typeof first === "string" && first.trim()
            ? Number(first)
            : Number.NaN;
      if (Number.isFinite(number) && (field.type !== "integer" || Number.isInteger(number)))
        result[field.key] = number;
    } else if (typeof first === "string") result[field.key] = first;
  }
  return result;
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    OpenCode.make({
      baseUrl: input.baseUrl,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);
      const serverPassword =
        resolveOpenCodeServerPassword({
          external: false,
          ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        }) ||
        (yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: "Failed to generate an OpenCode server password.",
                cause,
              }),
          ),
        ));

      const resolvedConfigContent = resolveOpenCodeConfigContent(input.environment);
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: {
              ...input.environment,
              OPENCODE_PASSWORD: serverPassword,
              // Respect an OPENCODE_CONFIG_CONTENT provided by the caller or
              // the inherited process environment. When neither is provided,
              // do NOT set OPENCODE_CONFIG_CONTENT so OpenCode reads the user's
              // default configuration (~/.config/opencode/opencode.json). Setting
              // it unconditionally to "{}" previously clobbered the user's
              // opencode config, hiding their providers/models.
              ...(resolvedConfigContent !== undefined
                ? { OPENCODE_CONFIG_CONTENT: resolvedConfigContent }
                : {}),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.modify(stdoutRef, (stdout) => {
          if (stdout === null) {
            return [null, null] as const;
          }
          const nextStdout = `${stdout}${chunk}`;
          return [
            parseServerUrlFromOutput(nextStdout),
            nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed === null
              ? Effect.void
              : parsed.terminated
                ? Deferred.succeed(readyDeferred, parsed.url).pipe(Effect.ignore)
                : confirmSettledReadyUrl(parsed.url).pipe(Effect.ignore),
          ),
        );

      // An unterminated readiness candidate may be a partial chunk of a line
      // still in flight. Give the output a moment to settle: if it grows,
      // re-parse (the next chunk's handler also runs, so this just avoids
      // resolving with a truncated URL when no further chunk ever arrives).
      const confirmSettledReadyUrl = (candidate: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(readyDeferred)) {
            return;
          }
          const before = yield* Ref.get(stdoutRef);
          yield* Effect.sleep("300 millis");
          if (yield* Deferred.isDone(readyDeferred)) {
            return;
          }
          const after = yield* Ref.get(stdoutRef);
          if (after === null || after === before) {
            yield* Deferred.succeed(readyDeferred, candidate).pipe(Effect.ignore);
            return;
          }
          const reparsed = parseServerUrlFromOutput(after);
          if (reparsed === null) {
            yield* Deferred.succeed(readyDeferred, candidate).pipe(Effect.ignore);
          } else if (reparsed.terminated) {
            yield* Deferred.succeed(readyDeferred, reparsed.url).pipe(Effect.ignore);
          } else {
            yield* confirmSettledReadyUrl(reparsed.url);
          }
        });

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = ((yield* Ref.get(stdoutRef)) ?? "").replaceAll(
              serverPassword,
              "[redacted]",
            );
            const stderr = ((yield* Ref.get(stderrRef)) ?? "").replaceAll(
              serverPassword,
              "[redacted]",
            );
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
        yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
      }

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const url = readyOption.value;
      const version = yield* verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: url,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      );

      return {
        url,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        version,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client, directory) =>
    runOpenCodeSdk("skill.list", (signal) =>
      client.skill.list({ location: { directory } }, { signal }),
    ).pipe(Effect.map((result) => result.data));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (
    client,
    directory,
  ) =>
    Effect.all(
      [
        runOpenCodeSdk("provider.list", (signal) =>
          client.provider.list({ location: { directory } }, { signal }),
        ).pipe(Effect.map((result) => result.data)),
        runOpenCodeSdk("model.list", (signal) =>
          client.model.list({ location: { directory } }, { signal }),
        ).pipe(Effect.map((result) => result.data)),
        runOpenCodeSdk("agent.list", (signal) =>
          client.agent.list({ location: { directory } }, { signal }),
        ).pipe(
          Effect.map((result) => result.data),
          Effect.orElseSucceed(() => []),
        ),
        loadOpenCodeSkills(client, directory).pipe(Effect.orElseSucceed(() => [])),
        loadOpenCodeCommands(client, directory).pipe(Effect.orElseSucceed(() => [])),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.map(([providers, models, agents, skills, commands]) => ({
        providers,
        models,
        agents,
        skills,
        commands,
      })),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
