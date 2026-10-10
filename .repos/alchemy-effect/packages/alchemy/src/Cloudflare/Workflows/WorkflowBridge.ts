import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Base64, Base64Url } from "effect/encoding";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { encodeRpcError } from "../../Rpc.ts";
import { buildEventTelemetry } from "../../TelemetryRuntime.ts";
import { isScopeEjected } from "../Workers/HttpServer.ts";
import { getWorkerExport } from "../Workers/WorkerBridge.ts";
import type {
  WorkflowExport,
  WorkflowImpl,
  WorkflowStepConfig,
  WorkflowStepEvent,
  WorkflowTaskOptions,
} from "./Workflow.ts";
import {
  WorkflowEvent as WorkflowEventService,
  WorkflowStep,
  WorkflowStepContext,
} from "./WorkflowRuntime.ts";

/**
 * Create a WorkflowBridge class that extends `WorkflowEntrypoint` and
 * delegates the `run(event, step)` call to the Effect-native workflow body
 * registered via `worker.export(...)`.
 *
 * The bridge provides `WorkflowEvent` and `WorkflowStep` as Effect
 * services so the user writes `yield* WorkflowEvent` and `yield* task(...)`
 * instead of receiving callback parameters.
 */
export const makeWorkflowBridge =
  (
    WorkflowEntrypoint: abstract new (
      ctx: unknown,
      env: unknown,
    ) => { run(event: any, step: any): Promise<unknown> },
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: { name: string; stage: string };
    },
  ) =>
  (className: string) => {
    // One isolate-lifetime layer build shared by every instantiation of this
    // workflow class — `build` memoizes the built context.
    const { build } = getWorkerExport<WorkflowExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    return class WorkflowBridge extends WorkflowEntrypoint {
      readonly build: Promise<{
        readonly context: Context.Context<never>;
        readonly fn: WorkflowImpl<unknown, unknown, unknown>;
        readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
      }>;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);

        this.build = build(() => {}).then(
          ({ context, export: wf, telemetry }) =>
            wf.make(env).pipe(
              Effect.provideContext(context),
              Effect.map((fn) => ({
                context,
                fn: fn as WorkflowImpl<unknown, unknown, unknown>,
                telemetry,
              })),
              Effect.runPromise,
            ),
        );
      }

      async run(event: any, step: any): Promise<unknown> {
        const { context, fn, telemetry } = await this.build;
        // The run scope owns telemetry and resources outside tasks.
        // Step attempts and rollback handlers use separate scopes.
        const scope = Scope.makeUnsafe();
        const exit = await Effect.runPromiseExit(
          fn(event.payload).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEventService, wrapWorkflowEvent(event)),
                Layer.succeed(
                  WorkflowStep,
                  wrapWorkflowStep(step, {
                    workflow: JSON.stringify([
                      stack.name,
                      stack.stage,
                      className,
                      event.workflowName ?? "",
                    ]),
                    instanceId: event.instanceId,
                  }),
                ),
                Layer.succeed(Scope.Scope, scope),
                // The configured telemetry exporters, attached to the run's
                // scope by `buildEventTelemetry` so buffered telemetry
                // flushes when the scope closes at the end of the
                // run-invocation.
                Layer.effectContext(
                  buildEventTelemetry(context, scope, telemetry()),
                ),
              ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
            ),
          ) as Effect.Effect<unknown, unknown>,
        );
        // Settle the run's resources with its real exit, unless a binding
        // ejected the scope to outlive the invocation. The workflow runtime has
        // no `waitUntil` to detach cleanup to, so close inline — a failing
        // finalizer (e.g. a pg pool `end()` on a dropped connection) is logged
        // and ignored so it can't mask the run's outcome.
        if (!isScopeEjected(scope)) {
          await Scope.close(scope, exit).pipe(
            Effect.ignoreCause({
              log: "Warn",
              message: "Workflow run scope close failed",
            }),
            Effect.runPromise,
          );
        }
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      }
    };
  };

const wrapWorkflowEvent = (event: any): WorkflowEventService["Service"] => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
  workflowName: event.workflowName ?? "",
  schedule: event.schedule ?? undefined,
});

interface WorkflowIdentity {
  readonly workflow: string;
  readonly instanceId: string;
}

