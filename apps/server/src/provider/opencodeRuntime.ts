import { pathToFileURL } from "node:url";

import type {
  ChatAttachment,
  ModelCapabilities,
  ProviderApprovalDecision,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import { NetService } from "@t3tools/shared/Net";

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
  close(): void;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
  close(): void;
}

export class OpenCodeRuntimeError extends Data.TaggedError("OpenCodeRuntimeError")<{
  readonly operation:
    | "runOpenCodeCommand"
    | "startOpenCodeServerProcess"
    | "connectToOpenCodeServer"
    | "loadOpenCodeInventory";
  readonly cause: unknown;
  readonly detail: string;
}> {}
const isOpenCodeRuntimeError = (error: unknown): error is OpenCodeRuntimeError =>
  P.isTagged(error, "OpenCodeRuntimeError");

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (isOpenCodeRuntimeError(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`;
    } catch {
      /* fall through */
    }
  }
  return String(cause);
}
export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError>;
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
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

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
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
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
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

export function toOpenCodePermissionReply(
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

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
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

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return isOpenCodeRuntimeError(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService;
  const runtimeContext = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const runFork = Effect.runForkWith(runtimeContext);

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binaryPath, [...input.args], {
          shell: process.platform === "win32",
          env: process.env,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
          cause: new Error(`spawn ${input.binaryPath} ENOENT`),
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

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
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

      const scope = yield* Scope.make();

      let closed = false;
      const closeScope = Effect.sync(() => {
        if (closed) {
          return false;
        }
        closed = true;
        return true;
      }).pipe(
        Effect.flatMap((shouldClose) =>
          shouldClose ? Scope.close(scope, Exit.void).pipe(Effect.ignore) : Effect.void,
        ),
      );

      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.binaryPath, args, {
            env: {
              ...process.env,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
            },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

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
        Effect.forkIn(scope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(scope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
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
        Effect.forkIn(scope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* closeScope;
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* closeScope;
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
          cause: { timeoutMs },
        });
      }

      return {
        url: readyOption.value,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
        close: () => {
          runFork(closeScope);
        },
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      return Effect.succeed({
        url: serverUrl,
        exitCode: null,
        external: true,
        close() {},
      });
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        exitCode: server.exitCode,
        external: false,
        close: () => server.close(),
      })),
    );
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const loadProviders = (client: OpencodeClient) =>
    Effect.tryPromise({
      try: async () => client.provider.list(),
      catch: (cause) =>
        new OpenCodeRuntimeError({
          operation: "loadOpenCodeInventory",
          detail: `Failed to load OpenCode providers: ${openCodeRuntimeErrorDetail(cause)}`,
          cause: cause,
        }),
    }).pipe(
      Effect.filterMapOrFail((list) =>
        list.data
          ? Result.succeed(list.data)
          : Result.fail(
              new OpenCodeRuntimeError({
                operation: "loadOpenCodeInventory",
                detail: "OpenCode provider list was empty.",
                cause: new Error("OpenCode provider list was empty."),
              }),
            ),
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    Effect.tryPromise({
      try: async () => client.app.agents(),
      catch: (cause) =>
        new OpenCodeRuntimeError({
          operation: "loadOpenCodeInventory",
          detail: `Failed to load OpenCode agents: ${openCodeRuntimeErrorDetail(cause)}`,
          cause: cause,
        }),
    }).pipe(Effect.map((result) => result.data ?? []));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client)], { concurrency: "unbounded" }).pipe(
      Effect.map(
        ([providerList, agents]) =>
          ({
            providerList,
            agents,
          }) satisfies OpenCodeInventory,
      ),
      Effect.mapError(
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: `Failed to load OpenCode inventory: ${openCodeRuntimeErrorDetail(cause)}`,
            cause: cause,
          }),
      ),
    );
  // Effect.tryPromise({
  //   try: async () => {
  //     const [providerListResult, agentsResult] = await Promise.all([
  //       client.provider.list(),
  //       client.app.agents(),
  //     ]);
  //     console.log(JSON.stringify(providerListResult, null, 4));
  //     console.log(JSON.stringify(agentsResult, null, 4));
  //     if (!providerListResult.data) {
  //       throw new Error("OpenCode provider inventory was empty.");
  //     }
  //     return {
  //       providerList: providerListResult.data,
  //       agents: agentsResult.data ?? [],
  //     } satisfies OpenCodeInventory;
  //   },
  //   catch: (cause) =>
  //     new OpenCodeRuntimeError({
  //       operation: "loadOpenCodeInventory",
  //       detail: `Failed to load OpenCode inventory: ${openCodeRuntimeErrorDetail(cause)}`,
  //       cause: cause,
  //     }),
  // });

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/OpenCodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
