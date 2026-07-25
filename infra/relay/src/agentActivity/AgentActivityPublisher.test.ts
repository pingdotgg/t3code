import type { RelayAgentActivityState, RelayDeliveryResult } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

function target(deviceId: string): LiveActivities.TargetRow {
  return {
    user_id: "dev:julius",
    device_id: deviceId,
    platform: "ios",
    ios_major_version: 18,
    app_version: "1.0.0",
    bundle_id: null,
    aps_environment: null,
    push_token: null,
    push_to_start_token: "start-token",
    preferences_json: "{}",
    activity_push_token: null,
    remote_start_queued_at: null,
    remote_started_at: null,
    ended_at: null,
    last_aggregate_json: null,
    last_live_activity_delivery_at: null,
  };
}

function makeLiveActivities(
  overrides: Partial<LiveActivities.LiveActivities["Service"]> = {},
): LiveActivities.LiveActivities["Service"] {
  return {
    register: () => Effect.void,
    listTargets: () => Effect.succeed([]),
    markDelivery: () => Effect.void,
    markStartQueued: () => Effect.void,
    clearStartQueued: () => Effect.void,
    invalidateDeliveryToken: () => Effect.void,
    ...overrides,
  };
}

function makeAgentActivityRows(
  overrides: Partial<AgentActivityRows.AgentActivityRows["Service"]> = {},
): AgentActivityRows.AgentActivityRows["Service"] {
  return {
    upsert: () => Effect.void,
    remove: () => Effect.void,
    pruneTerminal: () => Effect.void,
    listForUser: () => Effect.succeed([state]),
    getForUserThread: () => Effect.succeed(state),
    ...overrides,
  };
}

function makeEnvironmentLinks(
  overrides: Partial<EnvironmentLinks.EnvironmentLinks["Service"]> = {},
): EnvironmentLinks.EnvironmentLinks["Service"] {
  return {
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed(["dev:julius"]),
    listDeliveryUsersForEnvironment: () =>
      Effect.succeed([
        {
          userId: "dev:julius",
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
        },
      ]),
    listPublicKeysForEnvironment: () => Effect.succeed([]),
    listForUser: () => Effect.succeed([]),
    getForUser: () => Effect.succeed(null),
    revokeForUser: () => Effect.succeed(false),
    ...overrides,
  };
}

function makeApnsDeliveries(
  overrides: Partial<ApnsDeliveries.ApnsDeliveries["Service"]> = {},
): ApnsDeliveries.ApnsDeliveries["Service"] {
  return {
    sendForTarget: () => Effect.succeed(null),
    sendPushNotificationForTarget: () => Effect.succeed(null),
    sendLiveActivity: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "live_activity_start",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    sendPushNotification: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "push_notification",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    processSignedJob: () =>
      Effect.succeed({
        deviceId: "device",
        kind: "live_activity_start",
        ok: true,
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-id",
      }),
    ...overrides,
  };
}

