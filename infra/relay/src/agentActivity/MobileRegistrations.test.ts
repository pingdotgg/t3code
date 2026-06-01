import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import type { SignedApnsDeliveryJob } from "./ApnsDeliveryJobs.ts";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/unstable/http";

import * as Devices from "./Devices.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as ApnsClient from "./ApnsClient.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as MobileRegistrations from "./MobileRegistrations.ts";

const device: RelayDeviceRegistrationRequest = {
  deviceId: "device-1" as RelayDeviceRegistrationRequest["deviceId"],
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: "1.0.0" as RelayDeviceRegistrationRequest["appVersion"],
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

function makeDevices(overrides: Partial<Devices.DevicesShape> = {}): Devices.DevicesShape {
  return {
    register: () => Effect.void,
    unregister: () => Effect.void,
    ...overrides,
  };
}

function makeLiveActivities(
  overrides: Partial<LiveActivities.LiveActivitiesShape> = {},
): LiveActivities.LiveActivitiesShape {
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
  overrides: Partial<AgentActivityRows.AgentActivityRowsShape> = {},
): AgentActivityRows.AgentActivityRowsShape {
  return {
    upsert: () => Effect.void,
    remove: () => Effect.void,
    listForUser: () => {
      const activeState: RelayAgentActivityState = {
        environmentId: "env-1" as RelayAgentActivityState["environmentId"],
        threadId: "thread-1" as RelayAgentActivityState["threadId"],
        projectTitle: "Project",
        threadTitle: "Implement APNs",
        modelTitle: "gpt-5.4",
        phase: "running",
        headline: "Working",
        updatedAt: "1970-01-01T00:00:10.000Z",
        deepLink: "/env-1/thread-1",
      };
      return Effect.succeed([activeState]);
    },
    ...overrides,
  };
}

function makeEnvironmentLinks(
  overrides: Partial<EnvironmentLinks.EnvironmentLinksShape> = {},
): EnvironmentLinks.EnvironmentLinksShape {
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

function makeDeliveryAttempts(
  overrides: Partial<DeliveryAttempts.DeliveryAttemptsShape> = {},
): DeliveryAttempts.DeliveryAttemptsShape {
  return {
    record: () => Effect.void,
    claimSourceJob: () => Effect.succeed("claimed"),
    completeSourceJob: () => Effect.void,
    ...overrides,
  };
}

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    bundleId: "codes.t3.mobile",
    privateKey: Redacted.make("apns-private-key"),
  },
  clerkSecretKey: Redacted.make("clerk-secret"),
  apnsDeliveryJobSigningSecret: Redacted.make("apns-job-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  cloudflareAccountId: undefined,
  cloudflareZoneId: undefined,
  cloudflareApiToken: undefined,
});

function makeRegistrationReplayLayer(input: {
  readonly devices: Devices.DevicesShape;
  readonly liveActivities: LiveActivities.LiveActivitiesShape;
  readonly queuedJobs: Array<SignedApnsDeliveryJob>;
}) {
  return MobileRegistrations.layer.pipe(
    Layer.provide(AgentActivityPublisher.layer),
    Layer.provide(ApnsDeliveries.layer.pipe(Layer.provide(ApnsClient.layer))),
    Layer.provide(ApnsDeliveryQueue.layer.pipe(Layer.provide(NodeCryptoLayer.layer))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Devices.Devices, input.devices),
        Layer.succeed(AgentActivityRows.AgentActivityRows, makeAgentActivityRows()),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, makeEnvironmentLinks()),
        Layer.succeed(LiveActivities.LiveActivities, input.liveActivities),
        Layer.succeed(DeliveryAttempts.DeliveryAttempts, makeDeliveryAttempts()),
        Layer.succeed(RelayConfiguration.RelayConfiguration, config),
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              input.queuedJobs.push(body);
            }),
        }),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
}

function makeAgentActivityPublisher(
  overrides: Partial<AgentActivityPublisher.AgentActivityPublisherShape> = {},
): AgentActivityPublisher.AgentActivityPublisherShape {
  return {
    publish: () => Effect.succeed({ ok: true, deliveries: [] }),
    replayForLiveActivityRegistration: () => Effect.succeed(null),
    ...overrides,
  };
}

