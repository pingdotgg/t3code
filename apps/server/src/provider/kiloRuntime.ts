import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createKiloClient,
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
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";

const KILO_SERVER_READY_PREFIX = "kilo server listening";
const DEFAULT_KILO_SERVER_TIMEOUT_MS = 10_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const KILO_EMPTY_CONFIG_CONTENT = "{}";

export interface KiloServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface KiloServerConnection extends KiloServerProcess {
  readonly external: false;
}

const KILO_RUNTIME_ERROR_TAG = "KiloRuntimeError";
export class KiloRuntimeError extends Data.TaggedError(KILO_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (value: unknown): value is KiloRuntimeError =>
    P.isTagged(value, KILO_RUNTIME_ERROR_TAG);
}

export function kiloRuntimeErrorDetail(cause: unknown): string {
  if (KiloRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

export const runKiloSdk = <A>(operation: string, fn: () => Promise<A>) =>
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

export interface KiloRuntimeShape {
  readonly startServer: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  }) => Effect.Effect<KiloServerConnection, KiloRuntimeError, Scope.Scope>;
  readonly runCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<KiloCommandResult, KiloRuntimeError>;
  readonly createClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
  }) => KiloClient;
  readonly loadInventory: (
    client: KiloClient,
  ) => Effect.Effect<ProviderListResponse, KiloRuntimeError>;
}

function parseServerUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(KILO_SERVER_READY_PREFIX)) continue;
    return line.match(/on\s+(https?:\/\/[^\s]+)/)?.[1] ?? null;
  }
  return null;
}

export function parseKiloModelSlug(slug: string | null | undefined) {
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, separator), modelID: trimmed.slice(separator + 1) };
}

export function toKiloFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];
  for (const attachment of input.attachments ?? []) {
    const path = input.resolveAttachmentPath(attachment);
    if (!path) continue;
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(path).href,
    });
  }
  return parts;
}

export function buildKiloPermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }
  if (runtimeMode === "auto-accept-edits") {
    return [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "patch", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
    ];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toKiloPermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  if (decision === "accept") return "once";
  if (decision === "acceptForSession") return "always";
  return "reject";
}

export function kiloQuestionId(index: number, question: QuestionRequest["questions"][number]) {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header ? `question-${index}-${header}` : `question-${index}`;
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
    if (Array.isArray(raw))
      return raw.filter((value): value is string => typeof value === "string");
    return typeof raw === "string" && raw.trim() ? [raw] : [];
  });
}

const makeKiloRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const platform = yield* HostProcessPlatform;

  const runCommand: KiloRuntimeShape["runCommand"] = (input) =>
    Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(
        input.binaryPath,
        input.args,
        input.environment ? { env: input.environment } : {},
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          shell: spawn.shell,
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
          operation: "runCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return { stdout, stderr, code: exitCode };
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        KiloRuntimeError.is(cause)
          ? cause
          : new KiloRuntimeError({
              operation: "runCommand",
              detail: `Failed to execute Kilo: ${kiloRuntimeErrorDetail(cause)}`,
              cause,
            }),
      ),
    );

  const startServer: KiloRuntimeShape["startServer"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const hostname = DEFAULT_HOSTNAME;
      const port = yield* net.findAvailablePort(0).pipe(
        Effect.mapError(
          (cause) =>
            new KiloRuntimeError({
              operation: "startServer",
              detail: `Failed to find available port: ${kiloRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawn = yield* resolveSpawnCommand(
        input.binaryPath,
        args,
        input.environment ? { env: input.environment } : {},
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            detached: platform !== "win32",
            shell: spawn.shell,
            env: { ...input.environment, KILO_CONFIG_CONTENT: KILO_EMPTY_CONFIG_CONTENT },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new KiloRuntimeError({
                operation: "startServer",
                detail: `Failed to spawn Kilo server: ${kiloRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killGroup = (signal: NodeJS.Signals) =>
        platform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // Process already exited.
              }
            });
      yield* Scope.addFinalizer(
        scope,
        killGroup("SIGTERM").pipe(
          Effect.andThen(Effect.sleep("1 second")),
          Effect.andThen(killGroup("SIGKILL")),
          Effect.ignore,
        ),
      );

      const stdout = yield* Ref.make("");
      const stderr = yield* Ref.make("");
      const ready = yield* Deferred.make<string, KiloRuntimeError>();
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.updateAndGet(stdout, (value) => value + chunk).pipe(
            Effect.flatMap((value) => {
              const url = parseServerUrl(value);
              return url ? Deferred.succeed(ready, url).pipe(Effect.ignore) : Effect.void;
            }),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderr, (value) => value + chunk)),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.all({ stdout: Ref.get(stdout), stderr: Ref.get(stderr) }).pipe(
            Effect.flatMap((output) =>
              Deferred.fail(
                ready,
                new KiloRuntimeError({
                  operation: "startServer",
                  detail: `Kilo server exited before startup completed (code ${Number(code)}).\n${output.stderr || output.stdout}`,
                }),
              ).pipe(Effect.ignore),
            ),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      );

      const result = yield* Effect.exit(
        Deferred.await(ready).pipe(
          Effect.timeoutOption(input.timeoutMs ?? DEFAULT_KILO_SERVER_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(result)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const cause = Cause.squash(result.cause);
        return yield* KiloRuntimeError.is(cause)
          ? cause
          : new KiloRuntimeError({
              operation: "startServer",
              detail: kiloRuntimeErrorDetail(cause),
              cause,
            });
      }
      if (Option.isNone(result.value)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new KiloRuntimeError({
          operation: "startServer",
          detail: `Timed out waiting for Kilo server after ${input.timeoutMs ?? DEFAULT_KILO_SERVER_TIMEOUT_MS}ms.`,
        });
      }
      return {
        url: result.value.value,
        external: false as const,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      };
    });

  const createClient: KiloRuntimeShape["createClient"] = ({ baseUrl, directory }) =>
    createKiloClient({ baseUrl, directory, throwOnError: true });

  const loadInventory: KiloRuntimeShape["loadInventory"] = (client) =>
    runKiloSdk("provider.list", () => client.provider.list(undefined, { throwOnError: true })).pipe(
      Effect.filterMapOrFail(
        (result) =>
          result.data
            ? Result.succeed(result.data)
            : Result.fail(
                new KiloRuntimeError({
                  operation: "provider.list",
                  detail: "Kilo provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  return { startServer, runCommand, createClient, loadInventory } satisfies KiloRuntimeShape;
});

export class KiloRuntime extends Context.Service<KiloRuntime, KiloRuntimeShape>()(
  "t3/provider/kiloRuntime",
) {}

export const KiloRuntimeLive = Layer.effect(KiloRuntime, makeKiloRuntime).pipe(
  Layer.provide(NetService.layer),
);