export const wrapWorkflowStep = (
  step: any,
  identity?: WorkflowIdentity,
): WorkflowStep["Service"] => ({
  do: <T, E>(
    options: WorkflowTaskOptions<T, any, any, E>,
  ): Effect.Effect<T, E> => {
    const { name } = options;
    // `task` provides application services; the bridge supplies attempt-local services.
    const effect = options.effect as Effect.Effect<
      T,
      E,
      WorkflowStepContext | Scope.Scope
    >;
    const config = definedStepConfig(options);
    const rollbackEffect = options.rollback;
    const rollback = rollbackEffect
      ? {
          // Native compensation may run after this step and the run scope have closed.
          rollback: async (context: any) => {
            const exit = await Effect.runPromiseExit(
              Effect.scoped(
                rollbackEffect({
                  error: context.error,
                  output: context.output,
                }) as Effect.Effect<void, unknown, Scope.Scope>,
              ),
            );
            if (Exit.isFailure(exit))
              throw await callbackFailure(exit.cause, name, identity);
          },
          rollbackConfig: definedStepConfig(options.rollbackConfig),
        }
      : undefined;
    return Effect.scoped(
      Effect.gen(function* () {
        // Join active callbacks on interruption, without waiting through native retry delays.
        const runPromise = yield* FiberSet.makeRuntimePromise<
          never,
          Exit.Exit<T, E>
        >();
        let failure: { message: string; cause: Cause.Cause<E> } | undefined;
        const callback = async (context: any) => {
          const exit = await runPromise(
            effect.pipe(
              Effect.provideService(WorkflowStepContext, {
                step: context.step,
                attempt: context.attempt,
                config: context.config,
              }),
              Effect.scoped,
              Effect.exit,
            ),
          );
          if (Exit.isSuccess(exit)) return exit.value;
          const error = await callbackFailure(exit.cause, name, identity);
          // Native RPC/storage discard custom fields. Correlate only this invocation's error.
          if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
            failure = { message: error.message, cause: exit.cause };
          }
          throw error;
        };
        return yield* Effect.tryPromise<T, unknown>({
          try: () => {
            if (config && rollback)
              return step.do(name, config, callback, rollback);
            if (config) return step.do(name, config, callback);
            if (rollback) return step.do(name, callback, rollback);
            return step.do(name, callback);
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            failure &&
            error instanceof Error &&
            error.name === "Error" &&
            error.message === failure.message
              ? Effect.failCause(failure.cause)
              : Effect.promise(() =>
                  decodeApplicationFailure<E>(error, name, identity),
                ).pipe(
                  Effect.flatMap((cause) =>
                    cause ? Effect.failCause(cause) : Effect.die(error),
                  ),
                ),
          ),
        );
      }),
    );
  },
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleepUntil(name, timestamp)),
  waitForEvent: <T>(
    name: string,
    options: any,
  ): Effect.Effect<WorkflowStepEvent<T>> =>
    Effect.promise(
      () => step.waitForEvent(name, options) as Promise<WorkflowStepEvent<T>>,
    ),
});

const failurePrefix = "[alchemy-workflow-failure:v1]";
const terminalPrefix = "[alchemy-workflow-terminal:v1]";
const maxFailureLength = 16_384;

const terminalFailure = async (message: string): Promise<Error> => {
  const { NonRetryableError } = await import("cloudflare:workflows");
  return new NonRetryableError(`${terminalPrefix}${message}`);
};

const callbackFailure = async <E>(
  cause: Cause.Cause<E>,
  step: string,
  identity: WorkflowIdentity | undefined,
): Promise<Error> => {
  if (!Cause.hasDies(cause) && !Cause.hasInterrupts(cause)) {
    try {
      const budget = { nodes: 0, seen: new Set<object>() };
      const errors = cause.reasons.map((reason) => {
        if (reason._tag !== "Fail")
          throw new TypeError("Expected an application failure");
        return encodeFailureValue(reason.error, new Set<object>(), budget);
      });
      const error = Cause.squash(cause);
      const summary =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Workflow application failure";
      const body = `${Base64Url.encode(
        JSON.stringify({
          workflow: identity?.workflow ?? null,
          instanceId: identity?.instanceId ?? null,
          step,
          errors,
        }),
      )}\n${summary}`;
      const message = `${failurePrefix}${await failureDigest(body)}:${body}`;
      if (new TextEncoder().encode(message).byteLength > maxFailureLength)
        throw new TypeError("encoded failure exceeds 16 KiB");
      return new Error(message);
    } catch (error) {
      throw await terminalFailure(
        `Workflow application failure is not serializable: ${error instanceof Error ? error.message : "unsupported value"}`,
      );
    }
  }
  const error = Cause.squash(cause);
  return terminalFailure(
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Workflow callback defect or interruption",
  );
};

