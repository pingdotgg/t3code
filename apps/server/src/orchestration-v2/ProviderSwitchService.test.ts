import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  SkillTurnResolution,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as SkillUsage from "../skills/SkillUsageService.ts";
import * as SkillVariants from "../skills/SkillVariantService.ts";
import type { ActivatedSkillContext } from "../skills/skillContextContamination.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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

function deadSessionRecord(
  id: string,
  status: "stopped" | "error",
  updatedAt: DateTime.Utc = DateTime.add(now, { seconds: 1 }),
) {
  return {
    ...projection().providerSessions[0]!,
    id: ProviderSessionId.make(id),
    status,
    updatedAt,
  };
}

function layerTest(
  metadata: Readonly<Record<string, { continuationKey: string }>>,
  planSelectionTransition: ProviderAdapter.ProviderAdapterV2["Service"]["planSelectionTransition"] = () =>
    Effect.succeed({ type: "restart_session" }),
  skillContext: {
    readonly activated?: ReadonlyArray<ActivatedSkillContext>;
    readonly activatedFailure?: Error;
    readonly targetResolution?: SkillTurnResolution;
    readonly onResolvePolicy?: () => void;
  } = {},
) {
  const adapter = (
    instanceId: ProviderInstanceId,
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilitiesWithoutModelSwitch),
    planSelectionTransition,
    openSession: () => Effect.die("ProviderSwitchService tests do not open sessions."),
  });
  const layerRegistry = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
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
  const layerSkillUsage = Layer.mock(SkillUsage.SkillUsageService)({
    activatedOnProviderThread: () =>
      skillContext.activatedFailure === undefined
        ? Effect.succeed(skillContext.activated ?? [])
        : Effect.fail(
            new SkillUsage.SkillUsagePersistenceError({
              operation: "load activated skills",
              cause: skillContext.activatedFailure,
            }),
          ),
  });
  const layerSkillVariants = Layer.mock(SkillVariants.SkillVariantService)({
    resolvePolicy: () =>
      Effect.sync(() => {
        skillContext.onResolvePolicy?.();
        return (
          skillContext.targetResolution ??
          SkillTurnResolution.make({ entries: [], hash: "empty-resolution" })
        );
      }),
    materialize: () => Effect.die("Provider switch planning must not materialize variants."),
  });
  return ProviderSwitch.layer.pipe(
    Layer.provide(Layer.mergeAll(layerRegistry, layerSkillUsage, layerSkillVariants)),
  );
}

