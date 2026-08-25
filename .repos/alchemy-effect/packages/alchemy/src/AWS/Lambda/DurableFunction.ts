import * as Lambda from "@distilled.cloud/aws/lambda";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { PackageInstall } from "../../Bundle/InstalledPackages.ts";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { PlatformServices } from "../../Platform.ts";
import { toSeconds, toWireDays } from "../../Util/Duration.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import type { DurableExecutionContext, DurableStep } from "./Durable.ts";
import {
  DURABLE_SDK_MODULE,
  encodeDurableEnvelope,
  makeDurableListener,
} from "./DurableBridge.ts";
import {
  Function,
  type FunctionProps,
  type FunctionServices,
  type HandlerContext,
} from "./Function.ts";

type TypeId = "AWS.Lambda.DurableFunction";
const TypeId = "AWS.Lambda.DurableFunction" as const;

/**
 * The services available inside a durable function's run body.
 *
 * The bridge provides all of them per durable invocation: `DurableStep`
 * powers `Durable.step`/`Durable.sleep`/`Durable.waitForCallback`,
 * `DurableExecutionContext` carries the execution ARN, `HandlerContext` is
 * the raw `lambda.Context`, and a fresh `Scope` scopes per-invocation
 * resources.
 *
 * Deliberately narrow: cloud clients (`Credentials`/`Region`-requiring
 * effects) are NOT provided to the body directly — resolve typed binding
 * clients in the init phase and call them inside `Durable.step`, which is
 * exactly the determinism law the replay model requires.
 */
export type DurableRunServices =
  | DurableStep
  | DurableExecutionContext
  | HandlerContext
  | Scope;

/**
 * A durable function implementation: a function from a typed `Input` payload
 * to an Effect producing the execution's `Result`. Code outside
 * `Durable.step` re-runs on every replay and must be deterministic.
 */
export type DurableFunctionImpl<Input = unknown, Result = unknown> = (
  input: Input,
) => Effect.Effect<Result, never, DurableRunServices>;

/**
 * Services satisfied by the DurableFunction's own machinery (or the engine)
 * and therefore excluded from the caller-facing requirements of the returned
 * Effect/Layer.
 */
export type DurableFunctionInitServices =
  | FunctionServices
  | PlatformServices
  | Function
  | DurableRunServices;

/**
 * Properties of an {@link DurableFunction | AWS.Lambda.DurableFunction}.
 *
 * A DurableFunction accepts every {@link FunctionProps | Function prop}
 * except `url` (every invocation of a durable function arrives as the
 * durable-execution envelope — there is no HTTP surface), plus the
 * `DurableConfig` tuning knobs below.
 */
export interface DurableFunctionProps extends Omit<
  FunctionProps,
  "url" | "durableConfig"
> {
  /**
   * Maximum total duration of a durable execution, from start to terminal
   * state (minimum 60 seconds, maximum 1 year). Rounded up to whole seconds.
   * @default 24 hours (AWS default)
   */
  executionTimeout?: Duration.Input;
  /**
   * How long completed execution history is retained (e.g. `"7 days"`;
   * 1–90 days). Rounded to whole days on the wire.
   * @default "14 days" (AWS default)
   */
  retentionPeriod?: Duration.Input;
}

/**
 * Options for starting a durable execution.
 */
export interface DurableStartOptions<Input = unknown> {
  /**
   * Idempotent execution name (`DurableExecutionName`): starting again with
   * the same name and payload reattaches to the existing execution; the same
   * name with a different payload fails with
   * `DurableExecutionAlreadyStartedException`.
   */
  name?: string;
  /** The typed input payload delivered to the durable function body. */
  params?: Input;
  /**
   * Function version or alias to pin the execution to. Durable executions
   * replay against the version they started on, so production starts should
   * target a published version/alias.
   */
  qualifier?: string;
}

/**
 * A started durable execution reference.
 */
export interface DurableExecutionRef {
  /** ARN of the durable execution (when returned by the Invoke response). */
  executionArn: string | undefined;
  statusCode: number | undefined;
}

