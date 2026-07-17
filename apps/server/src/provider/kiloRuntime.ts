import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createKiloClient,
  type Agent,
  type FilePartInput,
  type KiloClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@kilocode/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const KILO_SERVER_READY_PREFIX = "kilo server listening";
const DEFAULT_KILO_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface KiloServerProcess {
  readonly url: string;
  readonly password: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface KiloServerConnection {
  readonly url: string;
  readonly password: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const KILO_RUNTIME_ERROR_TAG = "KiloRuntimeError";
export class KiloRuntimeError extends Data.TaggedError(KILO_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is KiloRuntimeError => P.isTagged(u, KILO_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function kiloRuntimeErrorDetail(cause: unknown): string {
  if (KiloRuntimeError.is(cause)) return cause.detail;
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

export const runKiloSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, KiloRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new KiloRuntimeError({ operation, detail: kiloRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`kilo.${operation}`));

export interface KiloCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface KiloInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface ParsedKiloModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface KiloRuntimeShape {
  /**
   * Spawns a local Kilo server process. Lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed when that scope closes.
   */
  readonly startKiloServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<KiloServerProcess, KiloRuntimeError, Scope.Scope>;
  /**
   * Always spawns a managed local server (v1 has no user-facing serverUrl).
   * Lifetime is bound to the caller's scope.
   */
  readonly connectToKiloServer: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<KiloServerConnection, KiloRuntimeError, Scope.Scope>;
  readonly runKiloCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<KiloCommandResult, KiloRuntimeError>;
  readonly createKiloSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword: string;
  }) => KiloClient;
  readonly loadKiloInventory: (
    client: KiloClient,
  ) => Effect.Effect<KiloInventory, KiloRuntimeError>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().includes(KILO_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = trimmed.match(/on\s+(https?:\/\/[^\s]+)/i);
    // Keep scanning: a log line may mention the ready phrase without a URL.
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function parseKiloModelSlug(slug: string | null | undefined): ParsedKiloModelSlug | null {
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

export function kiloQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toKiloFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildKiloPermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toKiloPermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toKiloQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[kiloQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

export function resolveKiloAgent(input: {
  readonly interactionMode?: string | null | undefined;
}): "code" | "plan" {
  return input.interactionMode === "plan" ? "plan" : "code";
}

function ensureRuntimeError(
  operation: KiloRuntimeError["operation"],
  detail: string,
  cause: unknown,
): KiloRuntimeError {
  return KiloRuntimeError.is(cause) ? cause : new KiloRuntimeError({ operation, detail, cause });
}

function generateServerPassword(): string {
  return NodeCrypto.randomBytes(32).toString("hex");
}

const makeKiloRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runKiloCommand: KiloRuntimeShape["runKiloCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new KiloRuntimeError({
          operation: "runKiloCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies KiloCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runKiloCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${kiloRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startKiloServerProcess: KiloRuntimeShape["startKiloServerProcess"] = (input) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new KiloRuntimeError({
                operation: "startKiloServerProcess",
                detail: `Failed to find available port: ${kiloRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_KILO_SERVER_TIMEOUT_MS;
      const password = generateServerPassword();
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: {
              ...input.environment,
              KILO_SERVER_PASSWORD: password,
              KILO_PARENT_PID: String(process.pid),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new KiloRuntimeError({
                operation: "startKiloServerProcess",
                detail: `Failed to spawn Kilo server process: ${kiloRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killKiloProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // Best-effort process-group cleanup.
              }
            });
      const terminateChild = killKiloProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killKiloProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, KiloRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new KiloRuntimeError({
                operation: "startKiloServerProcess",
                detail: [
                  `Kilo server exited before startup completed (code: ${String(exitCode)}).`,
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

      if (Exit.isFailure(readyExit)) {
        // Stop draining + kill the child immediately so a failed start does not
        // leave a half-started server holding the port until the outer scope ends.
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* terminateChild;
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startKiloServerProcess",
          `Failed while waiting for Kilo server startup: ${kiloRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* terminateChild;
        return yield* new KiloRuntimeError({
          operation: "startKiloServerProcess",
          detail: `Timed out waiting for Kilo server start after ${timeoutMs}ms.`,
        });
      }

      // Keep stdout/stderr drain fibers alive for the server lifetime so the
      // OS pipe buffers cannot fill and block the child process.
      return {
        url: readyOption.value,
        password,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies KiloServerProcess;
    });

  const connectToKiloServer: KiloRuntimeShape["connectToKiloServer"] = (input) =>
    startKiloServerProcess({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        password: server.password,
        exitCode: server.exitCode,
        external: false,
      })),
    );

  const createKiloSdkClient: KiloRuntimeShape["createKiloSdkClient"] = (input) =>
    createKiloClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      headers: {
        Authorization: `Basic ${Buffer.from(`kilo:${input.serverPassword}`, "utf8").toString("base64")}`,
      },
      throwOnError: true,
    });

  const loadProviders = (client: KiloClient) =>
    runKiloSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new KiloRuntimeError({
                  operation: "provider.list",
                  detail: "Kilo provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: KiloClient) =>
    runKiloSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadKiloInventory: KiloRuntimeShape["loadKiloInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client)], { concurrency: "unbounded" }).pipe(
      Effect.map(([providerList, agents]) => ({ providerList, agents })),
    );

  return {
    startKiloServerProcess,
    connectToKiloServer,
    runKiloCommand,
    createKiloSdkClient,
    loadKiloInventory,
  } satisfies KiloRuntimeShape;
});

export class KiloRuntime extends Context.Service<KiloRuntime, KiloRuntimeShape>()(
  "t3/provider/kiloRuntime",
) {}

export const KiloRuntimeLive = Layer.effect(KiloRuntime, makeKiloRuntime).pipe(
  Layer.provide(NetService.layer),
);
