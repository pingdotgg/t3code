import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";

import { computeThreadMoveAvailability, createThreadMovePlanner } from "./threadOrder";
import { makeThreadShellFixture } from "../../test-fixtures";
import { createThreadListEnvironmentsAtom } from "../../state/thread-list-environments";

import {
  createThreadRowProviderInstanceResolver,
  resolveThreadProviderInstance,
} from "./thread-provider-instance";

function makeConfig(
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly displayName?: string;
    readonly accentColor?: string;
  }>,
): ServerConfig {
  return {
    providers: providers.map((provider) => ({ enabled: true, ...provider })),
    environment: { capabilities: {}, platform: { machine: "laptop" } },
    settings: {},
  } as unknown as ServerConfig;
}

function makeThread(environmentId: EnvironmentId, instanceId: string): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestRun: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as EnvironmentThreadShell;
}

describe("resolveThreadProviderInstance", () => {
  it("resolves two environments with the same default instance id independently", () => {
    const environmentA = EnvironmentId.make("environment-a");
    const environmentB = EnvironmentId.make("environment-b");
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [
        environmentA,
        makeConfig([{ instanceId: "codex", driver: "codex", accentColor: "#ff8800" }]),
      ],
      [environmentB, makeConfig([{ instanceId: "codex", driver: "codex" }])],
    ]);

    const threadA = makeThread(environmentA, "codex");
    const threadB = makeThread(environmentB, "codex");

    expect(
      resolveThreadProviderInstance(serverConfigs.get(environmentA)?.providers, threadA)
        ?.accentColor,
    ).toBe("#ff8800");
    expect(
      resolveThreadProviderInstance(serverConfigs.get(environmentB)?.providers, threadB)
        ?.accentColor,
    ).toBeUndefined();
  });

  it("uses the current runtime owner after a provider handoff", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [
        environmentId,
        makeConfig([
          { instanceId: "claudeAgent", driver: "claudeAgent" },
          { instanceId: "codex", driver: "codex", displayName: "Codex" },
          { instanceId: "codex_work", driver: "codex", displayName: "Codex" },
        ]),
      ],
    ]);
    const thread = {
      ...makeThread(environmentId, "claudeAgent"),
      runtime: {
        status: "running" as const,
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-06-01T00:01:00.000Z",
      },
    };

    expect(
      resolveThreadProviderInstance(serverConfigs.get(environmentId)?.providers, thread),
    ).toMatchObject({
      driverKind: "codex",
      displayName: "Codex Work",
      showBadge: true,
    });
  });
});

describe("createThreadRowProviderInstanceResolver", () => {
  it("updates thread badges through the environment projection when a sibling is disabled and re-enabled", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const personal = makeThread(environmentId, "codex");
    const work = makeThread(environmentId, "codex_work");
    const config = makeConfig([
      { instanceId: "codex", driver: "codex" },
      { instanceId: "codex_work", driver: "codex" },
    ]);
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[environmentId, config]]),
    );
    const environments = createThreadListEnvironmentsAtom(configs, Atom.make([environmentId]));
    const registry = AtomRegistry.make();
    registry.mount(environments);
    try {
      const before = createThreadRowProviderInstanceResolver(
        registry.get(environments).providersByEnvironmentId,
      );
      expect(before(personal)?.showBadge).toBe(true);
      expect(before(work)?.showBadge).toBe(true);

      registry.set(
        configs,
        new Map([
          [
            environmentId,
            {
              ...config,
              providers: config.providers.map((provider) =>
                provider.instanceId === "codex_work" ? { ...provider, enabled: false } : provider,
              ),
            },
          ],
        ]),
      );
      const disabled = createThreadRowProviderInstanceResolver(
        registry.get(environments).providersByEnvironmentId,
      );
      expect(disabled(personal)?.showBadge).toBe(false);
      expect(disabled(work)?.showBadge).toBe(true);

      registry.set(configs, new Map([[environmentId, config]]));
      const restored = createThreadRowProviderInstanceResolver(
        registry.get(environments).providersByEnvironmentId,
      );
      expect(restored(personal)?.showBadge).toBe(true);
      expect(restored(work)?.showBadge).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});

