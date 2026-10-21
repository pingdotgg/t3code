import {
  CODEX_POOL_PROTOCOL,
  CodexPoolBindingState,
  CodexPoolPrepareRequest,
  CodexPoolQuotaDomain,
  CodexPoolReadyResult,
  type DelegatedLaunchBinding,
  type DelegatedQuotaScope,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type {
  DelegatedLaunchPool,
  DelegatedLaunchPoolPrepareOutcome,
} from "@t3tools/provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// The wrapper bounds stdin to 2 s, each HTTP call to 7 s and its credential
// helper to 25 s. A control call is never a generation request.
const CONTROL_TIMEOUT = "40 seconds";
const MAX_OUTPUT_BYTES = 16_384;
const READY_MAX_AGE_MS = 30_000;
const READY_CLOCK_SKEW_MS = 5_000;

export class CodexPoolControlError extends Schema.TaggedError<CodexPoolControlError>()(
  "CodexPoolControlError",
  { code: Schema.String },
) {}

const isCodexPoolControlError = Schema.is(CodexPoolControlError);
const isQuotaDomain = Schema.is(CodexPoolQuotaDomain);
const isPrepareRequest = Schema.is(CodexPoolPrepareRequest);

const strict = { onExcessProperty: "error" } as const;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ErrorEnvelope = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  error: Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-z_]{1,64}$/)) }),
});
const decodeErrorEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(ErrorEnvelope),
  strict,
);

const envelope = <Operation extends string, S extends Schema.Top>(
  operation: Operation,
  result: S,
) =>
  Schema.fromJsonString(
    Schema.Struct({
      protocolVersion: Schema.Literal(2),
      operation: Schema.Literal(operation),
      result,
    }),
  );

const OPERATIONS = ["capabilities", "prepare", "state", "touch", "release", "cancel", "resume"];
const Capabilities = Schema.Struct({
  controlOperations: Schema.Array(Schema.String),
  boundLaunch: Schema.Literal("app-server-stdio"),
  origin: Schema.String.check(Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/)),
  proxyProtocolVersion: Schema.Literal(2),
  supportsWebsockets: Schema.Literal(false),
  requestMaxRetries: Schema.Literal(0),
  streamMaxRetries: Schema.Literal(0),
});
const DeniedResult = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  status: Schema.Literals(["waiting", "unverified"]),
  checkedAt: Schema.String,
  expiresAt: Schema.String,
  ordinaryUsageAllowed: Schema.Literal(false),
  quotaDomains: Schema.Array(CodexPoolQuotaDomain),
  code: Schema.String,
  quotaScope: Schema.Literals(["account", "model", "unknown", "transient"]),
  windows: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const decoders = {
  capabilities: Schema.decodeUnknownOption(envelope("capabilities", Capabilities), strict),
  prepare: Schema.decodeUnknownOption(
    envelope("prepare", Schema.Union([CodexPoolReadyResult, DeniedResult])),
    strict,
  ),
  state: Schema.decodeUnknownOption(envelope("state", CodexPoolBindingState), strict),
  touch: Schema.decodeUnknownOption(
    envelope("touch", Schema.Struct({ status: Schema.Literal("active") })),
    strict,
  ),
  release: Schema.decodeUnknownOption(
    envelope("release", Schema.Struct({ status: Schema.Literal("released") })),
    strict,
  ),
  cancel: Schema.decodeUnknownOption(
    envelope("cancel", Schema.Struct({ status: Schema.Literal("released") })),
    strict,
  ),
  resume: Schema.decodeUnknownOption(
    envelope("resume", Schema.Struct({ status: Schema.Literal("acknowledged") })),
    strict,
  ),
};

export const launchAttemptKey = (domain: string) => `launch:attempt:${domain}`;
export type LaunchRefusalScope =
  | DelegatedQuotaScope
  | { readonly type: "candidate" }
  | { readonly type: "attempt"; readonly domain: string };

/**
 * Maps authenticated binding state to the admission block for a launch that
 * failed before useful work. `undefined` means an ordinary failure.
 */
