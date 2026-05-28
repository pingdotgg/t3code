import { afterEach, beforeEach, vi } from "vitest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ManagedRelayClient } from "@t3tools/client-runtime";

import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import {
  __resetAgentLiveActivitiesForTest,
  refreshActiveLiveActivityRemoteRegistration,
  syncAgentLiveActivitiesForSnapshot,
} from "./liveActivityController";
import { registerLiveActivityPushToken } from "./remoteRegistration";

const mocks = vi.hoisted(() => {
  const existingActivity = {
    update: vi.fn(() => Promise.resolve()),
    end: vi.fn((_dismissal: unknown, _props?: unknown, _endedAt?: unknown) => Promise.resolve()),
    getPushToken: vi.fn(() => Promise.resolve("activity-token")),
    addPushTokenListener: vi.fn(),
  };
  return {
    existingActivity,
    getInstances: vi.fn(() => [existingActivity]),
    start: vi.fn(() => existingActivity),
    registerLiveActivityPushToken: vi.fn(
      (): Effect.Effect<boolean, unknown> => Effect.succeed(true),
    ),
  };
});

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("expo-linking", () => ({
  default: {
    createURL: vi.fn((path: string) => `t3code://${path}`),
  },
  createURL: vi.fn((path: string) => `t3code://${path}`),
}));

vi.mock("expo-widgets", () => ({
  after: (date: Date) => ({ after: date }),
}));

vi.mock("../../lib/runtime", () => ({
  mobileRuntime: {
    runPromise: <A, E>(operation: Effect.Effect<A, E>) => Effect.runPromise(operation),
  },
}));

vi.mock("../../widgets/AgentActivity", () => ({
  default: {
    getInstances: mocks.getInstances,
    start: mocks.start,
  },
}));

vi.mock("./remoteRegistration", () => ({
  registerLiveActivityPushToken: mocks.registerLiveActivityPushToken,
}));

const runManagedRelayEffect = <A, E>(effect: Effect.Effect<A, E, ManagedRelayClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(ManagedRelayClient, null as never)));

function runningSnapshot(): OrchestrationShellSnapshot {
  return {
    projects: [
      {
        id: "project-1",
        title: "Project",
      },
    ],
    threads: [
      {
        id: "thread-1" as ThreadId,
        projectId: "project-1",
        title: "Thread",
        modelSelection: {
          model: "gpt-5",
        },
        session: {
          status: "running",
          providerName: "Codex",
        },
        latestTurn: {
          state: "running",
        },
        updatedAt: "2026-05-25T00:00:00.000Z",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      },
    ],
  } as unknown as OrchestrationShellSnapshot;
}

function completedSnapshot(): OrchestrationShellSnapshot {
  return {
    projects: [
      {
        id: "project-1",
        title: "Project",
      },
    ],
    threads: [
      {
        id: "thread-1" as ThreadId,
        projectId: "project-1",
        title: "Thread",
        modelSelection: {
          model: "gpt-5",
        },
        session: null,
        latestTurn: {
          state: "completed",
        },
        updatedAt: "2026-05-25T00:01:00.000Z",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      },
    ],
  } as unknown as OrchestrationShellSnapshot;
}

describe("liveActivityController", () => {
  beforeEach(() => {
    vi.stubGlobal("__DEV__", false);
    __resetAgentLiveActivitiesForTest();
    mocks.existingActivity.update.mockClear();
    mocks.existingActivity.end.mockClear();
    mocks.existingActivity.getPushToken.mockClear();
    mocks.existingActivity.addPushTokenListener.mockClear();
    mocks.getInstances.mockClear();
    mocks.getInstances.mockReturnValue([mocks.existingActivity]);
    mocks.start.mockClear();
    mocks.registerLiveActivityPushToken.mockClear();
    mocks.registerLiveActivityPushToken.mockReturnValue(Effect.succeed(true));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts an existing remote-started Live Activity instead of creating a duplicate", async () => {
    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: runningSnapshot(),
      }),
    );

    expect(mocks.getInstances).toHaveBeenCalledTimes(1);
    expect(mocks.existingActivity.update).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(registerLiveActivityPushToken).toHaveBeenCalledWith({
      activity: mocks.existingActivity,
    });
  });

  it("keeps skipped remote token registrations retryable after cloud sign-in", async () => {
    mocks.registerLiveActivityPushToken
      .mockReturnValueOnce(Effect.succeed(false))
      .mockReturnValueOnce(Effect.succeed(true));

    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: runningSnapshot(),
      }),
    );
    await runManagedRelayEffect(refreshActiveLiveActivityRemoteRegistration());

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(2);
    expect(registerLiveActivityPushToken).toHaveBeenNthCalledWith(2, {
      activity: mocks.existingActivity,
    });
  });

  it("retries cloud sign-in Live Activity token refresh failures", async () => {
    vi.useFakeTimers();
    mocks.registerLiveActivityPushToken
      .mockReturnValueOnce(Effect.succeed(true))
      .mockReturnValueOnce(Effect.fail(new Error("relay unavailable")))
      .mockReturnValueOnce(Effect.succeed(true));

    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: runningSnapshot(),
      }),
    );
    await runManagedRelayEffect(refreshActiveLiveActivityRemoteRegistration());

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(3);
    expect(registerLiveActivityPushToken).toHaveBeenNthCalledWith(3, {
      activity: mocks.existingActivity,
    });
  });

  it("retries adopted remote-start Live Activity token registration when the token is initially unavailable", async () => {
    vi.useFakeTimers();
    mocks.registerLiveActivityPushToken
      .mockReturnValueOnce(Effect.succeed(false))
      .mockReturnValueOnce(Effect.succeed(true));

    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: runningSnapshot(),
      }),
    );

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(registerLiveActivityPushToken).toHaveBeenCalledTimes(2);
    expect(registerLiveActivityPushToken).toHaveBeenNthCalledWith(2, {
      activity: mocks.existingActivity,
    });
  });

  it("ends active Live Activities with the terminal thread content state", async () => {
    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: runningSnapshot(),
      }),
    );
    await Effect.runPromise(
      syncAgentLiveActivitiesForSnapshot({
        environmentId: "env-1" as EnvironmentId,
        snapshot: completedSnapshot(),
      }),
    );

    expect(mocks.existingActivity.end).toHaveBeenCalledTimes(1);
    expect(mocks.existingActivity.end.mock.calls[0]?.[1]).toMatchObject({
      activeCount: 1,
      activities: [
        {
          environmentId: "env-1",
          threadId: "thread-1",
          phase: "completed",
          status: "Done",
        },
      ],
    });
  });
});
