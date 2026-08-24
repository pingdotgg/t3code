import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationError,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewMidsceneService from "./PreviewMidsceneService.ts";
import * as PreviewMidsceneRuntime from "./preview-midscene/PreviewMidsceneRuntime.ts";

const environmentId = EnvironmentId.make("environment-midscene-service-test");
const threadId = ThreadId.make("thread-midscene-service-test");
const tabId = PreviewTabId.make("tab-midscene-service-test");
const providerInstanceId = ProviderInstanceId.make("codex");

const scope: McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-midscene-service-test",
  providerInstanceId,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const configuredEnvironment: NodeJS.ProcessEnv = {
  MIDSCENE_MODEL_API_KEY: "test-key",
  MIDSCENE_MODEL_NAME: "test-model",
  MIDSCENE_MODEL_FAMILY: "gpt-5",
  MIDSCENE_MODEL_BASE_URL: "https://model.example.test/v1",
};

const status: PreviewAutomationStatus = {
  available: true,
  visible: true,
  tabId,
  url: "https://example.test/",
  title: "Example",
  loading: false,
  viewport: { width: 1280, height: 720 },
};

const metrics = {
  totalPromptTokens: 12,
  totalCompletionTokens: 3,
  totalTokens: 15,
  totalCachedInput: 2,
  totalTimeCostMs: 40,
  calls: 1,
  byIntent: {},
  byModel: {},
};

type BrokerInvoke = (
  request: PreviewAutomationBroker.PreviewAutomationInvokeInput,
) => Effect.Effect<unknown, PreviewAutomationError>;

const makeBroker = (invoke: BrokerInvoke) =>
  PreviewAutomationBroker.PreviewAutomationBroker.of({
    connect: () => Effect.die("unused"),
    focusHost: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
    invoke: (request) => invoke(request) as Effect.Effect<never, PreviewAutomationError>,
  });

const makeRuntime = (
  createAgent: PreviewMidsceneRuntime.LoadedPreviewMidsceneRuntime["createAgent"],
) =>
  PreviewMidsceneRuntime.PreviewMidsceneRuntime.of({
    load: () =>
      Effect.succeed({
        defineActions: () => [],
        createAgent,
      }),
  });

const makeAgent = (
  overrides: Partial<PreviewMidsceneRuntime.PreviewMidsceneAgentHandle> = {},
): PreviewMidsceneRuntime.PreviewMidsceneAgentHandle => ({
  act: async () => "done",
  query: async () => ({ value: null }),
  assert: async () => ({ pass: true, reason: null }),
  metrics: () => metrics,
  destroy: async () => {},
  ...overrides,
});

const makeService = (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  runtime: PreviewMidsceneRuntime.PreviewMidsceneRuntime["Service"],
  environment: NodeJS.ProcessEnv = configuredEnvironment,
) =>
  PreviewMidsceneService.makeWithEnvironment(environment).pipe(
    Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
    Effect.provideService(PreviewMidsceneRuntime.PreviewMidsceneRuntime, runtime),
  );

it.effect("reports missing model configuration before invoking the preview broker", () => {
  let brokerCalls = 0;
  const broker = makeBroker(() => {
    brokerCalls += 1;
    return Effect.succeed(status);
  });
  const runtime = makeRuntime(() => makeAgent());

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime, {});
    const error = yield* Effect.flip(
      service.act(scope, { instruction: "Click the visible submit button" }),
    );

    expect(error._tag).toBe("PreviewMidsceneConfigurationError");
    if (error._tag === "PreviewMidsceneConfigurationError") {
      expect(error.missingVariables).toEqual([
        "MIDSCENE_MODEL_API_KEY",
        "MIDSCENE_MODEL_NAME",
        "MIDSCENE_MODEL_FAMILY",
        "MIDSCENE_MODEL_BASE_URL (or legacy OPENAI_BASE_URL)",
      ]);
    }
    expect(brokerCalls).toBe(0);
  });
});

it("accepts the canonical or legacy model base URL using Midscene's precedence", () => {
  const withoutBaseUrl = { ...configuredEnvironment };
  delete withoutBaseUrl.MIDSCENE_MODEL_BASE_URL;

  expect(PreviewMidsceneService.missingMidsceneModelVariables(configuredEnvironment)).toEqual([]);
  expect(
    PreviewMidsceneService.missingMidsceneModelVariables({
      ...withoutBaseUrl,
      OPENAI_BASE_URL: "https://legacy-model.example.test/v1",
    }),
  ).toEqual([]);
  expect(
    PreviewMidsceneService.missingMidsceneModelVariables({
      ...withoutBaseUrl,
      MIDSCENE_MODEL_BASE_URL: "   ",
      OPENAI_BASE_URL: "https://legacy-model.example.test/v1",
    }),
  ).toEqual(["MIDSCENE_MODEL_BASE_URL (or legacy OPENAI_BASE_URL)"]);
});