describe("AgentActivityPublisher", () => {
  it.effect("replays the latest aggregate when a Live Activity token registers", () => {
    const registeredTarget: LiveActivities.TargetRow = {
      ...target("device-1"),
      push_to_start_token: null,
      activity_push_token: "activity-token",
      remote_start_queued_at: null,
      remote_started_at: "1970-01-01T00:00:01.000Z",
    };
    const sent: Array<Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]> =
      [];
    const deliveryResult: RelayDeliveryResult = {
      deviceId: "device-1",
      kind: "live_activity_update",
      ok: true,
      apnsStatus: null,
      apnsReason: null,
      apnsId: "queued",
    };

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
        return yield* publisher.replayForLiveActivityRegistration({
          userId: "dev:julius",
          deviceId: "device-1",
        });
      }).pipe(
        Effect.provide(
          AgentActivityPublisher.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentActivityRows.AgentActivityRows, makeAgentActivityRows()),
                Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    listTargets: () => Effect.succeed([registeredTarget, target("device-2")]),
                  }),
                ),
                Layer.succeed(
                  ApnsDeliveries.ApnsDeliveries,
                  makeApnsDeliveries({
                    sendForTarget: (input) =>
                      Effect.sync(() => {
                        sent.push(input);
                        return deliveryResult;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual(deliveryResult);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.target.device_id).toBe("device-1");
      expect(sent[0]?.aggregate).toMatchObject({
        activeCount: 1,
        activities: [
          {
            environmentId: state.environmentId,
            threadId: state.threadId,
            status: "Working",
          },
        ],
      });
    });
  });

  it.effect("publishes listed targets through the APNs delivery service", () => {
    const firstTarget = target("device-1");
    const secondTarget = target("device-2");
    const deliveryResult: RelayDeliveryResult = {
      deviceId: "device-1",
      kind: "live_activity_start",
      ok: true,
      apnsStatus: 200,
      apnsReason: null,
      apnsId: "apns-id",
    };
    const sentTargets: Array<string> = [];
    const deliveryLookups: Array<{
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }> = [];
    const upserts: Array<Parameters<AgentActivityRows.AgentActivityRows["Service"]["upsert"]>[0]> =
      [];

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
        return yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "environment-public-key",
          threadId: "thread",
          state,
        });
      }).pipe(
        Effect.provide(
          AgentActivityPublisher.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  AgentActivityRows.AgentActivityRows,
                  makeAgentActivityRows({
                    upsert: (input) =>
                      Effect.sync(() => {
                        upserts.push(input);
                      }),
                  }),
                ),
                Layer.succeed(
                  EnvironmentLinks.EnvironmentLinks,
                  makeEnvironmentLinks({
                    listDeliveryUsersForEnvironment: (input) =>
                      Effect.sync(() => {
                        deliveryLookups.push(input);
                        return [
                          {
                            userId: "dev:julius",
                            notificationsEnabled: true,
                            liveActivitiesEnabled: true,
                          },
                        ];
                      }),
                  }),
                ),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    listTargets: () => Effect.succeed([firstTarget, secondTarget]),
                  }),
                ),
                Layer.succeed(
                  ApnsDeliveries.ApnsDeliveries,
                  makeApnsDeliveries({
                    sendForTarget: (input) =>
                      Effect.sync(() => {
                        sentTargets.push(input.target.device_id);
                        return input.target.device_id === "device-1" ? deliveryResult : null;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(sentTargets).toEqual(["device-1", "device-2"]);
      expect(deliveryLookups).toEqual([
        {
          environmentId: "env",
          environmentPublicKey: "environment-public-key",
        },
      ]);
      expect(upserts).toMatchObject([
        {
          environmentPublicKey: "environment-public-key",
          state: {
            environmentId: "env",
            threadId: "thread",
          },
        },
      ]);
      expect(result).toEqual({ ok: true, deliveries: [deliveryResult] });
    });
  });

  it.effect("ends the last remote Live Activity with a terminal content state", () => {
    const completedState: RelayAgentActivityState = {
      ...state,
      phase: "completed",
      headline: "Done",
      updatedAt: "1970-01-01T00:00:10.000Z",
    };
    const sentAggregates: Array<
      Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]
    > = [];
    const upserts: Array<Parameters<AgentActivityRows.AgentActivityRows["Service"]["upsert"]>[0]> =
      [];

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
        return yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "environment-public-key",
          threadId: "thread",
          state: completedState,
        });
      }).pipe(
        Effect.provide(
          AgentActivityPublisher.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  AgentActivityRows.AgentActivityRows,
                  makeAgentActivityRows({
                    upsert: (input) =>
                      Effect.sync(() => {
                        upserts.push(input);
                      }),
                    listForUser: () => Effect.succeed([]),
                  }),
                ),
                Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    listTargets: () =>
                      Effect.succeed([
                        {
                          ...target("device-1"),
                          push_to_start_token: null,
                          activity_push_token: "activity-token",
                          remote_started_at: "1970-01-01T00:00:00.000Z",
                        },
                      ]),
                  }),
                ),
                Layer.succeed(
                  ApnsDeliveries.ApnsDeliveries,
                  makeApnsDeliveries({
                    sendForTarget: (input) =>
                      Effect.sync(() => {
                        sentAggregates.push(input);
                        return {
                          deviceId: input.target.device_id,
                          kind: "live_activity_end",
                          ok: true,
                          apnsStatus: null,
                          apnsReason: null,
                          apnsId: "queued",
                        };
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result.deliveries).toMatchObject([
        {
          deviceId: "device-1",
          kind: "live_activity_end",
          ok: true,
        },
      ]);
      // Terminal states are persisted (and later pruned by the cron) so the
      // finished thread can keep a Done row in later aggregates.
      expect(upserts).toEqual([
        {
          environmentPublicKey: "environment-public-key",
          state: completedState,
        },
      ]);
      expect(sentAggregates).toHaveLength(1);
      expect(sentAggregates[0]?.aggregate).toMatchObject({
        activeCount: 0,
        subtitle: "Agent work completed",
        activities: [
          {
            environmentId: completedState.environmentId,
            threadId: completedState.threadId,
            phase: "completed",
            status: "Done",
          },
        ],
      });
    });
  });

  it.effect("queues push notifications for notification-only environment links", () => {
    const notificationState: RelayAgentActivityState = {
      ...state,
      phase: "waiting_for_input",
      headline: "Needs input",
    };
    const liveAggregates: Array<
      Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]
    > = [];
    const pushAggregates: Array<
      Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendPushNotificationForTarget"]>[0]
    > = [];

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
        return yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "environment-public-key",
          threadId: "thread",
          state: notificationState,
        });
      }).pipe(
        Effect.provide(
          AgentActivityPublisher.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  AgentActivityRows.AgentActivityRows,
                  makeAgentActivityRows({
                    listForUser: () => Effect.succeed([]),
                  }),
                ),
                Layer.succeed(
                  EnvironmentLinks.EnvironmentLinks,
                  makeEnvironmentLinks({
                    listDeliveryUsersForEnvironment: () =>
                      Effect.succeed([
                        {
                          userId: "dev:julius",
                          notificationsEnabled: true,
                          liveActivitiesEnabled: false,
                        },
                      ]),
                  }),
                ),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    listTargets: () =>
                      Effect.succeed([
                        {
                          ...target("device-1"),
                          push_token: "apns-device-token",
                          push_to_start_token: null,
                        },
                      ]),
                  }),
                ),
                Layer.succeed(
                  ApnsDeliveries.ApnsDeliveries,
                  makeApnsDeliveries({
                    sendForTarget: (input) =>
                      Effect.sync(() => {
                        liveAggregates.push(input);
                        return null;
                      }),
                    sendPushNotificationForTarget: (input) =>
                      Effect.sync(() => {
                        pushAggregates.push(input);
                        return {
                          deviceId: input.target.device_id,
                          kind: "push_notification",
                          ok: true,
                          queued: true,
                          apnsStatus: null,
                          apnsReason: null,
                          apnsId: null,
                        };
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(liveAggregates).toMatchObject([{ aggregate: null }]);
      expect(pushAggregates).toHaveLength(1);
      expect(pushAggregates[0]?.aggregate).toMatchObject({
        activeCount: 1,
        activities: [
          {
            phase: "waiting_for_input",
            status: "Input",
            threadId: notificationState.threadId,
          },
        ],
      });
      expect(result.deliveries).toMatchObject([
        {
          deviceId: "device-1",
          kind: "push_notification",
          queued: true,
        },
      ]);
    });
  });

  it.effect(
    "does not build Live Activity aggregates for links with Live Activities disabled",
    () => {
      const notificationState: RelayAgentActivityState = {
        ...state,
        phase: "waiting_for_approval",
        headline: "Needs approval",
      };
      const liveAggregates: Array<
        Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendForTarget"]>[0]
      > = [];
      const pushAggregates: Array<
        Parameters<ApnsDeliveries.ApnsDeliveries["Service"]["sendPushNotificationForTarget"]>[0]
      > = [];

      return Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
          return yield* publisher.publish({
            environmentId: "env",
            environmentPublicKey: "environment-public-key",
            threadId: "thread",
            state: notificationState,
          });
        }).pipe(
          Effect.provide(
            AgentActivityPublisher.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    AgentActivityRows.AgentActivityRows,
                    makeAgentActivityRows({
                      listForUser: () =>
                        Effect.succeed([
                          {
                            ...state,
                            environmentId: "other-env" as RelayAgentActivityState["environmentId"],
                            threadId: "other-thread" as RelayAgentActivityState["threadId"],
                          },
                        ]),
                    }),
                  ),
                  Layer.succeed(
                    EnvironmentLinks.EnvironmentLinks,
                    makeEnvironmentLinks({
                      listDeliveryUsersForEnvironment: () =>
                        Effect.succeed([
                          {
                            userId: "dev:julius",
                            notificationsEnabled: true,
                            liveActivitiesEnabled: false,
                          },
                        ]),
                    }),
                  ),
                  Layer.succeed(
                    LiveActivities.LiveActivities,
                    makeLiveActivities({
                      listTargets: () =>
                        Effect.succeed([
                          {
                            ...target("device-1"),
                            push_token: "apns-device-token",
                            push_to_start_token: "push-to-start-token",
                          },
                        ]),
                    }),
                  ),
                  Layer.succeed(
                    ApnsDeliveries.ApnsDeliveries,
                    makeApnsDeliveries({
                      sendForTarget: (input) =>
                        Effect.sync(() => {
                          liveAggregates.push(input);
                          return null;
                        }),
                      sendPushNotificationForTarget: (input) =>
                        Effect.sync(() => {
                          pushAggregates.push(input);
                          return {
                            deviceId: input.target.device_id,
                            kind: "push_notification",
                            ok: true,
                            queued: true,
                            apnsStatus: null,
                            apnsReason: null,
                            apnsId: null,
                          };
                        }),
                    }),
                  ),
                ),
              ),
            ),
          ),
        );

        expect(liveAggregates).toMatchObject([{ aggregate: null }]);
        expect(pushAggregates).toHaveLength(1);
        expect(pushAggregates[0]?.aggregate?.activities).toMatchObject([
          {
            environmentId: notificationState.environmentId,
            threadId: notificationState.threadId,
            phase: "waiting_for_approval",
          },
        ]);
        expect(result.deliveries).toMatchObject([
          {
            deviceId: "device-1",
            kind: "push_notification",
            queued: true,
          },
        ]);
      });
    },
  );
});

