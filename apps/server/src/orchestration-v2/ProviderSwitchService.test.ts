import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AcpProviderCapabilitiesV2 } from "./Adapters/AcpAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  GROK_REASONING_EFFORT_OPTION_ID,
  resolveGrokSpawnOptionValue,
} from "../provider/acp/GrokAcpSupport.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { acpSelectionTransition } from "./ProviderSelectionTransition.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";

const isProviderSwitchPlanError = Schema.is(ProviderSwitch.ProviderSwitchPlanError);

const driver = ProviderDriverKind.make("codex");
const currentInstanceId = ProviderInstanceId.make("codex_primary");
const currentSessionId = ProviderSessionId.make("session_primary");
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const capabilitiesWithoutModelSwitch = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: false,
  },
};
const grokCapabilitiesWithModelSwitch = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
};

function projection(): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: ThreadId.make("thread_switch_service"),
      modelSelection: { instanceId: currentInstanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/repo",
    },
    providerSessions: [
      {
        id: currentSessionId,
        providerInstanceId: currentInstanceId,
        status: "ready",
        cwd: "/repo",
        capabilities: capabilitiesWithoutModelSwitch,
        updatedAt: now,
      },
    ],
    providerThreads: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function testLayer(metadata: Readonly<Record<string, { continuationKey: string }>>) {
  const adapter = (instanceId: ProviderInstanceId): ProviderAdapterV2Shape => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilitiesWithoutModelSwitch),
    planSelectionTransition: () => Effect.succeed({ type: "restart_session" }),
    openSession: () => Effect.die("ProviderSwitchService tests do not open sessions."),
  });
  const registry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
    get: (instanceId) =>
      metadata[instanceId] === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed(adapter(instanceId)),
    list: () => Effect.succeed(Object.keys(metadata).map((id) => ProviderInstanceId.make(id))),
    getMetadata: (instanceId) => {
      const value = metadata[instanceId];
      return value === undefined
        ? Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          )
        : Effect.succeed({
            driver,
            continuationKey: value.continuationKey,
            enabled: true,
            capabilities: capabilitiesWithoutModelSwitch,
          });
    },
  });
  return ProviderSwitch.layer.pipe(Layer.provide(registry));
}

function grokTestLayer() {
  const grokDriver = ProviderDriverKind.make("grok");
  const adapter: ProviderAdapterV2Shape = {
    instanceId: currentInstanceId,
    driver: grokDriver,
    getCapabilities: () => Effect.succeed(grokCapabilitiesWithModelSwitch),
    planSelectionTransition: (input) =>
      Effect.succeed(
        acpSelectionTransition({
          ...input,
          spawnOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
          resolveSpawnOptionValue: resolveGrokSpawnOptionValue,
        }),
      ),
    openSession: () => Effect.die("ProviderSwitchService tests do not open sessions."),
  };
  const registry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
    get: () => Effect.succeed(adapter),
    list: () => Effect.succeed([currentInstanceId]),
    getMetadata: () =>
      Effect.succeed({
        driver: grokDriver,
        continuationKey: "grok:account:primary",
        enabled: true,
        capabilities: grokCapabilitiesWithModelSwitch,
      }),
  });
  return ProviderSwitch.layer.pipe(Layer.provide(registry));
}

function grokProjection(): OrchestrationV2ThreadProjection {
  const current = projection();
  return {
    ...current,
    thread: {
      ...current.thread,
      modelSelection: { instanceId: currentInstanceId, model: "grok-4.5" },
    },
    providerSessions: current.providerSessions.map((session) => ({
      ...session,
      capabilities: grokCapabilitiesWithModelSwitch,
    })),
  };
}

it.effect(
  "restarts and releases the current session for unsupported in-session model changes",
  () =>
    Effect.gen(function* () {
      const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
      const result = yield* service.plan({
        projection: projection(),
        targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
      });
      assert.equal(result.transition.type, "restart_and_resume");
      assert.deepEqual(result.releaseProviderSessionIds, [currentSessionId]);
    }).pipe(
      Effect.provide(
        testLayer({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
      ),
    ),
);

it.effect("distinguishes compatible and incompatible instances of the same driver", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const compatibleId = ProviderInstanceId.make("codex_compatible");
    const incompatibleId = ProviderInstanceId.make("codex_incompatible");
    const compatible = yield* service.plan({
      projection: projection(),
      targetModelSelection: { instanceId: compatibleId, model: "gpt-5.1-codex" },
    });
    const incompatible = yield* service.plan({
      projection: projection(),
      targetModelSelection: { instanceId: incompatibleId, model: "gpt-5.1-codex" },
    });
    assert.equal(compatible.transition.type, "restart_and_resume");
    assert.equal(incompatible.transition.type, "create_with_handoff");
  }).pipe(
    Effect.provide(
      testLayer({
        [currentInstanceId]: { continuationKey: "codex:account:primary" },
        codex_compatible: { continuationKey: "codex:account:primary" },
        codex_incompatible: { continuationKey: "codex:account:other" },
      }),
    ),
  ),
);

it.effect("plans Grok spawn-bound option changes through the live service seam", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const explicitHigh = yield* service.plan({
      projection: grokProjection(),
      targetModelSelection: {
        instanceId: currentInstanceId,
        model: "grok-4.5",
        options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "high" }],
      },
    });
    assert.equal(explicitHigh.transition.type, "switch_model_in_session");

    const changedEffort = yield* Effect.flip(
      service.plan({
        projection: grokProjection(),
        targetModelSelection: {
          instanceId: currentInstanceId,
          model: "grok-4.5",
          options: [{ id: GROK_REASONING_EFFORT_OPTION_ID, value: "low" }],
        },
      }),
    );
    assert.isTrue(isProviderSwitchPlanError(changedEffort.cause));
    if (isProviderSwitchPlanError(changedEffort.cause)) {
      assert.include(String(changedEffort.cause.cause), "spawn-bound option");
    }

    const changedModel = yield* service.plan({
      projection: grokProjection(),
      targetModelSelection: { instanceId: currentInstanceId, model: "grok-build" },
    });
    assert.equal(changedModel.transition.type, "switch_model_in_session");
  }).pipe(Effect.provide(grokTestLayer())),
);