describe("thread list reorder availability", () => {
  it.each(["active", "pinned"] as const)(
    "updates %s moves on disconnect and reconnect without changing cached config",
    (section) => {
      const onlineId = EnvironmentId.make("online");
      const offlineId = EnvironmentId.make("offline");
      const config = makeConfig([{ instanceId: "codex", driver: "codex" }]);
      const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
        new Map([
          [onlineId, config],
          [offlineId, config],
        ]),
      );
      const connected = Atom.make<ReadonlyArray<EnvironmentId>>([onlineId, offlineId]);
      const environments = createThreadListEnvironmentsAtom(configs, connected);
      const registry = AtomRegistry.make();
      registry.mount(environments);
      try {
        const ordered = [onlineId, offlineId].map((environmentId, index) =>
          makeThreadShellFixture({
            environmentId,
            id: ThreadId.make(`thread-${index}`),
            pinnedAt: section === "pinned" ? "2026-09-02T00:00:00.000Z" : null,
          }),
        );
        const movedId = `${onlineId}:thread-0`;
        const plannerInput = () => {
          const current = registry.get(environments);
          return {
            ordered,
            section,
            reorderableEnvironmentIds:
              section === "pinned"
                ? current.pinReorderEnvironmentIds
                : current.activeReorderEnvironmentIds,
          };
        };
        expect(createThreadMovePlanner(plannerInput())(movedId, "down")).toHaveLength(2);
        const before = registry.get(environments);

        registry.set(connected, [onlineId]);

        expect(createThreadMovePlanner(plannerInput())(movedId, "down")).toBeNull();
        expect(computeThreadMoveAvailability(plannerInput()).get(movedId)?.canMoveDown).toBe(false);
        expect(registry.get(environments).pinningEnvironmentIds.has(offlineId)).toBe(true);
        expect(registry.get(environments).settlementEnvironmentIds.has(offlineId)).toBe(true);
        expect(registry.get(environments).providersByEnvironmentId.get(offlineId)).toBe(
          before.providersByEnvironmentId.get(offlineId),
        );

        const keyedInput = {
          ...plannerInput(),
          ordered: ordered.map((row, index) => ({
            ...row,
            pinOrderKey: section === "pinned" ? (index === 0 ? "bb" : "dd") : null,
            activeOrderKey: section === "active" ? (index === 0 ? "bb" : "dd") : null,
          })),
        };
        expect(createThreadMovePlanner(keyedInput)(movedId, "down")).toEqual([
          expect.objectContaining({ id: movedId }),
        ]);
        expect(createThreadMovePlanner(keyedInput)(`${offlineId}:thread-1`, "up")).toBeNull();
        expect(computeThreadMoveAvailability(keyedInput).get(movedId)?.canMoveDown).toBe(true);
        expect(computeThreadMoveAvailability(keyedInput).get(`${offlineId}:thread-1`)).toEqual({
          canMoveUp: false,
          canMoveDown: false,
        });

        const updatedConfig = {
          ...config,
          settings: {
            ...config.settings,
            snoozePresets: [{ kind: "after" as const, minutes: 90 }],
          },
        };
        registry.set(
          configs,
          new Map([
            [onlineId, config],
            [offlineId, updatedConfig],
          ]),
        );

        const updated = registry.get(environments);
        expect(updated.snoozePresetsByEnvironmentId.get(offlineId)).toEqual(
          updatedConfig.settings.snoozePresets,
        );
        expect(updated.pinReorderEnvironmentIds.has(offlineId)).toBe(false);
        expect(updated.activeReorderEnvironmentIds.has(offlineId)).toBe(false);
        expect(createThreadMovePlanner(plannerInput())(movedId, "down")).toBeNull();

        registry.set(
          configs,
          new Map([
            [onlineId, config],
            [
              offlineId,
              {
                ...updatedConfig,
                settings: {
                  ...updatedConfig.settings,
                  snoozePresets: updatedConfig.settings.snoozePresets.map((preset) => ({
                    ...preset,
                  })),
                },
              },
            ],
          ]),
        );
        expect(registry.get(environments)).toBe(updated);

        registry.set(connected, [onlineId, offlineId]);

        expect(createThreadMovePlanner(plannerInput())(movedId, "down")).toHaveLength(2);
        expect(computeThreadMoveAvailability(plannerInput()).get(movedId)?.canMoveDown).toBe(true);
        expect(registry.get(environments).snoozePresetsByEnvironmentId.get(offlineId)).toBe(
          updated.snoozePresetsByEnvironmentId.get(offlineId),
        );

        registry.set(configs, new Map([[onlineId, config]]));

        expect(createThreadMovePlanner(plannerInput())(movedId, "down")).toBeNull();
        expect(computeThreadMoveAvailability(plannerInput()).get(movedId)?.canMoveDown).toBe(false);
      } finally {
        registry.dispose();
      }
    },
  );
});