/**
 * The typed durable-execution handle: start, inspect, stop, and complete
 * callbacks of durable executions of this function. Returned by
 * `yield* MyDurableFunction` (as part of {@link DurableFunction}) and, inside
 * the function's own init phase, by {@link DurableFunctionScope}.
 */
export interface DurableFunctionHandle<Input = unknown, Result = unknown> {
  Type: TypeId;
  name: string;
  /** @internal phantom */
  Result?: Result;
  /**
   * Start a durable execution (async `Invoke` with the alchemy payload
   * envelope). Returns immediately; the execution progresses through
   * checkpointed re-invocations.
   */
  start(
    options?: DurableStartOptions<Input>,
  ): Effect.Effect<DurableExecutionRef, Lambda.InvokeError>;
  /** Fetch the execution's status/result. */
  get(
    executionArn: string,
  ): Effect.Effect<
    Lambda.GetDurableExecutionResponse,
    Lambda.GetDurableExecutionError
  >;
  /** List executions of this function, optionally filtered by name/status. */
  list(options?: {
    name?: string;
    statuses?: Lambda.ExecutionStatus[];
  }): Effect.Effect<
    Lambda.ListDurableExecutionsByFunctionResponse,
    Lambda.ListDurableExecutionsByFunctionError
  >;
  /** Stop a running execution. */
  stop(
    executionArn: string,
    error?: Lambda.ErrorObject,
  ): Effect.Effect<
    Lambda.StopDurableExecutionResponse,
    Lambda.StopDurableExecutionError
  >;
  /** Complete a `Durable.waitForCallback` from the outside. */
  sendCallbackSuccess(
    callbackId: string,
    result?: unknown,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackSuccessError>;
  sendCallbackFailure(
    callbackId: string,
    error?: Lambda.ErrorObject,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackFailureError>;
  sendCallbackHeartbeat(
    callbackId: string,
  ): Effect.Effect<void, Lambda.SendDurableExecutionCallbackHeartbeatError>;
}

/**
 * The value produced by `yield* MyDurableFunction`: the typed
 * {@link DurableFunctionHandle} plus references to the underlying
 * {@link Function} resource and its key attributes.
 */
export interface DurableFunction<
  Input = unknown,
  Result = unknown,
> extends DurableFunctionHandle<Input, Result> {
  /** The underlying Lambda {@link Function} resource owned by this wrapper. */
  function: Function;
  /** Physical name of the underlying Lambda function. */
  functionName: Function["functionName"];
  /** ARN of the underlying Lambda function. */
  functionArn: Function["functionArn"];
}

/**
 * Inside a DurableFunction's init phase, resolves the function's own
 * {@link DurableFunctionHandle} (e.g. for chained self-starts). Also what
 * `yield* AWS.Lambda.DurableFunction` (the bare namespace value) resolves.
 */
export class DurableFunctionScope extends Context.Service<
  DurableFunctionScope,
  DurableFunctionHandle
>()("AWS.Lambda.DurableFunctionScope") {}

export interface DurableFunctionClass {
  <_Self>(): {
    <Input = unknown, Result = unknown, PropsReq = never, InitReq = never>(
      id: string,
      props:
        | InputProps<DurableFunctionProps>
        | Effect.Effect<
            InputProps<DurableFunctionProps>,
            ConfigError,
            PropsReq
          >,
      impl: Effect.Effect<
        DurableFunctionImpl<Input, Result>,
        ConfigError,
        InitReq
      >,
    ): Effect.Effect<
      DurableFunction<Input, Result>,
      never,
      | Function["Providers"]
      | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
    > & {
      new (_: never): DurableFunctionImpl<Input, Result>;
    };
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<DurableFunction, never, Function["Providers"]> & {
      make<
        Input = unknown,
        Result = unknown,
        PropsReq = never,
        InitReq = never,
      >(
        props:
          | InputProps<DurableFunctionProps>
          | Effect.Effect<
              InputProps<DurableFunctionProps>,
              ConfigError,
              PropsReq
            >,
        impl: Effect.Effect<
          DurableFunctionImpl<Input, Result>,
          ConfigError,
          InitReq
        >,
      ): Layer.Layer<
        _Self,
        never,
        | Function["Providers"]
        | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
      >;
      new (_: never): {};
    };
  };
  <Input = unknown, Result = unknown, PropsReq = never, InitReq = never>(
    id: string,
    props:
      | InputProps<DurableFunctionProps>
      | Effect.Effect<InputProps<DurableFunctionProps>, ConfigError, PropsReq>,
    impl: Effect.Effect<
      DurableFunctionImpl<Input, Result>,
      ConfigError,
      InitReq
    >,
  ): Effect.Effect<
    DurableFunction<Input, Result>,
    never,
    | Function["Providers"]
    | Exclude<PropsReq | InitReq, DurableFunctionInitServices>
  >;
}

/**
 * Where the composed init stashes the {@link DurableFunction} value on the
 * owned Function instance so `yield*` of any authoring form can produce it.
 * A symbol key passes through the Resource proxy untouched (string props
 * fabricate `Output.PropExpr` accessors).
 */
const DurableHandleKey = Symbol.for("alchemy/AWS.Lambda.DurableFunction");

/**
 * Vendor the Durable Execution SDK into the artifact. `build.install` roots
 * are excluded from the bundle and npm-installed into the zip targeting the
 * function's architecture, so this single entry both externalizes the SDK
 * (the bridge dynamic-imports it at runtime) and ships it. Respects an
 * explicit user entry (e.g. a pinned version).
 */
const withDurableSdkInstall = (
  install: PackageInstall | undefined,
): PackageInstall => {
  if (install === undefined) {
    return [DURABLE_SDK_MODULE];
  }
  if (Array.isArray(install)) {
    return install.includes(DURABLE_SDK_MODULE)
      ? install
      : [...install, DURABLE_SDK_MODULE];
  }
  const record = install as Readonly<Record<string, string>>;
  return DURABLE_SDK_MODULE in record
    ? record
    : { ...record, [DURABLE_SDK_MODULE]: "*" };
};

/**
 * Lower DurableFunction props onto the base Function's props: split off the
 * DurableConfig knobs into the internal wire-level `durableConfig` channel,
 * disable the Function URL (durable invocations are the only surface), and
 * vendor the Durable Execution SDK.
 */
const mapDurableProps = (props: DurableFunctionProps): FunctionProps => {
  const { executionTimeout, retentionPeriod, build, ...rest } =
    props ?? ({} as DurableFunctionProps);
  const executionTimeoutSeconds = toSeconds(executionTimeout);
  const retentionPeriodDays = toWireDays(retentionPeriod);
  return {
    ...rest,
    // Every invocation of a DurableConfig'd function arrives as the durable
    // envelope — a Function URL could never be served.
    url: false,
    build: {
      ...build,
      install: withDurableSdkInstall(build?.install),
    },
    durableConfig: {
      ...(executionTimeoutSeconds !== undefined
        ? { ExecutionTimeout: executionTimeoutSeconds }
        : {}),
      ...(retentionPeriodDays !== undefined
        ? { RetentionPeriodInDays: retentionPeriodDays }
        : {}),
    },
  };
};

const mapDurablePropsInput = (props: unknown) =>
  Effect.isEffect(props)
    ? Effect.map(props as Effect.Effect<DurableFunctionProps>, mapDurableProps)
    : mapDurableProps(props as DurableFunctionProps);

const resolveDurableHandle = (id: string) => (instance: unknown) => {
  const handle = (instance as Record<symbol, unknown> | undefined)?.[
    DurableHandleKey
  ];
  return handle !== undefined
    ? Effect.succeed(handle as DurableFunction<any, any>)
    : Effect.die(
        new Error(
          `AWS.Lambda.DurableFunction<${id}> has no durable handle — provide ` +
            `its implementation (\`${id}.make(props, impl)\` or an inline ` +
            `form) before yielding it.`,
        ),
      );
};

/**
 * Compose the user's orchestrator init effect into the owned Function's init
 * effect: resolve the durable management-plane clients, self-bind the
 * checkpoint-protocol IAM onto the function's own execution role, register
 * the durable listener on the owned entrypoint, and stash the typed handle
 * for `yield* MyDurableFunction`.
 */
const composeDurableImpl = (
  name: string,
  impl: Effect.Effect<DurableFunctionImpl<any, any>, any, any>,
): Effect.Effect<void, any, any> =>
  Effect.gen(function* () {
    // Self: the Function resource this wrapper owns (the Platform machinery
    // provides `Function.Self` during its own init).
    const host = yield* Function;

    // Resolve the distilled operations once at init — they close over the
    // ambient Credentials/Region/HttpClient so the handle's runtime
    // callables need no cloud services of their own.
    const invoke = yield* Lambda.invoke;
    const getDurableExecution = yield* Lambda.getDurableExecution;
    const listDurableExecutionsByFunction =
      yield* Lambda.listDurableExecutionsByFunction;
    const stopDurableExecution = yield* Lambda.stopDurableExecution;
    const sendCallbackSuccess =
      yield* Lambda.sendDurableExecutionCallbackSuccess;
    const sendCallbackFailure =
      yield* Lambda.sendDurableExecutionCallbackFailure;
    const sendCallbackHeartbeat =
      yield* Lambda.sendDurableExecutionCallbackHeartbeat;

    // Capture the function-name Output WITHOUT resolving it. This is a
    // self-reference — `host` is the very Function this wrapper's init is
    // building — and `functionName`'s Output source only registers during
    // that function's own reconcile. Yielding it here (init/plan time) would
    // block forever (the reconcile that produces it waits on this init to
    // finish). Resolve it lazily inside the runtime callables instead, the
    // same posture as `InvokeFunctionHttp`.
    const FunctionName = host.functionName;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Self-binding: the statements land on this function's own execution
      // role through the standard bindings channel (precreate makes the stub,
      // reconcile applies the collected bindings).
      yield* host.bind`Allow(${host}, AWS.Lambda.DurableFunction(${name}))`({
        policyStatements: [
          // The checkpoint/replay protocol the Durable Execution SDK
          // drives from inside the handler.
          {
            Effect: "Allow",
            Action: [
              "lambda:CheckpointDurableExecution",
              "lambda:GetDurableExecutionState",
            ],
            Resource: [
              host.functionArn,
              Output.interpolate`${host.functionArn}:*`,
            ],
          },
          // Self-start (handle.start) and chained self-invokes.
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [
              host.functionArn,
              Output.interpolate`${host.functionArn}:*`,
            ],
          },
          // Management-plane handle methods. Durable execution ARNs are
          // a distinct resource shape from the function ARN, so these
          // stay account-wide for now.
          {
            Effect: "Allow",
            Action: [
              "lambda:GetDurableExecution",
              "lambda:GetDurableExecutionHistory",
              "lambda:ListDurableExecutionsByFunction",
              "lambda:StopDurableExecution",
              "lambda:SendDurableExecutionCallbackSuccess",
              "lambda:SendDurableExecutionCallbackFailure",
              "lambda:SendDurableExecutionCallbackHeartbeat",
            ],
            Resource: ["*"],
          },
        ],
      });
    }

    const handle: DurableFunctionHandle<any, any> = {
      Type: TypeId,
      name,
      start: (options) =>
        Effect.gen(function* () {
          // `FunctionName` is the host's own unresolved Output (captured raw at
          // init to avoid the plan-time self-reference deadlock). Resolve both
          // stages — Output → Accessor → string — lazily at runtime.
          const functionName = yield* yield* FunctionName;
          const response = yield* invoke({
            FunctionName: functionName,
            InvocationType: "Event",
            DurableExecutionName: options?.name,
            Qualifier: options?.qualifier,
            Payload: encodeDurableEnvelope(name, options?.params),
          });
          return {
            executionArn: response.DurableExecutionArn,
            statusCode: response.StatusCode,
          };
        }),
      get: (executionArn) =>
        getDurableExecution({ DurableExecutionArn: executionArn }),
      list: (options) =>
        Effect.gen(function* () {
          const functionName = yield* yield* FunctionName;
          return yield* listDurableExecutionsByFunction({
            FunctionName: functionName,
            DurableExecutionName: options?.name,
            Statuses: options?.statuses,
          });
        }),
      stop: (executionArn, error) =>
        stopDurableExecution({
          DurableExecutionArn: executionArn,
          Error: error,
        }),
      sendCallbackSuccess: (callbackId, result) =>
        sendCallbackSuccess({
          CallbackId: callbackId,
          Result: result === undefined ? undefined : JSON.stringify(result),
        }).pipe(Effect.asVoid),
      sendCallbackFailure: (callbackId, error) =>
        sendCallbackFailure({
          CallbackId: callbackId,
          Error: error,
        }).pipe(Effect.asVoid),
      sendCallbackHeartbeat: (callbackId) =>
        sendCallbackHeartbeat({ CallbackId: callbackId }).pipe(Effect.asVoid),
    };

    // Resolve the body function. Bindings resolved in the impl's init close
    // over their services; the returned closure's only leftover requirements
    // are DurableRunServices, provided per invocation by the bridge.
    const fn = yield* (
      impl as Effect.Effect<DurableFunctionImpl<any, any>>
    ).pipe(Effect.provideService(DurableFunctionScope, handle));

    yield* host.listen(
      makeDurableListener({
        name,
        run: (input) => fn(input) as Effect.Effect<unknown>,
      }),
    );

    // Expose the full DurableFunction value (handle + resource refs) to
    // `yield* MyDurableFunction` for every authoring form.
    (host as unknown as Record<symbol, unknown>)[DurableHandleKey] = {
      ...handle,
      function: host,
      functionName: host.functionName,
      functionArn: host.functionArn,
    } satisfies DurableFunction<any, any>;
  });