it.effect("releases the newest live session, not the newest record overall", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const thread = projection();
    const newerLiveSessionId = ProviderSessionId.make("session_newer_live");
    const result = yield* service.plan({
      projection: {
        ...thread,
        providerSessions: [
          ...thread.providerSessions,
          {
            ...thread.providerSessions[0]!,
            id: newerLiveSessionId,
            updatedAt: DateTime.add(now, { seconds: 1 }),
          },
          deadSessionRecord("dead_session", "stopped", DateTime.add(now, { seconds: 2 })),
        ],
      },
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "restart_and_resume");
    assert.deepEqual(result.releaseProviderSessionIds, [newerLiveSessionId]);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

it.effect("creates a fresh session with handoff when every recorded session is dead", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const thread = projection();
    const result = yield* service.plan({
      projection: {
        ...thread,
        providerSessions: [
          deadSessionRecord("dead_session_older", "stopped"),
          deadSessionRecord("dead_session_newer", "error", DateTime.add(now, { seconds: 2 })),
        ],
      },
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "create_with_handoff");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

function deadNativeThreadProjection(
  status: "stopped" | "error",
  capabilities = capabilitiesWithoutModelSwitch,
): OrchestrationV2ThreadProjection {
  const thread = projection();
  return {
    ...thread,
    thread: {
      ...thread.thread,
      activeProviderThreadId: ProviderThreadId.make("provider-thread:native"),
    },
    providerSessions: [{ ...deadSessionRecord("dead_session", status), capabilities }],
    providerThreads: [
      {
        id: ProviderThreadId.make("provider-thread:native"),
        driver,
        providerInstanceId: currentInstanceId,
        providerSessionId: ProviderSessionId.make("dead_session"),
        appThreadId: thread.thread.id,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:abc",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  } as OrchestrationV2ThreadProjection;
}

it.effect("falls back to the native provider thread when every recorded session is dead", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped"),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "restart_and_resume");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }),
    ),
  ),
);

it.effect("hands off from a native provider thread after its session detaches", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: { ...deadNativeThreadProjection("stopped"), providerSessions: [] },
      targetModelSelection: {
        instanceId: ProviderInstanceId.make("codex_other"),
        model: "gpt-5.2-codex",
      },
    });
    assert.equal(result.transition.type, "create_with_handoff");
    assert.deepEqual(result.releaseProviderSessionIds, []);
  }).pipe(
    Effect.provide(
      layerTest({
        [currentInstanceId]: { continuationKey: "codex:account:primary" },
        codex_other: { continuationKey: "codex:account:other" },
      }),
    ),
  ),
);

it.effect("carries skill context omissions across incompatible instances", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: {
        instanceId: ProviderInstanceId.make("codex_other"),
        model: "gpt-5.2-codex",
      },
    });
    assert.deepEqual(result.transition, {
      type: "create_with_handoff",
      skillContextOmissions: [
        {
          skillName: "review",
          variantPaths: ["/state/skill-variants/old-hash/SKILL.md"],
          skillPaths: ["/home/user/.claude/skills/review/SKILL.md"],
        },
      ],
    });
  }).pipe(
    Effect.provide(
      layerTest(
        {
          [currentInstanceId]: { continuationKey: "codex:account:primary" },
          codex_other: { continuationKey: "codex:account:other" },
        },
        undefined,
        {
          activated: [
            {
              skillName: "review",
              mode: "variant",
              contentHash: "old-hash",
              variantPath: "/state/skill-variants/old-hash/SKILL.md",
              skillPath: "/home/user/.claude/skills/review/SKILL.md",
            },
          ],
          targetResolution: SkillTurnResolution.make({
            entries: [
              {
                skillName: "review",
                ruleId: "rule:review-off",
                revision: 1,
                mode: "off",
                contentHash: null,
                variantPath: null,
                origin: "rule",
              },
            ],
            hash: "off-resolution",
          }),
        },
      ),
    ),
  ),
);

it.effect.each(["stopped", "error"] as const)(
  "applies a model change on next turn when a %s session negotiated model switching",
  (deadStatus) =>
    Effect.gen(function* () {
      const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
      const result = yield* service.plan({
        projection: deadNativeThreadProjection(deadStatus, CodexProviderCapabilitiesV2),
        targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
      });
      assert.equal(result.transition.type, "switch_model_in_session");
      assert.deepEqual(result.releaseProviderSessionIds, []);
    }).pipe(
      Effect.provide(
        layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }, (input) =>
          Effect.succeed(acpSelectionTransition(input)),
        ),
      ),
    ),
);

it.effect("creates a sanitized handoff when an activated variant is disabled", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.deepEqual(result.transition, {
      type: "create_with_handoff",
      skillContextOmissions: [
        {
          skillName: "review",
          variantPaths: ["/state/skill-variants/old-hash/SKILL.md"],
          skillPaths: ["/home/user/.claude/skills/review/SKILL.md"],
        },
      ],
    });
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        {
          activated: [
            {
              skillName: "review",
              mode: "variant",
              contentHash: "old-hash",
              variantPath: "/state/skill-variants/old-hash/SKILL.md",
              skillPath: "/home/user/.claude/skills/review/SKILL.md",
            },
          ],
          targetResolution: SkillTurnResolution.make({
            entries: [
              {
                skillName: "review",
                ruleId: "rule:review-off",
                revision: 1,
                mode: "off",
                contentHash: null,
                variantPath: null,
                origin: "rule",
              },
            ],
            hash: "off-resolution",
          }),
        },
      ),
    ),
  ),
);