it.effect("applies live settings over environment variables when creating an agent", () => {
  const capturedConfigs: Array<Readonly<Record<string, string>>> = [];
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime((_device, modelConfig) => {
    capturedConfigs.push(modelConfig);
    return makeAgent();
  });

  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make({
      ...DEFAULT_SERVER_SETTINGS.midscene,
      modelApiKey: "settings-key",
      modelName: "settings-model",
      modelFamily: "settings-family",
      modelBaseUrl: "https://settings.example.test/v1",
    });
    const service = yield* PreviewMidsceneService.makeWithEnvironment(
      {
        ...configuredEnvironment,
        MIDSCENE_PLANNING_MODEL_NAME: "planning-model",
        UNRELATED_SECRET: "must-not-be-forwarded",
      },
      Ref.get(settingsRef),
    ).pipe(
      Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
      Effect.provideService(PreviewMidsceneRuntime.PreviewMidsceneRuntime, runtime),
    );

    yield* service.act(scope, { instruction: "Click submit" });
    yield* Ref.update(settingsRef, (current) => ({ ...current, modelName: "updated-model" }));
    yield* service.act(scope, { instruction: "Click cancel" });

    expect(capturedConfigs).toHaveLength(2);
    expect(capturedConfigs[0]).toMatchObject({
      MIDSCENE_MODEL_API_KEY: "settings-key",
      MIDSCENE_MODEL_NAME: "settings-model",
      MIDSCENE_MODEL_FAMILY: "settings-family",
      MIDSCENE_MODEL_BASE_URL: "https://settings.example.test/v1",
      MIDSCENE_PLANNING_MODEL_NAME: "planning-model",
    });
    expect(capturedConfigs[0]).not.toHaveProperty("UNRELATED_SECRET");
    expect(capturedConfigs[1]?.MIDSCENE_MODEL_NAME).toBe("updated-model");
  });
});

it.effect("pins the resolved tab and returns bounded query and assertion results", () => {
  const requests: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
  let destroyed = 0;
  const broker = makeBroker((request) => {
    requests.push(request);
    return Effect.succeed(status);
  });
  const runtime = makeRuntime(() =>
    makeAgent({
      query: async () => ({
        value: { heading: "Welcome", items: ["One", "Two"] },
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
          cached_input: 1,
          time_cost: 25,
          model_name: "test-model",
          model_description: undefined,
          response_model_name: "test-model",
          intent: "insight",
          slot: "insight",
          request_id: "request-1",
        },
      }),
      assert: async () => ({ pass: false, reason: "The dialog is still visible." }),
      destroy: async () => {
        destroyed += 1;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const query = yield* service.query(scope, { demand: "object, visible heading and items" });
    const assertion = yield* service.assert(scope, { assertion: "The dialog is closed" });

    expect(query).toEqual({
      tabId,
      value: { heading: "Welcome", items: ["One", "Two"] },
      usage: {
        promptTokens: 8,
        completionTokens: 2,
        totalTokens: 10,
        cachedInputTokens: 1,
        modelTimeMs: 25,
        calls: 1,
      },
    });
    expect(assertion).toMatchObject({
      tabId,
      pass: false,
      reason: "The dialog is still visible.",
    });
    expect(destroyed).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.operation === "status")).toBe(true);
    expect(requests.every((request) => request.tabId === undefined)).toBe(true);
  });
});

it.effect("reveals a hidden target tab before creating the Midscene agent", () => {
  const requests: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
  const { viewport: _viewport, ...hiddenStatus } = status;
  const broker = makeBroker((request) => {
    requests.push(request);
    if (request.operation === "status") {
      return Effect.succeed({ ...hiddenStatus, visible: false });
    }
    if (request.operation === "open") {
      return Effect.succeed(status);
    }
    return Effect.die(`Unexpected broker operation: ${request.operation}`);
  });
  const runtime = makeRuntime(() => makeAgent());

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const result = yield* service.act(scope, { instruction: "Click the visible submit button" });

    expect(result.output).toBe("done");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ operation: "status" });
    expect(requests[0]).not.toHaveProperty("tabId");
    expect(requests[1]).toMatchObject({
      operation: "open",
      tabId,
      input: { open: true, reuseExistingTab: true },
    });
  });
});

it.effect("stops before model execution when a hidden target cannot be revealed", () => {
  let agentCreated = false;
  const broker = makeBroker((request) =>
    request.operation === "status"
      ? Effect.succeed({ ...status, visible: false })
      : Effect.succeed({ ...status, visible: false }),
  );
  const runtime = makeRuntime(() => {
    agentCreated = true;
    return makeAgent();
  });

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const error = yield* Effect.flip(
      service.act(scope, { instruction: "Click the visible submit button" }),
    );

    expect(error).toMatchObject({
      _tag: "PreviewMidsceneExecutionError",
      operation: "act",
      stage: "observe",
      tabId,
    });
    expect(agentCreated).toBe(false);
  });
});

