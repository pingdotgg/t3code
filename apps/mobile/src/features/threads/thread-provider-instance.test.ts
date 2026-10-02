import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
  return { providers } as unknown as ServerConfig;
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

  it("labels a custom instance by its id so its initials differ from the default", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [
        environmentId,
        makeConfig([
          { instanceId: "codex", driver: "codex", displayName: "Codex" },
          { instanceId: "codex_personal", driver: "codex", displayName: "Codex" },
        ]),
      ],
    ]);

    expect(
      resolveThreadProviderInstance(
        serverConfigs.get(environmentId)?.providers,
        makeThread(environmentId, "codex"),
      )?.displayName,
    ).toBe("Codex");
    expect(
      resolveThreadProviderInstance(
        serverConfigs.get(environmentId)?.providers,
        makeThread(environmentId, "codex_personal"),
      )?.displayName,
    ).toBe("Codex Personal");
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

  it("hides the badge for a single instance with no accent color", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [environmentId, makeConfig([{ instanceId: "codex", driver: "codex" }])],
    ]);
    const thread = makeThread(environmentId, "codex");

    expect(
      resolveThreadProviderInstance(serverConfigs.get(environmentId)?.providers, thread)?.showBadge,
    ).toBe(false);
  });
});

describe("createThreadRowProviderInstanceResolver", () => {
  const environmentId = EnvironmentId.make("environment-a");
  const serverConfigs = new Map<EnvironmentId, ServerConfig>([
    [
      environmentId,
      makeConfig([
        { instanceId: "codex", driver: "codex", displayName: "Codex" },
        { instanceId: "codex_work", driver: "codex", displayName: "Codex" },
      ]),
    ],
  ]);

  it("hands out the same reference for repeated lookups of one instance", () => {
    const resolve = createThreadRowProviderInstanceResolver(
      new Map([...serverConfigs].map(([id, config]) => [id, config.providers])),
    );
    const first = resolve(makeThread(environmentId, "codex"));
    const second = resolve(makeThread(environmentId, "codex"));
    // Memoized rows compare props by reference: a fresh object per call would
    // re-render every row on every parent render (minute tick included).
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("distinguishes instances of the same driver", () => {
    const resolve = createThreadRowProviderInstanceResolver(
      new Map([...serverConfigs].map(([id, config]) => [id, config.providers])),
    );
    const personal = resolve(makeThread(environmentId, "codex"));
    const work = resolve(makeThread(environmentId, "codex_work"));
    expect(personal).not.toBeNull();
    expect(work).not.toBeNull();
    expect(work).not.toBe(personal);
    expect(work?.displayName).toBe("Codex Work");
  });

  it("hands out a new identity when the server-config generation changes", () => {
    const before = createThreadRowProviderInstanceResolver(
      new Map([...serverConfigs].map(([id, config]) => [id, config.providers])),
    );
    const nextConfigs = new Map<EnvironmentId, ServerConfig>([
      [environmentId, makeConfig([{ instanceId: "codex", driver: "codex" }])],
    ]);
    const after = createThreadRowProviderInstanceResolver(
      new Map([...nextConfigs].map(([id, config]) => [id, config.providers])),
    );
    expect(after(makeThread(environmentId, "codex"))).not.toBe(
      before(makeThread(environmentId, "codex")),
    );
  });

  it("resolves unknown instances to null without throwing", () => {
    const resolve = createThreadRowProviderInstanceResolver(
      new Map([...serverConfigs].map(([id, config]) => [id, config.providers])),
    );
    expect(resolve(makeThread(environmentId, "ghost"))).toBeNull();
    expect(resolve(makeThread(environmentId, "ghost"))).toBeNull();
  });
});