it.effect("creates a sanitized handoff for a same-model skill policy change", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: projection().thread.modelSelection,
    });
    assert.deepEqual(result.transition, {
      type: "create_with_handoff",
      skillContextOmissions: [
        {
          skillName: "review",
          variantPaths: ["/state/skill-variants/old-hash/SKILL.md"],
          skillPaths: ["/home/user/.claude/skills/review/SKILL.md"],
        },
      ],
    });
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        {
          activated: [
            {
              skillName: "review",
              mode: "variant",
              contentHash: "old-hash",
              variantPath: "/state/skill-variants/old-hash/SKILL.md",
              skillPath: "/home/user/.claude/skills/review/SKILL.md",
            },
          ],
          targetResolution: SkillTurnResolution.make({
            entries: [
              {
                skillName: "review",
                ruleId: "rule:review-new",
                revision: 2,
                mode: "variant",
                contentHash: "new-hash",
                variantPath: "/state/skill-variants/new-hash/SKILL.md",
                origin: "rule",
              },
            ],
            hash: "new-resolution",
          }),
        },
      ),
    ),
  ),
);

it.effect("skips policy resolution when the reusable provider thread has no skill evidence", () => {
  let policyResolutions = 0;
  return Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: projection().thread.modelSelection,
    });
    assert.equal(result.transition.type, "reuse");
    assert.equal(policyResolutions, 0);
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        { onResolvePolicy: () => policyResolutions++ },
      ),
    ),
  );
});

it.effect("keeps the normal switch when contamination lookup fails", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "switch_model_in_session");
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        { activatedFailure: new Error("skill evidence is unavailable") },
      ),
    ),
  ),
);

it.effect("keeps the normal switch when the disabled skill was never activated", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "switch_model_in_session");
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        {
          targetResolution: SkillTurnResolution.make({
            entries: [
              {
                skillName: "review",
                ruleId: "rule:review-off",
                revision: 1,
                mode: "off",
                contentHash: null,
                variantPath: null,
                origin: "rule",
              },
            ],
            hash: "off-resolution",
          }),
        },
      ),
    ),
  ),
);

it.effect("keeps the normal switch when the activated variant is unchanged", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service.plan({
      projection: deadNativeThreadProjection("stopped", CodexProviderCapabilitiesV2),
      targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
    });
    assert.equal(result.transition.type, "switch_model_in_session");
  }).pipe(
    Effect.provide(
      layerTest(
        { [currentInstanceId]: { continuationKey: "codex:account:primary" } },
        (input) => Effect.succeed(acpSelectionTransition(input)),
        {
          activated: [
            {
              skillName: "review",
              mode: "variant",
              contentHash: "same-hash",
              variantPath: "/state/skill-variants/same-hash/SKILL.md",
              skillPath: "/home/user/.claude/skills/review/SKILL.md",
            },
          ],
          targetResolution: SkillTurnResolution.make({
            entries: [
              {
                skillName: "review",
                ruleId: "rule:review",
                revision: 2,
                mode: "variant",
                contentHash: "same-hash",
                variantPath: "/state/skill-variants/same-hash/SKILL.md",
                origin: "rule",
              },
            ],
            hash: "same-resolution",
          }),
        },
      ),
    ),
  ),
);

it.effect("rejects a model change the dead record never negotiated support for", () =>
  Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    const result = yield* service
      .plan({
        projection: deadNativeThreadProjection("stopped"),
        targetModelSelection: { instanceId: currentInstanceId, model: "gpt-5.2-codex" },
      })
      .pipe(Effect.flip);
    assert.instanceOf(result, ProviderSwitch.ProviderSwitchPlanError);
  }).pipe(
    Effect.provide(
      layerTest({ [currentInstanceId]: { continuationKey: "codex:account:primary" } }, (input) =>
        Effect.succeed(acpSelectionTransition(input)),
      ),
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
      layerTest({
        [currentInstanceId]: { continuationKey: "codex:account:primary" },
        codex_compatible: { continuationKey: "codex:account:primary" },
        codex_incompatible: { continuationKey: "codex:account:other" },
      }),
    ),
  ),
);