export function classifyPoolRefusal(
  state: CodexPoolBindingState | undefined,
  nativeQuotaFailure: boolean,
): { readonly scope: LaunchRefusalScope; readonly domains?: ReadonlyArray<string> } | undefined {
  const refusal = state?.refusal;
  if (refusal) {
    switch (refusal.code) {
      case "usage_limit":
      case "model_quota":
      case "throttled":
        if (
          refusal.code === "throttled" &&
          refusal.quotaScope === "transient" &&
          refusal.attemptedAccountDomain
        )
          return { scope: { type: "attempt", domain: refusal.attemptedAccountDomain } };
        if (refusal.quotaScope === "account" && refusal.quotaDomains.length > 0)
          return { scope: { type: "account" }, domains: refusal.quotaDomains };
        if (refusal.quotaScope === "model" || refusal.quotaScope === "transient")
          return { scope: { type: "candidate" } };
        return { scope: { type: "account" } };
      case "model_capacity":
        return { scope: { type: "candidate" } };
      case "capacity_unverified":
      case "quota_unverified":
      case "binding_changed":
        return { scope: { type: "account" } };
      case "binding_invalid":
      case "binding_released":
      case "prepare_cancelled":
        return { scope: { type: "candidate" } };
      default:
        return undefined;
    }
  }
  // The lease vanished (expiry, proxy restart, revocation) before any work.
  if (state?.state === "released" || state?.state === "invalid")
    return { scope: { type: "candidate" } };
  return nativeQuotaFailure ? { scope: { type: "account" } } : undefined;
}

export interface CodexPoolLauncher {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs: string;
}

const boundPath = (bindingId: string, sessionId: string) =>
  `/v1/delegated-launch/bindings/${bindingId}/sessions/${sessionId}`;

/**
 * Deterministic per logical prepare: duplicates and restarts at the same
 * launch generation reuse the proxy's idempotent record, while a changed
 * candidate or blocked set is a new request rather than a conflict.
 */
export const codexPoolPrepareRequest = Effect.fn("CodexPoolControl.prepareRequest")(
  function* (input: {
    readonly runId: string;
    readonly generation: number;
    readonly instanceId: string;
    readonly model: string;
    readonly blockedQuotaDomains: ReadonlyArray<string>;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = (parts: ReadonlyArray<string | number>) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(encodeJson(parts)))
        .pipe(Effect.map((bytes) => Hex.encode(bytes).slice(0, 40)));
    const blockedQuotaDomains = [
      ...new Set(
        input.blockedQuotaDomains
          .map((key) =>
            key.startsWith("launch:attempt:") ? key.slice("launch:attempt:".length) : key,
          )
          .filter((domain) => isQuotaDomain(domain) && !domain.includes(":quota:")),
      ),
    ].toSorted();
    const scope = [input.runId, input.generation, input.instanceId, input.model];
    const request = {
      clientRequestId: `t3.${yield* digest(["request", ...scope, ...blockedQuotaDomains])}`,
      sessionId: `t3.${yield* digest(["session", ...scope])}`,
      provider: "codex" as const,
      model: input.model,
      blockedQuotaDomains,
    };
    // More blocked accounts than the proxy accepts cannot be expressed safely.
    return isPrepareRequest(request) ? request : undefined;
  },
);

export function validReadyBinding(
  request: CodexPoolPrepareRequest,
  result: CodexPoolReadyResult,
  now: number,
): boolean {
  const checkedAt = Date.parse(result.checkedAt);
  const expiresAt = Date.parse(result.expiresAt);
  return (
    result.basePath === boundPath(result.bindingId, result.sessionId) &&
    result.model === request.model &&
    result.sessionId === request.sessionId &&
    result.quotaDomains.every((domain) => !request.blockedQuotaDomains.includes(domain)) &&
    result.windows.every((w) => w.usedPercent < 100 && Date.parse(w.resetsAt) > now) &&
    now - checkedAt <= READY_MAX_AGE_MS &&
    checkedAt <= now + READY_CLOCK_SKEW_MS &&
    expiresAt > now &&
    expiresAt <= checkedAt + READY_MAX_AGE_MS
  );
}

/** `pool-launch` takes one nonsecret argv value; the key stays inside the wrapper. */
export function codexPoolLaunchArgs(binding: DelegatedLaunchBinding): ReadonlyArray<string> {
  return [
    "pool-launch",
    encodeJson({
      protocolVersion: 2,
      prepareRequest: binding.prepareRequest,
      binding: binding.result,
      // Effort and summary travel on each turn/start, as for ordinary sessions.
      options: {},
    }),
  ];
}

