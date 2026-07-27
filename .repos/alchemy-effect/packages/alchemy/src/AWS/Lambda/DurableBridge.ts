/**
 * Internal scaffolding for AWS Lambda Durable Functions — NOT exported from
 * the Lambda service `index.ts`.
 *
 * A function created with `DurableConfig` receives every invocation as a
 * dedicated durable-execution envelope (`DurableExecutionInvocationInput`):
 * the customer payload rides inside the checkpoint log's EXECUTION operation,
 * and the handler must speak the checkpoint/replay protocol
 * (`CheckpointDurableExecution` / `GetDurableExecutionState`) and return a
 * `SUCCEEDED | FAILED | PENDING` envelope.
 *
 * Alchemy owns the Lambda entrypoint, so this protocol is routed exactly like
 * an event source: {@link isDurableExecutionEvent} is the shape predicate
 * (the `isSQSEvent` analogue) and {@link makeDurableListener} produces the
 * `host.listen` listener that drives the orchestrator. The replay engine
 * itself is AWS's open-source `@aws/durable-execution-sdk-js`
 * (`withDurableExecution`), wrapped behind the Effect-native `DurableStep`
 * service — the same posture as the Cloudflare `WorkflowBridge` wrapping the
 * native `step` object.
 *
 * The SDK module is loaded with a dynamic `import()` so it never loads at
 * plan/deploy time. The `DurableFunction` wrapper merges it into
 * `build.install` automatically, which both vendors it into the artifact's
 * `node_modules` and externalizes it from the bundle (install roots are
 * always external) — plain Functions never resolve it.
 */
import type * as lambda from "aws-lambda";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { isScopeEjected } from "../../Http.ts";
import type * as Serverless from "../../Serverless/index.ts";
import { toSeconds } from "../../Util/Duration.ts";
import {
  DurableExecutionContext,
  DurableStep,
  type DurableCallbackOptions,
  type DurableRetryPolicy,
  type DurableStepOptions,
} from "./Durable.ts";
import { HandlerContext } from "./Function.ts";

/** Module id of AWS's Durable Execution SDK (an optional peer dependency). */
export const DURABLE_SDK_MODULE = "@aws/durable-execution-sdk-js";

// ---------------------------------------------------------------------------
// The durable invocation envelope
// ---------------------------------------------------------------------------

/**
 * Raw invocation payload delivered to a `DurableConfig`-enabled function.
 * Mirrors the SDK's `DurableExecutionInvocationInput`.
 */
export interface DurableExecutionInvocationEvent {
  DurableExecutionArn: string;
  CheckpointToken: string;
  UpdatedOperationIds?: string[];
  InitialExecutionState: {
    Operations?: {
      Type?: string;
      ExecutionDetails?: { InputPayload?: string };
    }[];
    NextMarker?: string;
  };
}

/**
 * Shape predicate for durable-execution invocations — the durable analogue of
 * `isSQSEvent`. A durable function's invocations always arrive in this
 * envelope (the durable execution wraps even the first invocation).
 */
export const isDurableExecutionEvent = (
  event: any,
): event is DurableExecutionInvocationEvent =>
  typeof event === "object" &&
  event !== null &&
  typeof event.DurableExecutionArn === "string" &&
  typeof event.CheckpointToken === "string" &&
  typeof event.InitialExecutionState === "object" &&
  event.InitialExecutionState !== null;

// ---------------------------------------------------------------------------
// The alchemy payload envelope (multi-workflow routing)
// ---------------------------------------------------------------------------

/**
 * Lambda has a single exported handler (unlike workerd's named class
 * exports), so when several DurableFunctions share one host the start payload
 * carries a discriminator. Alchemy owns both ends — the `start` client wraps
 * the params, the listener unwraps them — so user code never sees this.
 */
export interface DurableEnvelope {
  $alchemy: { workflow: string };
  params: unknown;
}

export const encodeDurableEnvelope = (
  workflow: string,
  params: unknown,
): string =>
  JSON.stringify({ $alchemy: { workflow }, params } satisfies DurableEnvelope);

const asDurableEnvelope = (payload: unknown): DurableEnvelope | undefined =>
  typeof payload === "object" &&
  payload !== null &&
  "$alchemy" in payload &&
  typeof (payload as DurableEnvelope).$alchemy === "object" &&
  (payload as DurableEnvelope).$alchemy !== null &&
  typeof (payload as DurableEnvelope).$alchemy.workflow === "string"
    ? (payload as DurableEnvelope)
    : undefined;

/**
 * Extract the customer input payload from the checkpoint log's EXECUTION
 * operation (first page — the EXECUTION operation is always the log's first
 * entry, so pagination never hides it).
 */
