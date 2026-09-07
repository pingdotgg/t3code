import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadProviderInstance } from "./thread-provider-instance";

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
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
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

    expect(resolveThreadProviderInstance(serverConfigs, threadA)?.accentColor).toBe("#ff8800");
    expect(resolveThreadProviderInstance(serverConfigs, threadB)?.accentColor).toBeUndefined();
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
      resolveThreadProviderInstance(serverConfigs, makeThread(environmentId, "codex"))?.displayName,
    ).toBe("Codex");
    expect(
      resolveThreadProviderInstance(serverConfigs, makeThread(environmentId, "codex_personal"))
        ?.displayName,
    ).toBe("Codex Personal");
  });

  it("hides the badge for a single instance with no accent color", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const serverConfigs = new Map<EnvironmentId, ServerConfig>([
      [environmentId, makeConfig([{ instanceId: "codex", driver: "codex" }])],
    ]);
    const thread = makeThread(environmentId, "codex");

    expect(resolveThreadProviderInstance(serverConfigs, thread)?.showBadge).toBe(false);
  });
});