export const makeCodexPoolControl = Effect.fn("CodexPoolControl.make")(function* (
  launcher: CodexPoolLauncher,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const invoke = Effect.fn("CodexPoolControl.invoke")(
    function* (request: Record<string, unknown>) {
      const spawnCommand = yield* resolveSpawnCommand(launcher.binaryPath, ["pool-control"], {
        env: launcher.environment,
        extendEnv: true,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: launcher.environment,
          extendEnv: true,
          shell: spawnCommand.shell,
          forceKillAfter: "2 seconds",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.runFold(
              () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
              (acc, chunk) => {
                if (acc.size <= MAX_OUTPUT_BYTES) acc.chunks.push(chunk);
                acc.size += chunk.length;
                return acc;
              },
            ),
          ),
          // Wrapper diagnostics are not protocol; drain without retaining them.
          Stream.runDrain(child.stderr),
          child.exitCode,
          Stream.run(
            Stream.encodeText(Stream.make(encodeJson({ protocolVersion: 2, ...request }))),
            child.stdin,
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (stdout.size > MAX_OUTPUT_BYTES)
        return yield* new CodexPoolControlError({ code: "invalid_response" });
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout.chunks)).trim(),
        exitCode,
      };
    },
    Effect.scoped,
    Effect.timeout(CONTROL_TIMEOUT),
    Effect.mapError((cause) =>
      isCodexPoolControlError(cause)
        ? cause
        : new CodexPoolControlError({ code: "launcher_unavailable" }),
    ),
  );
  const call = <A>(
    operation: keyof typeof decoders,
    decode: (text: string) => Option.Option<{ readonly result: A }>,
    fields: Record<string, unknown> = {},
  ) =>
    invoke({ operation, ...fields }).pipe(
      Effect.flatMap(({ text, exitCode }) => {
        const decoded = exitCode === 0 ? decode(text) : undefined;
        if (decoded?._tag === "Some") return Effect.succeed(decoded.value.result);
        const error = decodeErrorEnvelope(text);
        return Effect.fail(
          new CodexPoolControlError({
            code: error._tag === "Some" ? error.value.error.code : "invalid_response",
          }),
        );
      }),
    );

  const binding = (b: DelegatedLaunchBinding) => ({
    bindingId: b.result.bindingId,
    basePath: b.result.basePath,
    sessionId: b.result.sessionId,
  });
  const succeeded = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("codex-t3 pool control failed", { cause }).pipe(Effect.as(false)),
      ),
    );

  const capabilities = call("capabilities", decoders.capabilities).pipe(
    Effect.map(
      (result) =>
        OPERATIONS.every((operation) => result.controlOperations.includes(operation)) &&
        // Extra launcher arguments cannot reach a bound native process.
        launcher.launchArgs.trim() === "",
    ),
    Effect.orElseSucceed(() => false),
  );

  const pool: DelegatedLaunchPool = {
    prepare: Effect.fn("CodexPoolControl.prepare")(function* (input) {
      const request = yield* codexPoolPrepareRequest({
        ...input,
        instanceId: launcher.instanceId,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.orElseSucceed(() => undefined),
      );
      if (!request || !(yield* capabilities)) return { status: "unverified" } as const;
      const result = yield* call("prepare", decoders.prepare, { request }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!result) return { status: "unverified" } as const;
      if (result.status === "ready") {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        return validReadyBinding(request, result, now)
          ? ({
              status: "ready",
              binding: {
                protocol: CODEX_POOL_PROTOCOL,
                instanceId: launcher.instanceId,
                prepareRequest: request,
                result,
              },
            } satisfies DelegatedLaunchPoolPrepareOutcome)
          : ({ status: "unverified" } as const);
      }
      // Only verified account exhaustion names domains that block all models.
      return result.status === "waiting" &&
        result.code === "usage_limit" &&
        result.quotaScope === "account" &&
        result.quotaDomains.length > 0
        ? ({ status: "waiting", quotaDomains: result.quotaDomains } as const)
        : ({ status: "unverified" } as const);
    }),
    state: (b) =>
      call("state", decoders.state, { binding: binding(b) }).pipe(
        Effect.map((state) =>
          (state.refusal?.bindingId !== undefined &&
            state.refusal.bindingId !== b.result.bindingId) ||
          (state.refusal?.attemptedAccountDomain !== undefined &&
            !b.result.quotaDomains.includes(state.refusal.attemptedAccountDomain))
            ? undefined
            : state,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("codex-t3 pool state unavailable", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    touch: (b) => succeeded(call("touch", decoders.touch, { binding: binding(b) })),
    release: (b) => succeeded(call("release", decoders.release, { binding: binding(b) })),
    resume: (b, expectedRefusalVersion) =>
      expectedRefusalVersion > 0
        ? succeeded(
            call("resume", decoders.resume, { binding: binding(b), expectedRefusalVersion }),
          )
        : Effect.succeed(false),
    cancel: (clientRequestId) => succeeded(call("cancel", decoders.cancel, { clientRequestId })),
  };
  return pool;
});