describe("MobileRegistrations", () => {
  it.effect("registers devices through the device persistence service", () => {
    let registered: Parameters<Devices.DevicesShape["register"]>[0] | null = null;
    let replayed:
      | Parameters<
          AgentActivityPublisher.AgentActivityPublisherShape["replayForLiveActivityRegistration"]
        >[0]
      | null = null;

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registrations = yield* MobileRegistrations.MobileRegistrations;
        return yield* registrations.registerDevice({ userId: "dev:julius", payload: device });
      }).pipe(
        Effect.provide(
          MobileRegistrations.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  Devices.Devices,
                  makeDevices({
                    register: (input) =>
                      Effect.sync(() => {
                        registered = input;
                      }),
                  }),
                ),
                Layer.succeed(LiveActivities.LiveActivities, makeLiveActivities()),
                Layer.succeed(
                  AgentActivityPublisher.AgentActivityPublisher,
                  makeAgentActivityPublisher({
                    replayForLiveActivityRegistration: (input) =>
                      Effect.sync(() => {
                        replayed = input;
                        return null;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual({ ok: true });
      expect(registered).toEqual({ userId: "dev:julius", registration: device });
      expect(replayed).toEqual({
        userId: "dev:julius",
        deviceId: "device-1",
      });
    });
  });

  it.effect("keeps device registration successful when activity replay fails", () => {
    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registrations = yield* MobileRegistrations.MobileRegistrations;
        return yield* registrations.registerDevice({ userId: "dev:julius", payload: device });
      }).pipe(
        Effect.provide(
          MobileRegistrations.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Devices.Devices, makeDevices()),
                Layer.succeed(LiveActivities.LiveActivities, makeLiveActivities()),
                Layer.succeed(
                  AgentActivityPublisher.AgentActivityPublisher,
                  makeAgentActivityPublisher({
                    replayForLiveActivityRegistration: () =>
                      Effect.fail(
                        new AgentActivityRows.AgentActivityRowListPersistenceError({
                          cause: "replay failed",
                        }),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual({ ok: true });
    });
  });

  it.effect("unregisters the current user's device", () => {
    let unregistered: Parameters<Devices.DevicesShape["unregister"]>[0] | null = null;

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registrations = yield* MobileRegistrations.MobileRegistrations;
        return yield* registrations.unregisterDevice({
          userId: "dev:julius",
          deviceId: "device-1",
        });
      }).pipe(
        Effect.provide(
          MobileRegistrations.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  Devices.Devices,
                  makeDevices({
                    unregister: (input) =>
                      Effect.sync(() => {
                        unregistered = input;
                      }),
                  }),
                ),
                Layer.succeed(LiveActivities.LiveActivities, makeLiveActivities()),
                Layer.succeed(
                  AgentActivityPublisher.AgentActivityPublisher,
                  makeAgentActivityPublisher(),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual({ ok: true });
      expect(unregistered).toEqual({
        userId: "dev:julius",
        deviceId: "device-1",
      });
    });
  });

  it.effect("replays the latest activity state after registering a Live Activity token", () => {
    const liveActivity = {
      deviceId: "device-1" as const,
      activityPushToken: "activity-token" as const,
    };
    let registered: Parameters<LiveActivities.LiveActivitiesShape["register"]>[0] | null = null;
    let replayed:
      | Parameters<
          AgentActivityPublisher.AgentActivityPublisherShape["replayForLiveActivityRegistration"]
        >[0]
      | null = null;

    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const registrations = yield* MobileRegistrations.MobileRegistrations;
        return yield* registrations.registerLiveActivity({
          userId: "dev:julius",
          payload: liveActivity,
        });
      }).pipe(
        Effect.provide(
          MobileRegistrations.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Devices.Devices, makeDevices()),
                Layer.succeed(
                  LiveActivities.LiveActivities,
                  makeLiveActivities({
                    register: (input) =>
                      Effect.sync(() => {
                        registered = input;
                      }),
                  }),
                ),
                Layer.succeed(
                  AgentActivityPublisher.AgentActivityPublisher,
                  makeAgentActivityPublisher({
                    replayForLiveActivityRegistration: (input) =>
                      Effect.sync(() => {
                        replayed = input;
                        return null;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      expect(result).toEqual({ ok: true });
      expect(registered).toEqual({
        userId: "dev:julius",
        registration: liveActivity,
      });
      expect(replayed).toEqual({
        userId: "dev:julius",
        deviceId: "device-1",
      });
    });
  });

  it.effect(
    "starts a remote Live Activity through the real publisher and APNs queue when a device registers after work is already active",
    () => {
      const queuedJobs: Array<SignedApnsDeliveryJob> = [];
      const queuedStarts: Array<
        Parameters<LiveActivities.LiveActivitiesShape["markStartQueued"]>[0]
      > = [];
      const registeredDevices: Array<Parameters<Devices.DevicesShape["register"]>[0]> = [];
      const devices = makeDevices({
        register: (input) =>
          Effect.sync(() => {
            registeredDevices.push(input);
          }),
      });
      const liveActivities = makeLiveActivities({
        listTargets: () =>
          Effect.succeed([
            {
              user_id: "dev:julius",
              device_id: "device-1",
              platform: "ios",
              ios_major_version: 18,
              app_version: "1.0.0",
              push_token: "apns-device-token",
              push_to_start_token: "push-to-start-token",
              preferences_json: JSON.stringify(device.preferences),
              activity_push_token: null,
              remote_start_queued_at: null,
              remote_started_at: null,
              ended_at: null,
              last_aggregate_json: null,
              last_live_activity_delivery_at: null,
            },
          ]),
        markStartQueued: (input) =>
          Effect.sync(() => {
            queuedStarts.push(input);
          }),
      });

      return Effect.gen(function* () {
        const registrations = yield* MobileRegistrations.MobileRegistrations;
        const result = yield* registrations.registerDevice({
          userId: "dev:julius",
          payload: {
            ...device,
            pushToken: "apns-device-token",
            pushToStartToken: "push-to-start-token",
          },
        });

        expect(result).toEqual({ ok: true });
        expect(registeredDevices).toEqual([
          {
            userId: "dev:julius",
            registration: {
              ...device,
              pushToken: "apns-device-token",
              pushToStartToken: "push-to-start-token",
            },
          },
        ]);
        expect(queuedStarts).toMatchObject([
          {
            userId: "dev:julius",
            deviceId: "device-1",
          },
        ]);
        expect(queuedJobs).toHaveLength(1);
        expect(queuedJobs[0]?.payload).toMatchObject({
          kind: "live_activity_start",
          target: {
            userId: "dev:julius",
            deviceId: "device-1",
            token: "push-to-start-token",
          },
          aggregate: {
            title: "T3 Code",
            subtitle: "Agent work in progress",
            activeCount: 1,
            activities: [
              {
                environmentId: "env-1",
                threadId: "thread-1",
                threadTitle: "Implement APNs",
                status: "Working",
              },
            ],
          },
          notification: null,
        });
      }).pipe(Effect.provide(makeRegistrationReplayLayer({ devices, liveActivities, queuedJobs })));
    },
  );
});