export const readDurableInputPayload = (
  event: DurableExecutionInvocationEvent,
): unknown => {
  const operations = event.InitialExecutionState?.Operations ?? [];
  const execution = operations.find((op) => op?.Type === "EXECUTION");
  const raw = execution?.ExecutionDetails?.InputPayload;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

// ---------------------------------------------------------------------------
// Native SDK surface (structural types only — the SDK's own types never leak
// into alchemy's public d.ts, keeping the dependency optional)
// ---------------------------------------------------------------------------

interface NativeRetryDecision {
  shouldRetry: boolean;
  delay?: { seconds: number };
}

interface NativeStepConfig {
  retryStrategy?: (error: Error, attemptCount: number) => NativeRetryDecision;
  semantics?: string;
}

interface NativeDurableContext {
  lambdaContext: lambda.Context;
  executionContext: { readonly durableExecutionArn: string };
  step<T>(
    name: string,
    fn: (stepContext: unknown) => Promise<T>,
    config?: NativeStepConfig,
  ): Promise<T>;
  wait(name: string, duration: { seconds: number }): Promise<void>;
  waitForCallback<T>(
    name: string,
    submitter: (callbackId: string, context: unknown) => Promise<void>,
    config?: {
      timeout?: { seconds: number };
      heartbeatTimeout?: { seconds: number };
    },
  ): Promise<T>;
}

interface NativeDurableSdk {
  withDurableExecution: (
    handler: (event: any, context: NativeDurableContext) => Promise<any>,
  ) => (event: any, context: lambda.Context) => Promise<any>;
}

/**
 * Load the Durable Execution SDK. The module id is an install root of every
 * DurableFunction bundle (the wrapper merges it into `build.install`), so
 * resolution happens at runtime inside the sandbox — from the artifact's
 * vendored `node_modules`, otherwise from the managed runtime's bundled
 * copy.
 */
const loadDurableSdk: Effect.Effect<NativeDurableSdk> = Effect.promise(
  () => import(DURABLE_SDK_MODULE) as Promise<NativeDurableSdk>,
).pipe(
  Effect.catchDefect((defect) =>
    Effect.die(
      new Error(
        `Failed to load "${DURABLE_SDK_MODULE}" — install it in the project ` +
          `that defines the DurableFunction (npm i ${DURABLE_SDK_MODULE}) so ` +
          `the bundler can vendor it into the artifact.`,
        { cause: defect },
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// DurableStep over the native DurableContext
// ---------------------------------------------------------------------------

const toNativeRetryStrategy = (
  retry: DurableRetryPolicy,
): ((error: Error, attemptCount: number) => NativeRetryDecision) => {
  const base = toSeconds(retry.delay) ?? 1;
  const cap = toSeconds(retry.maxDelay);
  const backoff = retry.backoff ?? "exponential";
  return (_error, attemptCount) => {
    if (attemptCount > retry.limit) {
      return { shouldRetry: false };
    }
    const raw =
      backoff === "constant"
        ? base
        : backoff === "linear"
          ? base * attemptCount
          : base * 2 ** Math.max(0, attemptCount - 1);
    const seconds = Math.max(1, Math.ceil(cap ? Math.min(raw, cap) : raw));
    return { shouldRetry: true, delay: { seconds } };
  };
};

const toNativeStepConfig = (
  options: DurableStepOptions<any>,
): NativeStepConfig | undefined => {
  if (!options.retry && !options.semantics) return undefined;
  return {
    ...(options.retry
      ? { retryStrategy: toNativeRetryStrategy(options.retry) }
      : {}),
    ...(options.semantics
      ? {
          semantics:
            options.semantics === "at-most-once"
              ? "AT_MOST_ONCE_PER_RETRY"
              : "AT_LEAST_ONCE_PER_RETRY",
        }
      : {}),
  };
};

const wrapDurableContext = (
  dctx: NativeDurableContext,
): DurableStep["Service"] => ({
  step: <T>(options: DurableStepOptions<T>) =>
    Effect.tryPromise(() =>
      dctx.step<T>(
        options.name,
        () => Effect.runPromise(options.effect),
        toNativeStepConfig(options),
      ),
    ).pipe(Effect.orDie),
  wait: (name, duration) =>
    Effect.tryPromise(() =>
      dctx.wait(name, { seconds: Math.max(1, toSeconds(duration) ?? 1) }),
    ).pipe(Effect.orDie),
  waitForCallback: <T>(options: DurableCallbackOptions) =>
    Effect.tryPromise(() =>
      dctx.waitForCallback<T>(
        options.name,
        (callbackId) => Effect.runPromise(options.submitter(callbackId)),
        {
          ...(options.timeout !== undefined
            ? { timeout: { seconds: toSeconds(options.timeout)! } }
            : {}),
          ...(options.heartbeatTimeout !== undefined
            ? {
                heartbeatTimeout: {
                  seconds: toSeconds(options.heartbeatTimeout)!,
                },
              }
            : {}),
        },
      ),
    ).pipe(Effect.orDie),
});

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * Build the `host.listen` listener that drives one named durable orchestrator.
 *
 * The listener recognizes the durable envelope, peeks the alchemy payload
 * envelope to decline invocations addressed to a different DurableFunction on
 * the same host, and otherwise hands the raw event to the SDK's
 * `withDurableExecution` wrapper. The wrapper loads/replays the checkpoint
 * log and calls back into the Effect body with a fresh per-invocation `Scope`
 * and the `DurableStep`/`DurableExecutionContext` services.
 */
type WrappedDurableHandler = (
  event: any,
  context: lambda.Context,
) => Promise<any>;

export const makeDurableListener = (options: {
  name: string;
  run: (input: unknown) => Effect.Effect<unknown>;
}): Effect.Effect<Serverless.FunctionListener> =>
  // `Effect.sync`, NOT `Effect.gen` yielding `loadDurableSdk`: the listener is
  // CONSTRUCTED when the host resolves `runtimeContext.exports`, which happens
  // at PLAN/DEPLOY time (`Platform.ts` does `yield* runtimeContext.exports`).
  // Importing `@aws/durable-execution-sdk-js` there both contradicts the "never
  // at plan time" contract and stalls the deploy (the SDK's module init
  // touches the AWS client). Defer the load to the first real invocation and
  // memoize it.
  Effect.sync(() => {
    // Bind the SDK-wrapped handler once, on first invocation, and reuse it.
    let wrapped: WrappedDurableHandler | undefined;
    const ensureWrapped: Effect.Effect<WrappedDurableHandler> = Effect.suspend(
      () =>
        wrapped !== undefined
          ? Effect.succeed(wrapped)
          : loadDurableSdk.pipe(
              Effect.map((sdk) => {
                wrapped = sdk.withDurableExecution(async (event, dctx) => {
                  // The SDK extracts the customer payload from the EXECUTION
                  // operation and hands it to us on every (re-)invocation.
                  const envelope = asDurableEnvelope(event);
                  const params =
                    envelope !== undefined ? envelope.params : event;

                  // Fresh request scope per durable invocation, matching the
                  // Lambda dispatcher / Worker / Workflow bridges.
                  const scope = Scope.makeUnsafe();
                  const exit = await Effect.runPromiseExit(
                    options.run(params).pipe(
                      Effect.provide(
                        Layer.mergeAll(
                          Layer.succeed(DurableStep, wrapDurableContext(dctx)),
                          Layer.succeed(DurableExecutionContext, {
                            executionArn:
                              dctx.executionContext.durableExecutionArn,
                          }),
                          Layer.succeed(HandlerContext, dctx.lambdaContext),
                          Layer.succeed(Scope.Scope, scope),
                        ),
                      ),
                    ),
                  );
                  if (!isScopeEjected(scope)) {
                    await Scope.close(scope, exit).pipe(
                      Effect.ignoreCause({
                        log: "Warn",
                        message: "Durable invocation scope close failed",
                      }),
                      Effect.runPromise,
                    );
                  }
                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }
                  throw Cause.squash(exit.cause);
                });
                return wrapped;
              }),
            ),
    );

    // `HandlerContext` is a runtime-only requirement satisfied unconditionally
    // by the Lambda dispatcher, which provides it (and `Scope`) to every
    // listener's returned effect. Cast the listener down to the `Req = never`
    // `FunctionListener` so the requirement never leaks into the host's init
    // effect — the exact contract `serve`/`makeFunctionHttpHandler` rely on.
    return ((event: any) => {
      if (!isDurableExecutionEvent(event)) return;
      const payload = readDurableInputPayload(event);
      const envelope = asDurableEnvelope(payload);
      if (
        envelope !== undefined &&
        envelope.$alchemy.workflow !== options.name
      ) {
        // Addressed to another DurableFunction on this host — decline so its
        // listener picks it up.
        return;
      }
      return Effect.gen(function* () {
        const context = yield* HandlerContext;
        // Lazily load + memoize the SDK on the first real invocation.
        const run = yield* ensureWrapped;
        // The SDK owns the checkpoint protocol from here: it replays the log,
        // runs new work, and returns the SUCCEEDED/FAILED/PENDING envelope
        // Lambda interprets. A rejection here is a protocol-level failure —
        // let it surface as an invocation error.
        return yield* Effect.promise(() => run(event, context));
      });
    }) as unknown as Serverless.FunctionListener;
  });