const failureDigest = async (body: string): Promise<string> =>
  Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  );

const decodeApplicationFailure = async <E>(
  error: unknown,
  step: string,
  identity: WorkflowIdentity | undefined,
): Promise<Cause.Cause<E> | undefined> => {
  if (
    !identity?.workflow ||
    !identity.instanceId ||
    !(error instanceof Error) ||
    error.name !== "Error" ||
    !error.message.startsWith(failurePrefix)
  )
    return undefined;
  try {
    if (new TextEncoder().encode(error.message).byteLength > maxFailureLength)
      throw new TypeError("encoded failure exceeds 16 KiB");
    const encoded = error.message.slice(failurePrefix.length);
    const separator = encoded.indexOf(":");
    const digest = encoded.slice(0, separator);
    const body = encoded.slice(separator + 1);
    if (separator !== 43 || digest !== (await failureDigest(body)))
      throw new TypeError("invalid failure checksum");
    const end = body.indexOf("\n");
    if (end < 1) throw new TypeError("invalid failure framing");
    const json = Base64Url.decodeString(body.slice(0, end));
    if (Result.isFailure(json)) throw new TypeError("invalid failure encoding");
    const envelope: unknown = JSON.parse(json.success);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("workflow" in envelope) ||
      envelope.workflow !== identity.workflow ||
      !("instanceId" in envelope) ||
      envelope.instanceId !== identity.instanceId ||
      !("step" in envelope) ||
      envelope.step !== step ||
      !("errors" in envelope) ||
      !Array.isArray(envelope.errors) ||
      envelope.errors.length === 0 ||
      Object.keys(envelope).length !== 4
    )
      throw new TypeError("invalid failure envelope");
    // Only the validated private transport restores E's data; prototypes and identity are invocation-local.
    const errors = envelope.errors.map((value) =>
      decodeFailureValue(value),
    ) as E[];
    return Cause.fromReasons(
      errors.map((value) => Cause.makeFailReason(value)),
    );
  } catch (cause) {
    throw new TypeError("Invalid persisted Workflow application failure", {
      cause,
    });
  }
};

type FailureValue = null | boolean | string | number | FailureValue[];

