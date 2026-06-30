import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import type { RelayBoardTicketState, RelayDeliveryResult } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as BoardTicketPublisher from "./BoardTicketPublisher.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";

function boardTicketState(overrides: Partial<RelayBoardTicketState> = {}): RelayBoardTicketState {
  return {
    environmentId: "env" as RelayBoardTicketState["environmentId"],
    boardId: "board" as RelayBoardTicketState["boardId"],
    ticketId: "ticket" as RelayBoardTicketState["ticketId"],
    attentionKind: "blocked",
    title: "Ticket blocked",
    body: "A dependency is blocking this ticket",
    deepLink: "/boards/env/board/ticket",
    transitionId: "transition" as RelayBoardTicketState["transitionId"],
    ...overrides,
  };
}

function target(overrides: Partial<LiveActivities.TargetRow> = {}): LiveActivities.TargetRow {
  return {
    user_id: "dev:julius",
    device_id: "device-1",
    platform: "ios",
    ios_major_version: 18,
    app_version: "1.0.0",
    push_token: "push-token",
    push_to_start_token: null,
    preferences_json: "{}",
    activity_push_token: null,
    remote_start_queued_at: null,
    remote_started_at: null,
    ended_at: null,
    last_aggregate_json: null,
    last_live_activity_delivery_at: null,
    ...overrides,
  };
}

function preferences(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    liveActivitiesEnabled: false,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
    ...overrides,
  });
}

const deliveryResult: RelayDeliveryResult = {
  deviceId: "device-1",
  kind: "push_notification",
  ok: true,
  queued: true,
  apnsStatus: null,
  apnsReason: null,
  apnsId: null,
};

function makeEnvironmentLinks(): EnvironmentLinks.EnvironmentLinks["Service"] {
  return {
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed(["dev:julius"]),
    listDeliveryUsersForEnvironment: () =>
      Effect.succeed([
        { userId: "dev:julius", notificationsEnabled: true, liveActivitiesEnabled: true },
      ]),
    listPublicKeysForEnvironment: () => Effect.succeed([]),
    listForUser: () => Effect.succeed([]),
    getForUser: () => Effect.succeed(null),
    revokeForUser: () => Effect.succeed(false),
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

type EnqueueArgs = Parameters<
  ApnsDeliveryQueue.ApnsDeliveryQueueShape["enqueuePushNotification"]
>[0];

function makeApnsDeliveryQueue(
  capture: Array<EnqueueArgs>,
): ApnsDeliveryQueue.ApnsDeliveryQueueShape {
  return {
    enqueueLiveActivity: () => Effect.die("unexpected enqueueLiveActivity"),
    enqueuePushNotification: (input) =>
      Effect.sync(() => {
        capture.push(input);
        return deliveryResult;
      }),
  };
}

function provide(input: {
  readonly targets: ReadonlyArray<LiveActivities.TargetRow>;
  readonly capture: Array<EnqueueArgs>;
}) {
  return BoardTicketPublisher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
        Layer.succeed(
          LiveActivities.LiveActivities,
          makeLiveActivities({ listTargets: () => Effect.succeed(input.targets) }),
        ),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueue, makeApnsDeliveryQueue(input.capture)),
        NodeCryptoLayer.layer,
      ),
    ),
  );
}

// Flexible harness for multi-user / failure-isolation tests: route targets per
// userId and allow overriding the live-activities + queue services directly.
function provideCustom(input: {
  readonly deliveryUsers: ReadonlyArray<EnvironmentLinks.AgentAwarenessDeliveryUserRecord>;
  readonly liveActivities: LiveActivities.LiveActivities["Service"];
  readonly queue: ApnsDeliveryQueue.ApnsDeliveryQueueShape;
}) {
  return BoardTicketPublisher.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          ...makeEnvironmentLinks(),
          listDeliveryUsersForEnvironment: () => Effect.succeed(input.deliveryUsers),
        }),
        Layer.succeed(LiveActivities.LiveActivities, input.liveActivities),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueue, input.queue),
        NodeCryptoLayer.layer,
      ),
    ),
  );
}

