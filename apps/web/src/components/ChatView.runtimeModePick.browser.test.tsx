import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderSessionId, type OrchestrationV2ProviderSession } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

function liveInSessionCapableSession(): OrchestrationV2ProviderSession {
  return {
    id: ProviderSessionId.make("session-codex-live"),
    driver: "codex" as never,
    providerInstanceId: "codex" as never,
    status: "ready",
    cwd: "/workspace/render",
    model: "gpt-5.4",
    capabilities: {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: true,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: true,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: true,
        canRollbackThread: false,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsNativeResume: false,
        supportsActiveSteering: true,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        exposesNativeTurnId: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: true,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
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
        acceptsSyntheticUserContext: true,
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
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
      runtimePolicy: { enforcement: "client-boundary" },
    },
    extensionStatuses: [],
    createdAt: AT,
    updatedAt: AT,
    lastError: null,
  };
}

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("a permission mode picked during an active in-session run reaches the server without sending a message", async () => {
  const baseThread = threadWithHistory("thread-runtime-mode-pick", 1);
  const runningThread = {
    ...baseThread,
    runtimeMode: "auto" as const,
    runs: [{ ...baseThread.runs[0]!, status: "running" as const, completedAt: null }],
    providerSessions: [liveInSessionCapableSession()],
  };
  using _environment = installFakeEnvironment([runningThread], {
    acceptCommands: true,
    providers: [
      {
        ...CODEX_PROVIDER,
        supportedRuntimeModes: ["approval-required", "auto", "full-access"],
      },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${runningThread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-runtime-mode-pick.")).toBeVisible();

  await page.getByRole("button", { name: "GPT-5.4", exact: true }).click();
  await page.getByRole("button", { name: "Permissions: Auto" }).click();
  await page.getByRole("menuitemradio", { name: "Full access" }).click();

  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.runtime-mode.set"),
    ).toEqual([
      expect.objectContaining({
        threadId: runningThread.id,
        runtimeMode: "full-access",
      }),
    ]),
  );
});