/**
 * An AWS Lambda Durable Function — a code-first, replay-based orchestrator
 * that IS a durable Lambda Function. `AWS.Lambda.DurableFunction` is a
 * wrapper of {@link Function}: it owns the underlying Lambda function,
 * configures its `DurableConfig` at `CreateFunction` (durability is a
 * create-time property — a DurableFunction is always durable), registers the
 * durable-execution listener on the owned entrypoint, self-binds the
 * checkpoint-protocol IAM (`lambda:CheckpointDurableExecution`,
 * `lambda:GetDurableExecutionState`) onto the execution role, and vendors the
 * open-source `@aws/durable-execution-sdk-js` into the artifact (install it
 * in your project: `npm i @aws/durable-execution-sdk-js`).
 *
 * Executions progress by checkpoint + replay: a `Durable.sleep` or
 * `Durable.waitForCallback` suspends the execution with zero compute billed
 * until Lambda re-invokes the same function version to resume, and completed
 * `Durable.step`s replay from the checkpoint log without re-executing.
 *
 * Every invocation of a durable function arrives as the durable-execution
 * envelope, so a DurableFunction has no HTTP surface (`url` is disabled) —
 * it does one thing: run durable orchestrations. Reusing a logical id
 * between a plain `Function` and a `DurableFunction` replaces the physical
 * function (DurableConfig cannot be flipped in place).
 *
 * @resource
 * @section Defining a Durable Function
 * @example Class form with steps and a durable sleep
 * ```typescript
 * export class OrderFlow extends AWS.Lambda.DurableFunction<OrderFlow>()(
 *   "OrderFlow",
 *   {
 *     main: import.meta.url,
 *     executionTimeout: "1 hour",
 *     retentionPeriod: "7 days",
 *   },
 *   Effect.gen(function* () {
 *     // init: resolve typed binding clients (IAM lands on this function's role)
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       const reserved = yield* AWS.Lambda.Durable.step(
 *         "reserve",
 *         putItem({ Item: { pk: { S: input.orderId } } }).pipe(Effect.orDie),
 *         { retry: { limit: 3, delay: "5 seconds" } },
 *       );
 *       yield* AWS.Lambda.Durable.sleep("cooldown", "10 minutes");
 *       return { orderId: input.orderId, reserved };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @example Tag + default export (entrypoint form)
 * ```typescript
 * // order-flow.ts — `main` points at this module
 * export class OrderFlow extends AWS.Lambda.DurableFunction<OrderFlow>()(
 *   "OrderFlow",
 * ) {}
 *
 * export default OrderFlow.make(
 *   { main: import.meta.url, executionTimeout: "1 hour" },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       return yield* AWS.Lambda.Durable.step("work", doWork(input));
 *     });
 *   }),
 * );
 * ```
 *
 * @example Inline effect form
 * ```typescript
 * const flow = yield* AWS.Lambda.DurableFunction(
 *   "OrderFlow",
 *   { main: "./src/order-flow.ts" },
 *   Effect.gen(function* () {
 *     return Effect.fn(function* (input: { orderId: string }) {
 *       return yield* AWS.Lambda.Durable.step("work", doWork(input));
 *     });
 *   }),
 * );
 * ```
 *
 * @section Starting and Monitoring Executions
 * @example Starting an execution
 * ```typescript
 * const orders = yield* OrderFlow;
 * const ref = yield* orders.start({
 *   name: "order-123", // idempotent start
 *   params: { orderId: "123" },
 * });
 * ```
 *
 * @example Checking status
 * ```typescript
 * const execution = yield* orders.get(ref.executionArn!);
 * // execution.Status: "RUNNING" | "SUCCEEDED" | "FAILED" | ...
 * ```
 *
 * @section External Callbacks
 * @example Waiting for an approval
 * ```typescript
 * const approval = yield* AWS.Lambda.Durable.waitForCallback<{ ok: boolean }>(
 *   "approve",
 *   (callbackId) => storeCallbackId(callbackId),
 *   { timeout: "1 day" },
 * );
 * ```
 */
