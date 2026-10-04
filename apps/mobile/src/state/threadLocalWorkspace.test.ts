import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderThreadId,
  ProviderInstanceId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { threadLocalWorkspace } from "./threadLocalWorkspace";

const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("native-local"),
  driver: ProviderDriverKind.make("kilo"),
  providerInstanceId: ProviderInstanceId.make("kilo-personal"),
  providerSessionId: null,
  appThreadId: null,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
};
const local = {
  driver: providerThread.driver,
  providerThreads: [providerThread],
  activeProviderThreadId: providerThread.id,
  worktreePath: "/local/worktree",
  workspaceRoot: "/local/repository",
  detailLoaded: true,
  providerConfigLoaded: true,
};
function expectBlocked(input: Parameters<typeof threadLocalWorkspace>[0], state: string) {
  expect(threadLocalWorkspace(input)).toEqual({
    localWorkspaceState: state,
    localWorkspaceEnabled: false,
    selectedThreadWorktreePath: null,
    selectedThreadCwd: null,
    selectedThreadGitRootCwd: null,
  });
}
describe("mobile thread workspace routing", () => {
  it("restores actual local Kilo worktree, repository and draft flows after hydration", () => {
    expectBlocked({ ...local, providerThreads: [], detailLoaded: false }, "loading");
    expect(threadLocalWorkspace(local)).toEqual({
      localWorkspaceState: "local",
      localWorkspaceEnabled: true,
      selectedThreadWorktreePath: "/local/worktree",
      selectedThreadCwd: "/local/worktree",
      selectedThreadGitRootCwd: "/local/repository",
    });
    expect(threadLocalWorkspace({ ...local, worktreePath: null }).selectedThreadCwd).toBe(
      "/local/repository",
    );
    expect(
      threadLocalWorkspace({ ...local, activeProviderThreadId: null, providerThreads: [] })
        .localWorkspaceEnabled,
    ).toBe(true);
    expectBlocked({ ...local, worktreePath: null, workspaceRoot: null }, "unavailable");
  });
  it("distinguishes config loading, failed reads and a removed provider without opening local resources", () => {
    expectBlocked({ ...local, driver: undefined, providerConfigLoaded: false }, "loading");
    expectBlocked(
      { ...local, driver: undefined, providerConfigLoaded: false, loadError: "Disconnected" },
      "error",
    );
    expectBlocked({ ...local, detailLoaded: false, loadError: "Detail failed" }, "error");
    expectBlocked({ ...local, driver: undefined }, "unavailable");
    expectBlocked({ ...local, providerThreads: [] }, "unavailable");
    expectBlocked({ ...local, detailLoaded: false, threadDeleted: true }, "unavailable");
    expect(threadLocalWorkspace({ ...local, loadError: null }).localWorkspaceEnabled).toBe(true);
  });
  it("keeps known cloud metadata authoritative during config loading and failure", () => {
    for (const input of [
      { ...local, driver: ProviderDriverKind.make("kilo-cloud") },
      {
        ...local,
        driver: undefined,
        providerConfigLoaded: false,
        providerThreads: [{ ...providerThread, driver: ProviderDriverKind.make("kilo-cloud") }],
      },
      {
        ...local,
        loadError: "Disconnected",
        providerThreads: [
          {
            ...providerThread,
            nativeMetadata: {
              cloudExecution: {
                repository: "fixture/repo",
                branch: "main",
                sessionId: null,
                worktreeId: null,
                task: "not_started" as const,
                sandbox: "unknown" as const,
                billing: "unknown" as const,
                billingAttribution: null,
                estimatedHourlyRateUsd: null,
                observedAt: null,
              },
            },
          },
        ],
      },
    ])
      expectBlocked(input, "cloud");
  });
});