describe("BoardTicketPublisher", () => {
  it.effect(
    "enqueues a single push with a bounded, stable jobId for a blocked state when notifyOnBlocked is absent",
    () => {
      // Realistic-length component ids: the raw composite would be 150-400 chars,
      // overflowing the varchar(64) source_job_id column. The digest must keep it
      // within 64 chars while staying deterministic.
      const longDeviceId = "device-" + "d".repeat(40);
      const state = boardTicketState({
        environmentId: ("env-" + "a".repeat(40)) as RelayBoardTicketState["environmentId"],
        boardId: ("project-" +
          "b".repeat(36) +
          "__some-board-slug") as RelayBoardTicketState["boardId"],
        ticketId: ("ticket-" + "c".repeat(36)) as RelayBoardTicketState["ticketId"],
        transitionId: ("transition-" + "e".repeat(36)) as RelayBoardTicketState["transitionId"],
      });
      const capture: Array<EnqueueArgs> = [];
      return Effect.gen(function* () {
        const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
        const response = yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "public-key",
          boardId: state.boardId,
          ticketId: state.ticketId,
          state,
        });
        expect(response.deliveries).toHaveLength(1);
        expect(capture).toHaveLength(1);
        const jobId = capture[0]?.jobId ?? "";
        expect(jobId.startsWith("board:")).toBe(true);
        // source_job_id is varchar(64): the persisted dedup key must fit.
        expect(jobId.length).toBeLessThanOrEqual(64);
        expect(capture[0]?.notification).toEqual({
          title: "Ticket blocked",
          body: "A dependency is blocking this ticket",
          environmentId: state.environmentId,
          boardId: state.boardId,
          ticketId: state.ticketId,
          deepLink: "/boards/env/board/ticket",
        });
        expect(capture[0]?.notification).not.toHaveProperty("threadId");

        // Determinism: republishing the same state for the same device yields the
        // same jobId, so the queue consumer dedups instead of double-delivering.
        yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "public-key",
          boardId: state.boardId,
          ticketId: state.ticketId,
          state,
        });
        expect(capture).toHaveLength(2);
        expect(capture[1]?.jobId).toBe(jobId);
      }).pipe(
        Effect.provide(
          provide({
            targets: [target({ device_id: longDeviceId, preferences_json: preferences() })],
            capture,
          }),
        ),
      );
    },
  );

  it.effect(
    "does not enqueue when notifyOnApproval is false for a waiting_for_approval state",
    () => {
      const capture: Array<EnqueueArgs> = [];
      const state = boardTicketState({ attentionKind: "waiting_for_approval" });
      return Effect.gen(function* () {
        const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
        const response = yield* publisher.publish({
          environmentId: "env",
          environmentPublicKey: "public-key",
          boardId: state.boardId,
          ticketId: state.ticketId,
          state,
        });
        expect(response.deliveries).toHaveLength(0);
        expect(capture).toHaveLength(0);
      }).pipe(
        Effect.provide(
          provide({
            targets: [target({ preferences_json: preferences({ notifyOnApproval: false }) })],
            capture,
          }),
        ),
      );
    },
  );

  it.effect("does not enqueue when notificationsEnabled is false", () => {
    const capture: Array<EnqueueArgs> = [];
    const state = boardTicketState();
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      const response = yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: state.boardId,
        ticketId: state.ticketId,
        state,
      });
      expect(response.deliveries).toHaveLength(0);
      expect(capture).toHaveLength(0);
    }).pipe(
      Effect.provide(
        provide({
          targets: [target({ preferences_json: preferences({ notificationsEnabled: false }) })],
          capture,
        }),
      ),
    );
  });

  it.effect("returns no deliveries and enqueues nothing for a cleared (null) state", () => {
    const capture: Array<EnqueueArgs> = [];
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      const response = yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: "",
        ticketId: "ticket",
        state: null,
      });
      expect(response.deliveries).toHaveLength(0);
      expect(capture).toHaveLength(0);
    }).pipe(Effect.provide(provide({ targets: [target()], capture })));
  });

  // Fix A: honor the env-level notification opt-out, per-user (not global).
  it.effect("skips a user with env notifications off but delivers to a user with them on", () => {
    const capture: Array<EnqueueArgs> = [];
    const state = boardTicketState();
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      const response = yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: state.boardId,
        ticketId: state.ticketId,
        state,
      });
      // Only the opted-in user's device should enqueue.
      expect(capture).toHaveLength(1);
      expect(capture[0]?.userId).toBe("user:on");
      expect(response.deliveries).toHaveLength(1);
    }).pipe(
      Effect.provide(
        provideCustom({
          deliveryUsers: [
            // Env notifications OFF but live activities ON — must NOT receive a push,
            // even though the device's own preferences_json allows it.
            { userId: "user:off", notificationsEnabled: false, liveActivitiesEnabled: true },
            { userId: "user:on", notificationsEnabled: true, liveActivitiesEnabled: true },
          ],
          liveActivities: makeLiveActivities({
            listTargets: ({ userId }: { readonly userId: string }) =>
              Effect.succeed([
                target({
                  user_id: userId,
                  device_id: `${userId}:device`,
                  preferences_json: preferences(),
                }),
              ]),
          }),
          queue: makeApnsDeliveryQueue(capture),
        }),
      ),
    );
  });

  // Fix B: distinct tuples whose plain colon-join is IDENTICAL must not collide.
  it.effect("produces distinct bounded jobIds for tuples differing only by colon placement", () => {
    const capture: Array<EnqueueArgs> = [];
    // Under a naive `${env}:${board}:${ticket}:...` join both tuples flatten to the
    // same string `env:a:b:c:device-1`, so they would share a hash and the UNIQUE
    // source_job_id would suppress a genuinely-distinct notification. stableStringify
    // keeps the field boundaries, so the jobIds must differ.
    const stateOne = boardTicketState({
      boardId: "a:b" as RelayBoardTicketState["boardId"],
      ticketId: "c" as RelayBoardTicketState["ticketId"],
    });
    const stateTwo = boardTicketState({
      boardId: "a" as RelayBoardTicketState["boardId"],
      ticketId: "b:c" as RelayBoardTicketState["ticketId"],
    });
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: stateOne.boardId,
        ticketId: stateOne.ticketId,
        state: stateOne,
      });
      yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: stateTwo.boardId,
        ticketId: stateTwo.ticketId,
        state: stateTwo,
      });
      expect(capture).toHaveLength(2);
      const [first, second] = capture;
      for (const arg of capture) {
        expect(arg.jobId?.startsWith("board:")).toBe(true);
        expect((arg.jobId ?? "").length).toBeLessThanOrEqual(64);
      }
      expect(first?.jobId).not.toBe(second?.jobId);
    }).pipe(
      // device_id contains a colon — must still produce a valid bounded key.
      Effect.provide(
        provide({
          targets: [target({ device_id: "device:with:colons", preferences_json: preferences() })],
          capture,
        }),
      ),
    );
  });

  // Fix C(1): one user's listTargets failure does not block another user's delivery.
  it.effect("isolates a per-user listTargets failure and still delivers to other users", () => {
    const capture: Array<EnqueueArgs> = [];
    const state = boardTicketState();
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      // publish must NOT reject despite the failing user.
      const response = yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: state.boardId,
        ticketId: state.ticketId,
        state,
      });
      expect(capture).toHaveLength(1);
      expect(capture[0]?.userId).toBe("user:ok");
      expect(response.ok).toBe(true);
      expect(response.deliveries).toHaveLength(1);
    }).pipe(
      Effect.provide(
        provideCustom({
          deliveryUsers: [
            { userId: "user:bad", notificationsEnabled: true, liveActivitiesEnabled: true },
            { userId: "user:ok", notificationsEnabled: true, liveActivitiesEnabled: true },
          ],
          liveActivities: makeLiveActivities({
            listTargets: ({ userId }: { readonly userId: string }) =>
              userId === "user:bad"
                ? Effect.fail(
                    new LiveActivities.LiveActivityTargetListPersistenceError({
                      userId,
                      cause: new Error("boom"),
                    }),
                  )
                : Effect.succeed([
                    target({
                      user_id: userId,
                      device_id: `${userId}:device`,
                      preferences_json: preferences(),
                    }),
                  ]),
          }),
          queue: makeApnsDeliveryQueue(capture),
        }),
      ),
    );
  });

  // Fix C(2): one device's enqueue failure does not block sibling devices.
  it.effect("isolates a per-device enqueue failure and still delivers to other devices", () => {
    const capture: Array<EnqueueArgs> = [];
    const state = boardTicketState();
    return Effect.gen(function* () {
      const publisher = yield* BoardTicketPublisher.BoardTicketPublisher;
      const response = yield* publisher.publish({
        environmentId: "env",
        environmentPublicKey: "public-key",
        boardId: state.boardId,
        ticketId: state.ticketId,
        state,
      });
      // The good device still enqueues; publish resolves ok.
      expect(response.ok).toBe(true);
      expect(capture.map((arg) => arg.deviceId)).toContain("device-good");
      expect(response.deliveries).toHaveLength(1);
    }).pipe(
      Effect.provide(
        provideCustom({
          deliveryUsers: [
            { userId: "dev:julius", notificationsEnabled: true, liveActivitiesEnabled: true },
          ],
          liveActivities: makeLiveActivities({
            listTargets: () =>
              Effect.succeed([
                target({ device_id: "device-bad", preferences_json: preferences() }),
                target({ device_id: "device-good", preferences_json: preferences() }),
              ]),
          }),
          queue: {
            enqueueLiveActivity: () => Effect.die("unexpected enqueueLiveActivity"),
            enqueuePushNotification: (input) =>
              input.deviceId === "device-bad"
                ? Effect.fail(
                    new ApnsDeliveryQueue.ApnsDeliveryQueueSendError({
                      operation: "send",
                      jobId: null,
                      kind: "push_notification",
                      userId: input.userId,
                      deviceId: input.deviceId,
                      cause: new Error("queue down"),
                    }),
                  )
                : Effect.sync(() => {
                    capture.push(input);
                    return { ...deliveryResult, deviceId: input.deviceId };
                  }),
          },
        }),
      ),
    );
  });
});
