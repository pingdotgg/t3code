import {
  DEFAULT_SERVER_SETTINGS,
  PREVIEW_MIDSCENE_RESULT_MAX_BYTES,
  PreviewAutomationError,
  PreviewMidsceneConfigurationError,
  PreviewMidsceneExecutionError,
  PreviewMidsceneResultTooLargeError,
  type PreviewAutomationError as PreviewAutomationErrorType,
  type PreviewAutomationOperation,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewMidsceneActInput,
  type PreviewMidsceneActResult,
  type PreviewMidsceneAssertInput,
  type PreviewMidsceneAssertResult,
  type PreviewMidsceneError,
  type PreviewMidsceneOperation,
  type PreviewMidsceneQueryInput,
  type PreviewMidsceneQueryResult,
  type PreviewMidsceneUsage,
  type PreviewTabId,
  type MidsceneSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import type { AIUsageInfo, MidsceneUsageMetrics } from "@midscene/core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewMidsceneRuntime from "./preview-midscene/PreviewMidsceneRuntime.ts";
import {
  T3PreviewInterface,
  type T3PreviewOperations,
} from "./preview-midscene/T3PreviewInterface.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const BROKER_OPERATION_TIMEOUT_MS = 60_000;
const REQUIRED_MODEL_VARIABLES = [
  "MIDSCENE_MODEL_API_KEY",
  "MIDSCENE_MODEL_NAME",
  "MIDSCENE_MODEL_FAMILY",
] as const;
const MODEL_BASE_URL_VARIABLE = "MIDSCENE_MODEL_BASE_URL";
const LEGACY_MODEL_BASE_URL_VARIABLE = "OPENAI_BASE_URL";
const MODEL_BASE_URL_REQUIREMENT = `${MODEL_BASE_URL_VARIABLE} (or legacy ${LEGACY_MODEL_BASE_URL_VARIABLE})`;
const MIDSCENE_MODEL_ENV_NAME_PATTERN = /^MIDSCENE_(?:(?:INSIGHT|PLANNING)_)?MODEL_/u;

type SemanticInput =
  | PreviewMidsceneActInput
  | PreviewMidsceneQueryInput
  | PreviewMidsceneAssertInput;

class PreviewMidsceneBrokerFailure extends Error {
  readonly error: PreviewAutomationErrorType;

  constructor(error: PreviewAutomationErrorType) {
    super(error.message);
    this.error = error;
  }
}

class PreviewMidsceneStageFailure extends Error {
  readonly stage: PreviewMidsceneExecutionError["stage"];
  readonly error: unknown;

  constructor(stage: PreviewMidsceneExecutionError["stage"], error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.stage = stage;
    this.error = error;
  }
}

const isPreviewAutomationError = Schema.is(PreviewAutomationError);
const isPreviewMidsceneResultTooLargeError = Schema.is(PreviewMidsceneResultTooLargeError);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeUnknownSync(UnknownFromJsonString);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownFromJsonString);

export function missingMidsceneModelVariables(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> {
  const missingVariables: Array<string> = REQUIRED_MODEL_VARIABLES.filter(
    (name) => !environment[name]?.trim(),
  );
  // Midscene treats any truthy canonical value, including whitespace, as overriding legacy.
  const selectedBaseUrl =
    environment[MODEL_BASE_URL_VARIABLE] || environment[LEGACY_MODEL_BASE_URL_VARIABLE];
  if (!selectedBaseUrl?.trim()) {
    missingVariables.push(MODEL_BASE_URL_REQUIREMENT);
  }
  return missingVariables;
}

export function resolveMidsceneModelConfig(
  environment: Readonly<Record<string, string | undefined>>,
  settings: MidsceneSettings,
): Readonly<Record<string, string>> {
  const modelConfig = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (entry[0] === LEGACY_MODEL_BASE_URL_VARIABLE ||
          MIDSCENE_MODEL_ENV_NAME_PATTERN.test(entry[0])),
    ),
  );
  const settingOverrides = {
    MIDSCENE_MODEL_API_KEY: settings.modelApiKey,
    MIDSCENE_MODEL_NAME: settings.modelName,
    MIDSCENE_MODEL_FAMILY: settings.modelFamily,
    MIDSCENE_MODEL_BASE_URL: settings.modelBaseUrl,
  } as const;
  for (const [name, value] of Object.entries(settingOverrides)) {
    if (value.trim().length > 0) modelConfig[name] = value;
  }
  return modelConfig;
}