describe("isExpiredAgentActivityState", () => {
  const hourMs = 60 * 60 * 1_000;

  it("expires running rows after two hours without an update", () => {
    expect(AgentActivityPublisher.isExpiredAgentActivityState(state, 2 * hourMs - 1)).toBe(false);
    expect(AgentActivityPublisher.isExpiredAgentActivityState(state, 2 * hourMs + 1)).toBe(true);
  });

  it("keeps waiting rows for a day", () => {
    const waiting: RelayAgentActivityState = { ...state, phase: "waiting_for_approval" };
    expect(AgentActivityPublisher.isExpiredAgentActivityState(waiting, 23 * hourMs)).toBe(false);
    expect(AgentActivityPublisher.isExpiredAgentActivityState(waiting, 25 * hourMs)).toBe(true);
  });

  it("treats rows with unparseable timestamps as expired", () => {
    expect(
      AgentActivityPublisher.isExpiredAgentActivityState({ ...state, updatedAt: "not-a-date" }, 0),
    ).toBe(true);
  });
});

describe("makeAggregateState", () => {
  const hourMs = 60 * 60 * 1_000;

  it("drops expired rows from the aggregate", () => {
    const fresh: RelayAgentActivityState = {
      ...state,
      threadId: "thread-fresh" as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T03:00:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [state, fresh],
      terminalState: null,
      nowMs: 3 * hourMs,
    });

    expect(aggregate?.activeCount).toBe(1);
    expect(aggregate?.activities).toMatchObject([{ threadId: "thread-fresh" }]);
  });

  it("returns null when every row has expired and nothing terminal remains", () => {
    expect(
      AgentActivityPublisher.makeAggregateState({
        activeStates: [state],
        terminalState: null,
        nowMs: 3 * hourMs,
      }),
    ).toBeNull();
  });

  it("still reports the terminal state when active rows have expired", () => {
    const terminalState: RelayAgentActivityState = {
      ...state,
      phase: "completed",
      updatedAt: "1970-01-01T03:00:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [state],
      terminalState,
      nowMs: 3 * hourMs,
    });

    expect(aggregate?.activeCount).toBe(0);
    expect(aggregate?.activities).toMatchObject([{ phase: "completed" }]);
  });

  it("keeps a recently finished thread visible as Done beside active agents", () => {
    const active: RelayAgentActivityState = {
      ...state,
      threadId: "thread-active" as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T00:58:00.000Z",
    };
    const justCompleted: RelayAgentActivityState = {
      ...state,
      threadId: "thread-done" as RelayAgentActivityState["threadId"],
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [active, justCompleted],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate?.activeCount).toBe(1);
    expect(aggregate?.subtitle).toBe("Agent work in progress");
    expect(aggregate?.activities).toMatchObject([
      { threadId: "thread-active", phase: "running" },
      { threadId: "thread-done", phase: "completed", status: "Done" },
    ]);
    expect(aggregate?.updatedAt).toBe("1970-01-01T00:59:00.000Z");
  });

  it("drops finished threads from the aggregate after the display window", () => {
    const active: RelayAgentActivityState = {
      ...state,
      threadId: "thread-active" as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T00:58:00.000Z",
    };
    const staleCompleted: RelayAgentActivityState = {
      ...state,
      threadId: "thread-done" as RelayAgentActivityState["threadId"],
      phase: "completed",
      updatedAt: "1970-01-01T00:44:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [active, staleCompleted],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate?.activities).toMatchObject([{ threadId: "thread-active" }]);
  });

  it("keeps showing recently finished work when nothing is active", () => {
    const lingeringCompleted: RelayAgentActivityState = {
      ...state,
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [lingeringCompleted],
      terminalState: null,
      nowMs: hourMs,
    });

    // An armed card never renders an empty state: recently finished threads
    // keep Done content on it, and once they age out the aggregate becomes
    // null and the delivery layer ends the card.
    expect(aggregate).toMatchObject({
      activeCount: 0,
      subtitle: "Agent work completed",
      activities: [{ phase: "completed", status: "Done" }],
    });
    expect(
      AgentActivityPublisher.makeAggregateState({
        activeStates: [{ ...lingeringCompleted, updatedAt: "1970-01-01T00:44:00.000Z" }],
        terminalState: null,
        nowMs: hourMs,
      }),
    ).toBeNull();
  });

  it("gives active agents the display slots before finished ones", () => {
    const mkActive = (id: string): RelayAgentActivityState => ({
      ...state,
      threadId: id as RelayAgentActivityState["threadId"],
      updatedAt: "1970-01-01T00:58:00.000Z",
    });
    const justCompleted: RelayAgentActivityState = {
      ...state,
      threadId: "thread-done" as RelayAgentActivityState["threadId"],
      phase: "completed",
      updatedAt: "1970-01-01T00:59:00.000Z",
    };
    const aggregate = AgentActivityPublisher.makeAggregateState({
      activeStates: [
        mkActive("a-1"),
        mkActive("a-2"),
        mkActive("a-3"),
        mkActive("a-4"),
        mkActive("a-5"),
        justCompleted,
      ],
      terminalState: null,
      nowMs: hourMs,
    });

    expect(aggregate?.activeCount).toBe(5);
    expect(aggregate?.activities).toMatchObject([
      { threadId: "a-1" },
      { threadId: "a-2" },
      { threadId: "a-3" },
      { threadId: "a-4" },
      { threadId: "a-5" },
    ]);
  });
});
