import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import type { ProviderAdapterDriver } from "./ProviderAdapterDriver.ts";
import {
  makeDriverLayerFromSettings,
  ProviderAdapterRegistryV2,
} from "./ProviderAdapterRegistry.ts";

const capabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const FakeConfig = Schema.Struct({});
type FakeConfig = typeof FakeConfig.Type;

function makeFakeDriver(driverKind: ProviderDriverKind): ProviderAdapterDriver<FakeConfig> {
  return {
    driverKind,
    configSchema: FakeConfig,
    defaultConfig: () => ({}),
    create: ({ instanceId }) =>
      Effect.succeed({
        instanceId,
        provider: driverKind,
        getCapabilities: () => Effect.succeed(capabilities),
        openSession: () => Effect.die("fake adapter does not open sessions"),
      }),
  };
}

const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexWork = ProviderInstanceId.make("codex_work");
const claudeWork = ProviderInstanceId.make("claude_work");
const TestSettingsLayer = ServerSettingsService.layerTest({
  providerInstances: {
    [codexWork]: { driver: codexDriver, config: {} },
    [claudeWork]: { driver: claudeDriver, config: {} },
  },
});
const TestLayer = makeDriverLayerFromSettings({
  drivers: [makeFakeDriver(codexDriver), makeFakeDriver(claudeDriver)],
}).pipe(Layer.provideMerge(TestSettingsLayer));

it.effect("builds one V2 adapter per configured provider instance", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistryV2;
    const instances = yield* registry.list();
    const codexWorkAdapter = yield* registry.get(codexWork);
    const claudeWorkAdapter = yield* registry.get(claudeWork);

    assert.deepEqual(instances, [
      codexWork,
      claudeWork,
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]);
    assert.equal(codexWorkAdapter.instanceId, codexWork);
    assert.equal(claudeWorkAdapter.instanceId, claudeWork);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("resolves provider instances added after the V2 registry was constructed", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistryV2;
    const settings = yield* ServerSettingsService;
    const codexAfterStart = ProviderInstanceId.make("codex_after_start");

    yield* settings.updateSettings({
      providerInstances: {
        [codexAfterStart]: { driver: codexDriver, config: {} },
      },
    });

    const adapter = yield* registry.get(codexAfterStart);
    const instances = yield* registry.list();

    assert.equal(adapter.instanceId, codexAfterStart);
    assert.isTrue(instances.includes(codexAfterStart));
  }).pipe(Effect.provide(TestLayer)),
);