const usageFromMetrics = (metrics: MidsceneUsageMetrics): PreviewMidsceneUsage => ({
  promptTokens: metrics.totalPromptTokens,
  completionTokens: metrics.totalCompletionTokens,
  totalTokens: metrics.totalTokens,
  cachedInputTokens: metrics.totalCachedInput,
  modelTimeMs: metrics.totalTimeCostMs,
  calls: metrics.calls,
});

const usageFromCall = (usage: AIUsageInfo | undefined): PreviewMidsceneUsage => ({
  promptTokens: usage?.prompt_tokens ?? 0,
  completionTokens: usage?.completion_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0,
  cachedInputTokens: usage?.cached_input ?? 0,
  modelTimeMs: usage?.time_cost ?? 0,
  calls: usage ? 1 : 0,
});

const findPreviewAutomationError = (
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): PreviewAutomationErrorType | undefined => {
  if (depth > 8) return undefined;
  if (value instanceof PreviewMidsceneBrokerFailure) return value.error;
  if (isPreviewAutomationError(value)) return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
  seen.add(value);
  for (const key of ["cause", "error", "errorTask", "reason"] as const) {
    if (!(key in value)) continue;
    const record = value as Readonly<Record<string, unknown>>;
    const found = findPreviewAutomationError(record[key], seen, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const runBrokerPromise = async <A>(
  effect: Effect.Effect<A, PreviewAutomationErrorType>,
  signal: AbortSignal,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (failure && isPreviewAutomationError(failure)) {
    throw new PreviewMidsceneBrokerFailure(failure);
  }
  throw new PreviewMidsceneStageFailure("execute", Cause.squash(exit.cause));
};

const canonicalizeQueryValue = (
  tabId: PreviewTabId,
  value: unknown,
): Effect.Effect<unknown, PreviewMidsceneExecutionError | PreviewMidsceneResultTooLargeError> =>
  Effect.try({
    try: () => {
      const serialized = encodeUnknownJson(value ?? null);
      const sizeBytes = Buffer.byteLength(serialized, "utf8");
      if (sizeBytes > PREVIEW_MIDSCENE_RESULT_MAX_BYTES) {
        throw new PreviewMidsceneResultTooLargeError({
          operation: "query",
          tabId,
          maximumBytes: PREVIEW_MIDSCENE_RESULT_MAX_BYTES,
        });
      }
      return decodeUnknownJson(serialized);
    },
    catch: (cause) =>
      isPreviewMidsceneResultTooLargeError(cause)
        ? cause
        : new PreviewMidsceneExecutionError({
            operation: "query",
            stage: "serialize",
            tabId,
          }),
  });

interface SemanticExecution<A> {
  readonly tabId: PreviewTabId;
  readonly value: A;
  readonly usage: PreviewMidsceneUsage;
}

export interface PreviewMidsceneServiceShape {
  readonly act: (
    scope: McpInvocationScope,
    input: PreviewMidsceneActInput,
  ) => Effect.Effect<PreviewMidsceneActResult, PreviewMidsceneError>;
  readonly query: (
    scope: McpInvocationScope,
    input: PreviewMidsceneQueryInput,
  ) => Effect.Effect<PreviewMidsceneQueryResult, PreviewMidsceneError>;
  readonly assert: (
    scope: McpInvocationScope,
    input: PreviewMidsceneAssertInput,
  ) => Effect.Effect<PreviewMidsceneAssertResult, PreviewMidsceneError>;
}

export class PreviewMidsceneService extends Context.Service<
  PreviewMidsceneService,
  PreviewMidsceneServiceShape
>()("t3/mcp/PreviewMidsceneService") {}

export const makeWithEnvironment = (
  environment: NodeJS.ProcessEnv,
  midsceneSettings: Effect.Effect<MidsceneSettings, ServerSettingsError> = Effect.succeed(
    DEFAULT_SERVER_SETTINGS.midscene,
  ),
) =>
  Effect.gen(function* PreviewMidsceneServiceMake() {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const runtimeService = yield* PreviewMidsceneRuntime.PreviewMidsceneRuntime;
    const targetLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

    const getTargetLock = (key: string) =>
      SynchronizedRef.modifyEffect(targetLocks, (current) => {
        const existing = Option.fromNullishOr(current.get(key));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(key, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const invokeBroker = <A>(
      scope: McpInvocationScope,
      operation: PreviewAutomationOperation,
      input: unknown,
      tabId?: PreviewTabId,
    ) =>
      broker.invoke<A>({
        scope,
        operation,
        input,
        timeoutMs: BROKER_OPERATION_TIMEOUT_MS,
        ...(tabId === undefined ? {} : { tabId }),
      });

    const resolveTarget = Effect.fn("PreviewMidsceneService.resolveTarget")(function* (
      scope: McpInvocationScope,
      input: SemanticInput,
      operation: PreviewMidsceneOperation,
    ) {
      const settings = yield* midsceneSettings.pipe(
        Effect.mapError(
          () =>
            new PreviewMidsceneExecutionError({
              operation,
              stage: "initialize",
            }),
        ),
      );
      const modelConfig = resolveMidsceneModelConfig(environment, settings);
      const missingVariables = missingMidsceneModelVariables(modelConfig);
      if (missingVariables.length > 0) {
        return yield* new PreviewMidsceneConfigurationError({ operation, missingVariables });
      }
      let status = yield* invokeBroker<PreviewAutomationStatus>(scope, "status", {}, input.tabId);
      const resolvedTabId = status.tabId;
      if (status.available && resolvedTabId && !status.visible) {
        status = yield* invokeBroker<PreviewAutomationStatus>(
          scope,
          "open",
          { open: true, reuseExistingTab: true },
          resolvedTabId,
        );
      }
      const errorTabId = resolvedTabId ?? status.tabId;
      if (
        !status.available ||
        !status.visible ||
        !status.tabId ||
        !status.viewport ||
        (resolvedTabId !== null && status.tabId !== resolvedTabId)
      ) {
        return yield* new PreviewMidsceneExecutionError({
          operation,
          stage: "observe",
          ...(errorTabId ? { tabId: errorTabId } : {}),
        });
      }
      return { tabId: status.tabId, status, modelConfig };
    });

    const execute = <A>(
      scope: McpInvocationScope,
      input: SemanticInput,
      operation: PreviewMidsceneOperation,
      run: (
        agent: PreviewMidsceneRuntime.PreviewMidsceneAgentHandle,
        signal: AbortSignal,
      ) => Promise<{ readonly value: A; readonly usage?: PreviewMidsceneUsage }>,
    ): Effect.Effect<SemanticExecution<A>, PreviewMidsceneError> =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(scope, input, operation);
        const runtime = yield* runtimeService.load(operation);
        const lock = yield* getTargetLock(`${scope.environmentId}\u0000${target.tabId}`);
        const operationsFor = (signal: AbortSignal): T3PreviewOperations => ({
          status: () => runBrokerPromise(invokeBroker(scope, "status", {}, target.tabId), signal),
          snapshot: () =>
            runBrokerPromise<PreviewAutomationSnapshot>(
              invokeBroker(scope, "snapshot", {}, target.tabId),
              signal,
            ),
          click: (clickInput) =>
            runBrokerPromise(invokeBroker(scope, "click", clickInput, target.tabId), signal),
          type: (typeInput) =>
            runBrokerPromise(invokeBroker(scope, "type", typeInput, target.tabId), signal),
          press: (pressInput) =>
            runBrokerPromise(invokeBroker(scope, "press", pressInput, target.tabId), signal),
          scroll: (scrollInput) =>
            runBrokerPromise(invokeBroker(scope, "scroll", scrollInput, target.tabId), signal),
        });
        const task = Effect.acquireUseRelease(
          Effect.sync(() => new AbortController()).pipe(
            Effect.flatMap((controller) =>
              Effect.try({
                try: () => ({
                  controller,
                  agent: runtime.createAgent(
                    new T3PreviewInterface(operationsFor(controller.signal), runtime.defineActions),
                    target.modelConfig,
                  ),
                }),
                catch: (cause) => new PreviewMidsceneStageFailure("initialize", cause),
              }),
            ),
          ),
          ({ agent, controller }) =>
            Effect.tryPromise({
              try: (signal) => {
                signal.addEventListener("abort", () => controller.abort(signal.reason), {
                  once: true,
                });
                return run(agent, controller.signal);
              },
              catch: (cause) => new PreviewMidsceneStageFailure("execute", cause),
            }).pipe(
              Effect.map((result) => ({
                tabId: target.tabId,
                value: result.value,
                usage: result.usage ?? usageFromMetrics(agent.metrics()),
              })),
            ),
          ({ agent, controller }, exit) => {
            controller.abort();
            return Effect.tryPromise({
              try: () => agent.destroy(),
              catch: (cause) => new PreviewMidsceneStageFailure("cleanup", cause),
            }).pipe(
              Effect.catch((error) => (Exit.isSuccess(exit) ? Effect.fail(error) : Effect.void)),
            );
          },
        ).pipe(
          Effect.catch((cause): Effect.Effect<never, PreviewMidsceneError> => {
            const brokerError = findPreviewAutomationError(cause);
            if (brokerError) return Effect.fail(brokerError);
            const failure = cause instanceof PreviewMidsceneStageFailure ? cause : undefined;
            return Effect.fail(
              new PreviewMidsceneExecutionError({
                operation,
                stage: failure?.stage ?? "execute",
                tabId: target.tabId,
              }),
            );
          }),
        );
        return yield* lock.withPermit(task);
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              new PreviewMidsceneExecutionError({
                operation,
                stage: "execute",
                ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
              }),
            ),
        }),
      );

    const act: PreviewMidsceneServiceShape["act"] = Effect.fn("PreviewMidsceneService.act")(
      function* (scope, input) {
        const result = yield* execute(scope, input, "act", async (agent, signal) => ({
          value: await agent.act(input.instruction, {
            signal,
            ...(input.deepThink === undefined ? {} : { deepThink: input.deepThink }),
            ...(input.deepLocate === undefined ? {} : { deepLocate: input.deepLocate }),
          }),
        }));
        return { tabId: result.tabId, output: result.value ?? null, usage: result.usage };
      },
    );

    const query: PreviewMidsceneServiceShape["query"] = Effect.fn("PreviewMidsceneService.query")(
      function* (scope, input) {
        const result = yield* execute(scope, input, "query", async (agent, signal) => {
          const queryResult = await agent.query(input.demand, signal);
          return { value: queryResult.value, usage: usageFromCall(queryResult.usage) };
        });
        const value = yield* canonicalizeQueryValue(result.tabId, result.value);
        return { tabId: result.tabId, value, usage: result.usage };
      },
    );

    const assert: PreviewMidsceneServiceShape["assert"] = Effect.fn(
      "PreviewMidsceneService.assert",
    )(function* (scope, input) {
      const result = yield* execute(scope, input, "assert", async (agent, signal) => ({
        value: await agent.assert(input.assertion, signal),
      }));
      return {
        tabId: result.tabId,
        pass: result.value.pass,
        reason: result.value.reason,
        usage: result.usage,
      };
    });

    return PreviewMidsceneService.of({ act, query, assert });
  });

export const make = Effect.gen(function* PreviewMidsceneServiceMakeLive() {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  return yield* makeWithEnvironment(
    process.env,
    serverSettings.getSettings.pipe(Effect.map((settings) => settings.midscene)),
  );
});

export const layer = Layer.effect(PreviewMidsceneService, make);
