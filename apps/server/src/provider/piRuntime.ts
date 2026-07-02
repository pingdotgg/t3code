import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as P from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";

const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);
const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

function encodeJsonLine(value: unknown): string {
  const result = encodeJsonStringExit(value);
  return Exit.isSuccess(result) ? result.value : "";
}

const PI_RUNTIME_ERROR_TAG = "PiRuntimeError";
export class PiRuntimeError extends Data.TaggedError(PI_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is PiRuntimeError => P.isTagged(u, PI_RUNTIME_ERROR_TAG);
}

export function piRuntimeErrorDetail(cause: unknown): string {
  if (PiRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

const DEFAULT_PI_REQUEST_TIMEOUT_MS = 30_000;

export interface PiCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export const runPiCommand = (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Effect.Effect<PiCommandResult, PiRuntimeError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(
      input.binaryPath,
      input.args,
      input.environment ? { env: input.environment } : {},
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        shell: spawnCommand.shell,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.environment ? { env: input.environment } : { extendEnv: true }),
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    const exitCode = Number(code);
    if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new PiRuntimeError({
        operation: "runPiCommand",
        detail: `spawn ${input.binaryPath} ENOENT`,
      });
    }
    return { stdout, stderr, code: exitCode } satisfies PiCommandResult;
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      PiRuntimeError.is(cause)
        ? cause
        : new PiRuntimeError({
            operation: "runPiCommand",
            detail: `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${piRuntimeErrorDetail(cause)}`,
            cause,
          }),
    ),
  );

export interface ParsedPiModelSlug {
  readonly provider: string;
  readonly modelId: string;
}

export function parsePiModelSlug(slug: string | null | undefined): ParsedPiModelSlug | null {
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

export interface PiModelInfo {
  readonly provider: string;
  readonly modelId: string;
  readonly contextWindow: number | undefined;
  readonly maxTokens: number | undefined;
  readonly thinking: boolean;
  readonly images: boolean;
}

function parseTokenCount(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([KM])?$/i);
  if (!match?.[1]) return undefined;
  const base = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const scaled = unit === "M" ? base * 1_000_000 : unit === "K" ? base * 1_000 : base;
  return Number.isFinite(scaled) ? Math.round(scaled) : undefined;
}

export function parsePiModelList(stdout: string): ReadonlyArray<PiModelInfo> {
  const models: Array<PiModelInfo> = [];
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== 6) continue;
    const [provider, modelId, context, maxOut, thinking, images] = tokens as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (provider === "provider" || !/^(yes|no)$/.test(thinking) || !/^(yes|no)$/.test(images)) {
      continue;
    }
    models.push({
      provider,
      modelId,
      contextWindow: parseTokenCount(context),
      maxTokens: parseTokenCount(maxOut),
      thinking: thinking === "yes",
      images: images === "yes",
    });
  }
  return models;
}

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export const PI_APPROVAL_TITLE_PREFIX = "T3_APPROVAL ";
export const PI_APPROVAL_OPTION_ALLOW = "allow";
export const PI_APPROVAL_OPTION_ALLOW_ALWAYS = "allow-always";
export const PI_APPROVAL_OPTION_DENY = "deny";
export const PI_RUNTIME_MODE_ENV = "T3CODE_PI_RUNTIME_MODE";

export const PI_APPROVAL_EXTENSION_SOURCE = `\
const MODE = process.env["${PI_RUNTIME_MODE_ENV}"] ?? "approval-required";

export default function t3codeApprovals(pi) {
  const alwaysAllowed = new Set();
  pi.on("tool_call", async (event, ctx) => {
    if (MODE === "full-access") return;
    const tool = event.toolName;
    const isEditTool = tool === "edit" || tool === "write";
    const gated = tool === "bash" || (isEditTool && MODE !== "auto-accept-edits");
    if (!gated || alwaysAllowed.has(tool)) return;
    const input = event.input ?? {};
    const detail =
      tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.file_path ?? "");
    const choice = await ctx.ui.select(
      "${PI_APPROVAL_TITLE_PREFIX}" + JSON.stringify({ tool, detail }),
      ["${PI_APPROVAL_OPTION_ALLOW}", "${PI_APPROVAL_OPTION_ALLOW_ALWAYS}", "${PI_APPROVAL_OPTION_DENY}"],
    );
    if (choice === "${PI_APPROVAL_OPTION_ALLOW_ALWAYS}") {
      alwaysAllowed.add(tool);
      return;
    }
    if (choice === "${PI_APPROVAL_OPTION_ALLOW}") return;
    return {
      block: true,
      reason:
        choice === "${PI_APPROVAL_OPTION_DENY}"
          ? "The user denied this action."
          : "The approval request was cancelled.",
    };
  });
}
`;

export interface PiApprovalRequestPayload {
  readonly tool: string;
  readonly detail: string;
}

export function parsePiApprovalTitle(title: unknown): PiApprovalRequestPayload | null {
  if (typeof title !== "string" || !title.startsWith(PI_APPROVAL_TITLE_PREFIX)) return null;
  const result = decodeJsonStringExit(title.slice(PI_APPROVAL_TITLE_PREFIX.length));
  if (Exit.isFailure(result)) return null;
  const parsed = result.value;
  if (parsed && typeof parsed === "object" && "tool" in parsed) {
    const record = parsed as Record<string, unknown>;
    return {
      tool: typeof record.tool === "string" ? record.tool : "unknown",
      detail: typeof record.detail === "string" ? record.detail : "",
    };
  }
  return null;
}