export const DurableFunction: DurableFunctionClass = taggedFunction(
  DurableFunctionScope,
  ((
    ...args:
      | []
      | [id: string]
      | [id: string, props: unknown, impl: Effect.Effect<any, any, any>]
  ) => {
    if (args.length === 0) {
      // `DurableFunction<Self>()` — the binder for the class/tag forms.
      return DurableFunction;
    }
    const [id, props, impl] = args;
    if (impl === undefined) {
      // Tag form: `class OrderFlow extends DurableFunction<OrderFlow>()("OrderFlow") {}`
      // + `export default OrderFlow.make(props, impl)`.
      const fnTag = (Function as any)()(id);
      return Object.assign(
        function (props: unknown, impl: Effect.Effect<any, any, any>) {
          return Effect.flatMap(
            fnTag(mapDurablePropsInput(props), composeDurableImpl(id, impl)),
            resolveDurableHandle(id),
          );
        },
        fnTag,
        {
          make: (props: unknown, impl: Effect.Effect<any, any, any>) =>
            fnTag.make(
              mapDurablePropsInput(props),
              composeDurableImpl(id, impl),
            ),
        },
        Effectable.Prototype({
          label: `${TypeId}<${id}>`,
          evaluate: () =>
            Effect.flatMap(
              Effect.serviceOption(fnTag.Self),
              Option.match({
                onNone: () => resolveDurableHandle(id)(undefined),
                onSome: resolveDurableHandle(id),
              }),
            ),
        }),
      );
    }
    // Inline forms (eager effect / inline class): delegate to the Function
    // platform with lowered props and the composed durable init.
    return effectClass(
      Effect.flatMap(
        (Function as any)(
          id,
          mapDurablePropsInput(props),
          composeDurableImpl(id, impl),
        ) as Effect.Effect<unknown>,
        resolveDurableHandle(id),
      ),
    );
  }) as any,
);