const encodeFailureValue = (
  value: unknown,
  ancestors = new Set<object>(),
  budget = { nodes: 0, seen: new Set<object>() },
): FailureValue => {
  if (
    ++budget.nodes > maxFailureLength ||
    (typeof value === "string" && value.length > maxFailureLength)
  )
    throw new TypeError("encoded failure exceeds 16 KiB");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (typeof value !== "object")
    throw new TypeError(`unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("cyclic error data");
  if (budget.seen.has(value))
    throw new TypeError("shared references in error data");
  budget.seen.add(value);
  if (ancestors.size >= 64)
    throw new TypeError("error data exceeds 64 nesting levels");
  ancestors.add(value);
  try {
    const encode = (item: unknown) =>
      encodeFailureValue(item, ancestors, budget);
    const symbols = Object.getOwnPropertySymbols(value).filter(
      (key) =>
        !(
          value instanceof Error &&
          key === Symbol.for("effect/Data/Error/plainArgs")
        ),
    );
    if (symbols.length) throw new TypeError("symbol-keyed error data");
    if (
      value instanceof Date ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer ||
      value instanceof Map ||
      value instanceof Set
    ) {
      const own = Object.getOwnPropertyNames(value);
      if (
        own.some(
          (key) => !(value instanceof Uint8Array && /^(0|[1-9]\d*)$/.test(key)),
        )
      )
        throw new TypeError("custom properties on serialized built-in values");
      if (value instanceof Date)
        return ["date", encode(Date.prototype.getTime.call(value))];
      if (value instanceof Uint8Array) return ["bytes", Base64.encode(value)];
      if (value instanceof ArrayBuffer)
        return ["buffer", Base64.encode(new Uint8Array(value))];
      if (value instanceof Map)
        return [
          "map",
          [...Map.prototype.entries.call(value)].map(([key, item]) => [
            encode(key),
            encode(item),
          ]),
        ];
      return ["set", [...Set.prototype.values.call(value)].map(encode)];
    }
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== "length" &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
        )
      )
        throw new TypeError("sparse arrays or custom array properties");
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor))
          throw new TypeError("accessor error data");
      }
      return [
        "array",
        Array.from({ length: value.length }, (_, i) =>
          encode(descriptors[i].value),
        ),
      ];
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let tag: string | undefined;
    for (
      let owner: object | null = value;
      owner;
      owner = Object.getPrototypeOf(owner)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, "_tag");
      if (!descriptor) continue;
      if (!("value" in descriptor)) throw new TypeError("accessor error data");
      if (typeof descriptor.value === "string") tag = descriptor.value;
      break;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      !(value instanceof Error) &&
      prototype !== null &&
      prototype !== Object.prototype &&
      tag === undefined
    )
      throw new TypeError("unsupported class instance");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !("value" in descriptor) &&
        !(value instanceof Error && key === "stack")
      )
        throw new TypeError("accessor error data");
    }
    const fields = new Map<string, unknown>();
    if (tag !== undefined) fields.set("_tag", tag);
    if (value instanceof Error) {
      for (const key of ["name", "message", "stack"]) {
        let owner: object | null = value;
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key);
          if (descriptor) {
            if (
              !("value" in descriptor) &&
              !(owner === value && key === "stack")
            )
              throw new TypeError("accessor error data");
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      for (const [key, item] of Object.entries(
        encodeRpcError(value) as Record<string, unknown>,
      ))
        fields.set(key, item);
      fields.set("name", value.name);
      fields.set("message", value.message);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        if (value instanceof Error && key === "stack")
          fields.set(key, value.stack);
        else throw new TypeError("accessor error data");
      } else fields.set(key, descriptor.value);
    }
    return [
      value instanceof Error ? "error" : "object",
      [...fields].map(([key, item]) => [key, encode(item)]),
    ];
  } finally {
    ancestors.delete(value);
  }
};

const decodeFailureValue = (value: unknown, depth = 0): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (!Array.isArray(value))
    throw new TypeError("invalid serialized error value");
  const decode = (item: unknown) => decodeFailureValue(item, depth + 1);
  const [tag, data] = value;
  if (tag === "undefined" && value.length === 1) return undefined;
  if (value.length !== 2) throw new TypeError("invalid serialized error tuple");
  if (
    tag === "number" &&
    typeof data === "string" &&
    ["NaN", "Infinity", "-Infinity", "-0"].includes(data)
  )
    return Number(data);
  if (
    tag === "bigint" &&
    typeof data === "string" &&
    /^-?(0|[1-9]\d*)$/.test(data)
  )
    return BigInt(data);
  if (depth >= 64) throw new TypeError("invalid serialized error value");
  if (tag === "date") {
    const timestamp = decode(data);
    if (typeof timestamp === "number") return new Date(timestamp);
  }
  if ((tag === "bytes" || tag === "buffer") && typeof data === "string") {
    const bytes = Base64.decode(data);
    if (Result.isSuccess(bytes) && Base64.encode(bytes.success) === data)
      return tag === "bytes" ? bytes.success : bytes.success.buffer;
  }
  if (Array.isArray(data)) {
    if (tag === "array") return data.map(decode);
    if (tag === "set") return new Set(data.map(decode));
    if (tag === "map")
      return new Map(
        data.map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2)
            throw new TypeError("invalid serialized map");
          return [decode(pair[0]), decode(pair[1])];
        }),
      );
    if (tag === "object" || tag === "error") {
      const result = tag === "error" ? new Error() : {};
      const keys = new Set<string>();
      for (const pair of data) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          keys.has(pair[0])
        )
          throw new TypeError("invalid serialized error fields");
        keys.add(pair[0]);
        Object.defineProperty(result, pair[0], {
          value: decode(pair[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
  throw new TypeError("invalid serialized error value");
};

// Own undefined properties overwrite the engine's defaults for steps and rollbacks.
const definedStepConfig = (
  options: WorkflowStepConfig | undefined,
): WorkflowStepConfig | undefined => {
  if (options === undefined) return undefined;
  const config: WorkflowStepConfig = {};
  if (options.retries !== undefined) config.retries = options.retries;
  if (options.timeout !== undefined) config.timeout = options.timeout;
  return Object.keys(config).length > 0 ? config : undefined;
};