export function toPiApprovalSelection(decision: ProviderApprovalDecision): string | null {
  switch (decision) {
    case "accept":
      return PI_APPROVAL_OPTION_ALLOW;
    case "acceptForSession":
      return PI_APPROVAL_OPTION_ALLOW_ALWAYS;
    case "decline":
      return PI_APPROVAL_OPTION_DENY;
    case "cancel":
    default:
      return null;
  }
}

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly error?: string;
  readonly data?: unknown;
}

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

export interface PiRpcHandle {
  readonly request: (
    command: Record<string, unknown>,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<PiRpcResponse, PiRuntimeError>;
  readonly notify: (payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly events: Queue.Dequeue<PiRpcEvent>;
  readonly exitCode: Effect.Effect<number>;
}

function asPiRpcResponse(
  value: Record<string, unknown>,
): (PiRpcResponse & { readonly id: string }) | null {
  return value.type === "response" && typeof value.id === "string"
    ? (value as unknown as PiRpcResponse & { readonly id: string })
    : null;
}

export interface SpawnPiRpcInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
  readonly sessionName?: string;
  readonly modelSlug?: string;
  readonly thinkingLevel?: string;
  readonly approvalExtensionPath?: string;
}

export const spawnPiRpcSession = (
  input: SpawnPiRpcInput,
): Effect.Effect<
  PiRpcHandle,
  PiRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const parsedModel = parsePiModelSlug(input.modelSlug);

    const args = [
      "--mode",
      "rpc",
      ...(input.sessionName ? ["--name", input.sessionName] : []),
      ...(parsedModel ? ["--provider", parsedModel.provider, "--model", parsedModel.modelId] : []),
      ...(input.thinkingLevel ? ["--thinking", input.thinkingLevel] : []),
      ...(input.approvalExtensionPath && input.runtimeMode !== "full-access"
        ? ["--extension", input.approvalExtensionPath]
        : []),
    ];
    const environment = {
      ...input.environment,
      [PI_RUNTIME_MODE_ENV]: input.runtimeMode,
    };
    const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, args, {
      env: environment,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PiRuntimeError({
            operation: "spawnPiRpcSession",
            detail: `Failed to resolve Pi spawn command: ${piRuntimeErrorDetail(cause)}`,
            cause,
          }),
      ),
    );

    const stdinQueue = yield* Queue.unbounded<string>();
    const events = yield* Queue.unbounded<PiRpcEvent>();
    const pending = new Map<string, Deferred.Deferred<PiRpcResponse, PiRuntimeError>>();
    let requestSequence = 0;

    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          cwd: input.cwd,
          env: environment,
          ...(input.environment === undefined ? { extendEnv: true } : {}),
          stdin: {
            stream: Stream.encodeText(Stream.fromQueue(stdinQueue)),
          },
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new PiRuntimeError({
              operation: "spawnPiRpcSession",
              detail: `Failed to spawn Pi RPC process: ${piRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );

    const failPending = (detail: string) =>
      Effect.sync(() => {
        const inflight = [...pending.values()];
        pending.clear();
        return inflight;
      }).pipe(
        Effect.flatMap((inflight) =>
          Effect.forEach(
            inflight,
            (deferred) =>
              Deferred.fail(deferred, new PiRuntimeError({ operation: "request", detail })).pipe(
                Effect.ignore,
              ),
            { discard: true },
          ),
        ),
      );

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        yield* failPending("Pi RPC session closed.");
        yield* Queue.shutdown(stdinQueue);
        yield* Queue.shutdown(events);
      }),
    );

    const handleLine = (line: string) =>
      Effect.gen(function* () {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (trimmed.length === 0) return;
        const decoded = decodeJsonStringExit(trimmed);
        if (Exit.isFailure(decoded)) return;
        const parsed = decoded.value;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof (parsed as { type?: unknown }).type !== "string"
        ) {
          return;
        }
        const record = parsed as Record<string, unknown> & { type: string };
        const response = asPiRpcResponse(record);
        if (response) {
          const deferred = pending.get(response.id);
          if (deferred) {
            pending.delete(response.id);
            yield* Deferred.succeed(deferred, response).pipe(Effect.ignore);
          }
          return;
        }
        yield* Queue.offer(events, record).pipe(Effect.ignore);
      });

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(handleLine),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));

    const exitCode = child.exitCode.pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => -1),
    );

    const request: PiRpcHandle["request"] = (command, options) =>
      Effect.gen(function* () {
        requestSequence += 1;
        const id = `t3-${requestSequence}`;
        const deferred = yield* Deferred.make<PiRpcResponse, PiRuntimeError>();
        pending.set(id, deferred);
        yield* Queue.offer(stdinQueue, `${encodeJsonLine({ ...command, id })}\n`);
        const response = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: options?.timeoutMs ?? DEFAULT_PI_REQUEST_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new PiRuntimeError({
                  operation: String(command.type ?? "request"),
                  detail: `Timed out waiting for Pi response to '${String(command.type)}'.`,
                }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
        if (!response.success) {
          return yield* new PiRuntimeError({
            operation: String(command.type ?? "request"),
            detail: response.error ?? `Pi command '${response.command}' failed.`,
          });
        }
        return response;
      });

    const notify: PiRpcHandle["notify"] = (payload) =>
      Queue.offer(stdinQueue, `${encodeJsonLine(payload)}\n`).pipe(Effect.asVoid);

    return { request, notify, events, exitCode } satisfies PiRpcHandle;
  });