it.effect("preserves typed broker failures raised by Midscene device actions", () => {
  const requests: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
  let destroyed = false;
  const brokerError = new PreviewAutomationNoAvailableHostError({
    operation: "click",
    environmentId,
    threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId,
  });
  const broker = makeBroker((request) => {
    requests.push(request);
    return request.operation === "status" ? Effect.succeed(status) : Effect.fail(brokerError);
  });
  const runtime = makeRuntime((device) =>
    makeAgent({
      act: async () => {
        const pointer = device.inputPrimitives?.pointer;
        if (!pointer) throw new Error("The test device has no pointer input primitive.");
        await pointer.tap({ x: 200, y: 120 });
        return "unreachable";
      },
      destroy: async () => {
        destroyed = true;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const error = yield* Effect.flip(
      service.act(scope, { instruction: "Click the visible submit button" }),
    );

    expect(error).toBe(brokerError);
    expect(error._tag).toBe("PreviewAutomationNoAvailableHostError");
    expect(requests.map(({ operation }) => operation)).toEqual(["status", "click"]);
    expect(requests[1]?.tabId).toBe(tabId);
    expect(destroyed).toBe(true);
  });
});

it.effect("classifies model failures without exposing their raw cause", () => {
  let destroyed = false;
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime(() =>
    makeAgent({
      act: async () => {
        throw new Error("MODEL_SECRET_RESPONSE");
      },
      destroy: async () => {
        destroyed = true;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const error = yield* Effect.flip(
      service.act(scope, { instruction: "Complete the visible workflow" }),
    );

    expect(error._tag).toBe("PreviewMidsceneExecutionError");
    expect(error.message).not.toContain("MODEL_SECRET_RESPONSE");
    expect("cause" in error).toBe(false);
    expect(destroyed).toBe(true);
  });
});

it.effect("classifies assertion execution failures instead of returning a false assertion", () => {
  let destroyed = false;
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime(() =>
    makeAgent({
      assert: async () => {
        throw new Error("RAW_ASSERTION_PROVIDER_ERROR");
      },
      destroy: async () => {
        destroyed = true;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const error = yield* Effect.flip(service.assert(scope, { assertion: "The dialog is closed" }));

    expect(error._tag).toBe("PreviewMidsceneExecutionError");
    expect(error.message).not.toContain("RAW_ASSERTION_PROVIDER_ERROR");
    expect("reason" in error).toBe(false);
    expect(destroyed).toBe(true);
  });
});

it.effect("rejects oversized query results after destroying the agent", () => {
  let destroyed = false;
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime(() =>
    makeAgent({
      query: async () => ({ value: { content: "x".repeat(70 * 1024) } }),
      destroy: async () => {
        destroyed = true;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const error = yield* Effect.flip(service.query(scope, { demand: "string, page content" }));

    expect(error._tag).toBe("PreviewMidsceneResultTooLargeError");
    expect(destroyed).toBe(true);
  });
});

it.effect("aborts and destroys the agent before returning a semantic timeout", () => {
  let aborted = false;
  let destroyed = false;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime(() =>
    makeAgent({
      act: (_instruction, { signal }) =>
        new Promise((_resolve, reject) => {
          signalStarted?.();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      destroy: async () => {
        destroyed = true;
      },
    }),
  );

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const errorFiber = yield* service
      .act(scope, {
        instruction: "Wait for a state that never appears",
        timeoutMs: 10,
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => started);
    yield* TestClock.adjust(Duration.millis(10));
    const error = yield* Fiber.join(errorFiber);

    expect(error._tag).toBe("PreviewMidsceneExecutionError");
    expect(aborted).toBe(true);
    expect(destroyed).toBe(true);
  });
});

it.effect("serializes semantic operations for the same environment and tab", () => {
  let active = 0;
  let maximumActive = 0;
  let created = 0;
  let releaseFirst: (() => void) | undefined;
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const broker = makeBroker(() => Effect.succeed(status));
  const runtime = makeRuntime(() => {
    created += 1;
    const ordinal = created;
    return makeAgent({
      act: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (ordinal === 1) {
          signalFirstStarted?.();
          await firstGate;
        }
        active -= 1;
        return `operation-${ordinal}`;
      },
    });
  });

  return Effect.gen(function* () {
    const service = yield* makeService(broker, runtime);
    const first = yield* service
      .act(scope, { instruction: "Run the first operation" })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => firstStarted);
    const second = yield* service
      .act(scope, { instruction: "Run the second operation" })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    expect(created).toBe(1);
    expect(active).toBe(1);
    releaseFirst?.();

    const firstResult = yield* Fiber.join(first);
    const secondResult = yield* Fiber.join(second);
    expect(firstResult.output).toBe("operation-1");
    expect(secondResult.output).toBe("operation-2");
    expect(maximumActive).toBe(1);
  });
});
