import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as FcmDeliveryQueueConsumer from "./FcmDeliveryQueueConsumer.ts";

import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { EnvironmentLinks } from "../environments/EnvironmentLinks.ts";
import { AgentActivityRows } from "./AgentActivityRows.ts";
import { LiveActivities, type TargetRow } from "./LiveActivities.ts";
import * as FcmDeliveryQueueSender from "./FcmDeliveryQueueSender.ts";
import { FcmClient, FcmClientError } from "./FcmClient.ts";
import {
  FcmDeliveries,
  androidAlertForState,
  androidAlertForAggregate,
  layer,
  type FcmDeliveryJob,
} from "./FcmDeliveries.ts";
import { TestClock } from "effect/testing";
import { androidActivityData, fitFcmData } from "./fcmPayloads.ts";
import { makeAggregateState } from "./agentActivityAggregate.ts";

const aggregateFor = (states: ReadonlyArray<RelayAgentActivityState>) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Fix notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const target: TargetRow = {
  user_id: "user",
  device_id: "phone",
  platform: "android",
  ios_major_version: null,
  app_version: null,
  bundle_id: "com.t3tools.t3code.dev",
  aps_environment: null,
  push_token: "fcm-token",
  push_to_start_token: null,
  preferences_json: encodeJson(preferences),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};
const config = {
  relayIssuer: "https://relay.test",
  fcmServiceAccount: Redacted.make("configured"),
  apns: {
    environment: "sandbox",
    teamId: "unused",
    keyId: "unused",
    bundleId: "unused",
    privateKey: Redacted.make("unused"),
  },
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
} satisfies RelayConfiguration["Service"];

function harness() {
  const sent: Array<Parameters<FcmClient["Service"]["send"]>[0]> = [];
  const queued: FcmDeliveryJob[] = [];
  const marked: Array<Parameters<LiveActivities["Service"]["markDelivery"]>[0]> = [];
  const current = {
    target: { ...target },
    state: { ...state } as RelayAgentActivityState | null,
    otherStates: [] as RelayAgentActivityState[],
    mutedEnvironments: [] as string[],
    notificationOnlyEnvironments: [] as string[],
    revokedEnvironments: [] as string[],
    linked: true,
    deliveryFailure: null as FcmClientError | null,
  };
  const services = Layer.mergeAll(
    NodeCryptoLayer.layer,
    Layer.succeed(RelayConfiguration, config),
    Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
      send: (job) =>
        Effect.sync(() => {
          queued.push(job);
        }),
    }),
    Layer.succeed(FcmClient, {
      send: (input) =>
        Effect.suspend(() =>
          current.deliveryFailure
            ? Effect.fail(current.deliveryFailure)
            : Effect.sync(() => {
                sent.push(input);
                return { unregistered: false };
              }),
        ),
    }),
    Layer.succeed(LiveActivities, {
      register: () => Effect.void,
      listTargets: () => Effect.sync(() => [current.target]),
      markDelivery: (input) =>
        Effect.sync(() => {
          marked.push(input);
          current.target.last_aggregate_json = input.aggregate ? encodeJson(input.aggregate) : null;
        }),
      markStartQueued: () => Effect.void,
      clearStartQueued: () => Effect.void,
      invalidateDeliveryToken: () => Effect.void,
    }),
    Layer.succeed(AgentActivityRows, {
      upsert: () => Effect.void,
      remove: () => Effect.void,
      pruneTerminal: () => Effect.void,
      listForUser: () =>
        Effect.sync(() =>
          current.linked
            ? [...(current.state ? [current.state] : []), ...current.otherStates].filter(
                (row) =>
                  !current.revokedEnvironments.includes(row.environmentId) &&
                  !current.notificationOnlyEnvironments.includes(row.environmentId),
              )
            : [],
        ),
      getForUserThread: (input) =>
        Effect.sync(() =>
          current.linked
            ? ([current.state, ...current.otherStates].find(
                (row) =>
                  row?.environmentId === input.environmentId && row.threadId === input.threadId,
              ) ?? null)
            : null,
        ),
    }),
    Layer.succeed(EnvironmentLinks, {
      upsert: () => Effect.void,
      listUsersForEnvironment: () => Effect.succeed(["user"]),
      listDeliveryUsersForEnvironment: (input) =>
        Effect.sync(() =>
          current.linked && !current.revokedEnvironments.includes(input.environmentId)
            ? [
                {
                  userId: "user",
                  notificationsEnabled: !current.mutedEnvironments.includes(input.environmentId),
                  liveActivitiesEnabled: !current.notificationOnlyEnvironments.includes(
                    input.environmentId,
                  ),
                },
              ]
            : [],
        ),
      listPublicKeysForEnvironment: () => Effect.succeed([]),
      listForUser: () => Effect.succeed([]),
      revokeForUser: () => Effect.succeed(false),
      getForUser: (input) =>
        Effect.sync(() =>
          current.linked && !current.revokedEnvironments.includes(input.environmentId)
            ? {
                environmentId: EnvironmentId.make(input.environmentId),
                label: "Desktop",
                environmentPublicKey: "key",
                linkedAt: state.updatedAt,
                endpoint: {
                  httpBaseUrl: "https://env.test",
                  wsBaseUrl: "wss://env.test",
                  providerKind: "manual",
                },
              }
            : null,
        ),
    }),
    Layer.succeed(RelayDb, {} as RelayDb["Service"]),
  );
  return {
    sent,
    queued,
    marked,
    current,
    layer: layer.pipe(Layer.provide(services)),
    job: {
      userId: "user",
      deviceId: "phone",
      token: "fcm-token",
      state,
      queuedAt: 0,
    } satisfies FcmDeliveryJob,
  };
}

describe("Android delivery routing", () => {
  const secondState: RelayAgentActivityState = {
    ...state,
    threadId: ThreadId.make("second-thread"),
    threadTitle: "Second thread",
    deepLink: "/threads/env/second-thread",
  };

  for (const [firstPhase, secondPhase, title, active] of [
    ["waiting_for_approval", "waiting_for_input", "2 agents need attention", "true"],
    ["completed", "failed", "2 agents finished", "false"],
  ] as const) {
    it.effect(`groups ${firstPhase} and ${secondPhase} once across their queued jobs`, () => {
      const h = harness();
      h.current.otherStates = [secondState];
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.process(h.job);
        h.current.state = { ...state, phase: firstPhase };
        h.current.otherStates = [{ ...secondState, phase: secondPhase }];
        yield* delivery.process({ ...h.job, state: h.current.state });
        yield* delivery.process({ ...h.job, state: h.current.otherStates[0] });
        yield* delivery.process({ ...h.job, state: h.current.state });
        const alerts = h.sent.filter((message) => message.alert);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.data).toMatchObject({
          alert_title: title,
          alert_body: "Fix notifications, Second thread",
          alert_path: firstPhase === "completed" ? secondState.deepLink : state.deepLink,
          active,
        });
        expect(h.marked.at(-1)?.aggregate?.activities).toHaveLength(2);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("filters disabled event types before counting a group", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, secondState]));
    h.current.target.preferences_json = encodeJson({ ...preferences, notifyOnApproval: false });
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.otherStates = [{ ...secondState, phase: "waiting_for_input" }];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent[0]?.data).toMatchObject({
        alert_title: "Second thread",
        alert_body: "Input: Project",
        alert_path: "/threads/env/second-thread",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("excludes already delivered attention and stale completions from groups", () => {
    const h = harness();
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([h.current.state, secondState]));
    h.current.otherStates = [
      { ...secondState, phase: "completed", updatedAt: "1969-12-31T23:57:00.000Z" },
    ];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent.every((message) => !message.alert)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("prioritizes attention over simultaneous completions like iOS", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, secondState]));
    h.current.state = { ...state, phase: "completed" };
    h.current.otherStates = [{ ...secondState, phase: "waiting_for_input" }];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent[0]?.data).toMatchObject({
        alert_title: "Second thread",
        alert_body: "Input: Project",
      });
      yield* delivery.process({ ...h.job, state: h.current.otherStates[0] });
      expect(h.sent.filter((message) => message.alert)).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });

  for (const phase of [
    "completed",
    "waiting_for_approval",
    "waiting_for_input",
    "failed",
  ] as const) {
    it.effect(`deleting one thread preserves another thread's ${phase} alert`, () => {
      const h = harness();
      h.current.otherStates = [secondState];
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.process(h.job);
        h.current.otherStates = [];
        h.current.state = { ...state, phase };
        yield* delivery.enqueue({ target, state: null });
        yield* delivery.process(h.queued[0]);
        expect(h.sent.at(-1)?.alert).toBe(false);
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent.filter((message) => message.alert)).toHaveLength(1);
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent.filter((message) => message.alert)).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("registration replay establishes a baseline without alerting", () => {
    const h = harness();
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.otherStates = [{ ...secondState, phase: "waiting_for_input" }];
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.enqueue({ target, state: null, replay: true });
      yield* delivery.process(h.queued[0]);
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent.every((message) => !message.alert)).toBe(true);
      expect(h.marked[0]?.aggregate?.activities).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });

  for (const restriction of ["mutedEnvironments", "revokedEnvironments"] as const) {
    it.effect(`excludes ${restriction} when forming cross-environment groups`, () => {
      const h = harness();
      const other = { ...secondState, environmentId: EnvironmentId.make("other-env") };
      h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, other]));
      h.current.state = { ...state, phase: "waiting_for_approval" };
      h.current.otherStates = [{ ...other, phase: "waiting_for_input" }];
      h.current[restriction] = [other.environmentId];
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent[0]?.data).toMatchObject({
          alert_title: "Fix notifications",
          alert_body: "Approval: Project",
        });
      }).pipe(Effect.provide(h.layer));
    });
  }

  it("gives a group a stable retry identity independent of row order", () => {
    const other = {
      ...secondState,
      environmentId: EnvironmentId.make("other-env"),
      threadId: state.threadId,
    };
    const input = {
      previousAggregate: aggregateFor([state, other]),
      nextAggregate: aggregateFor([
        { ...state, phase: "completed" },
        { ...other, phase: "failed" },
      ]),
      preferences,
      nowMs: 0,
    };
    const alert = androidAlertForAggregate(input);
    expect(alert?.alert_title).toBe("2 agents finished");
    expect(
      androidAlertForAggregate({
        ...input,
        nextAggregate: {
          ...input.nextAggregate,
          activities: input.nextAggregate.activities.toReversed(),
        },
      })?.alert_id,
    ).toBe(alert?.alert_id);
    expect(
      androidAlertForAggregate({
        ...input,
        nextAggregate: {
          ...input.nextAggregate,
          activities: input.nextAggregate.activities.map((row) => ({
            ...row,
            updatedAt: "1970-01-01T00:00:01.000Z",
          })),
        },
      })?.alert_id,
    ).not.toBe(alert?.alert_id);
  });

  it("distinguishes matching thread IDs in different environments", () => {
    const other = {
      ...secondState,
      environmentId: EnvironmentId.make("other-env"),
      threadId: state.threadId,
    };
    const alreadyWaiting = { ...state, phase: "waiting_for_approval" as const };
    expect(
      androidAlertForAggregate({
        previousAggregate: aggregateFor([alreadyWaiting, other]),
        nextAggregate: aggregateFor([alreadyWaiting, { ...other, phase: "waiting_for_input" }]),
        preferences,
        nowMs: 0,
      }),
    ).toMatchObject({ alert_title: "Second thread", alert_body: "Input: Project" });
  });

  for (const [phase, body, preference] of [
    ["waiting_for_approval", "Approval: Project", "notifyOnApproval"],
    ["waiting_for_input", "Input: Project", "notifyOnInput"],
    ["completed", "Done: Project", "notifyOnCompletion"],
    ["failed", "Failed: Project", "notifyOnFailure"],
  ] as const) {
    it.effect(`uses iOS alert wording for ${phase} and honors its preference`, () => {
      const h = harness();
      h.current.state = { ...state, phase };
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent[0]?.data).toMatchObject({
          alert_title: "Fix notifications",
          alert_body: body,
          alert_path: "/threads/env/thread",
        });
        h.current.target.preferences_json = encodeJson({
          ...preferences,
          [preference]: false,
        });
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent.slice(1).every((sent) => !sent.alert && !sent.data.alert_id)).toBe(true);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it("trims and truncates alert text like iOS", () => {
    expect(
      androidAlertForState(
        {
          ...state,
          phase: "completed",
          threadTitle: `  ${"T".repeat(150)}  `,
          projectTitle: `  ${"P".repeat(150)}  `,
        },
        preferences,
        0,
      ),
    ).toMatchObject({
      alert_title: `${"T".repeat(117)}...`,
      alert_body: `Done: ${"P".repeat(111)}...`,
    });
  });

  it.effect(
    "queues Android devices and sends the latest aggregate instead of a stale running state",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.enqueue({ target, state });
        h.current.state = { ...state, phase: "completed" };
        yield* delivery.process(h.queued[0]);
        expect(h.sent).toHaveLength(0);
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent[0]?.data).toMatchObject({
          active: "false",
          alert_title: "Fix notifications",
          alert_body: "Done: Project",
          alert_path: "/threads/env/thread",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("keeps completion alerts working with ongoing activity disabled", () => {
    const h = harness();
    h.current.state = { ...state, phase: "completed" };
    h.current.target.preferences_json = encodeJson({
      ...preferences,
      liveActivitiesEnabled: false,
    });
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent[0]?.data).toMatchObject({
        active: "false",
        alert_title: "Fix notifications",
        alert_body: "Done: Project",
      });
      expect(h.sent[0]?.data.user_id).toBe("user");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("drops jobs for rotated tokens, expired jobs, and revoked links", () => {
    const h = harness();
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, token: "old-token" });
      yield* delivery.process({ ...h.job, queuedAt: -400_000 });
      h.current.linked = false;
      yield* delivery.process(h.job);
      expect(h.sent).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("ends an existing ongoing notification when the environment stops publishing", () => {
    const h = harness();
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
    h.current.state = null;
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: null });
      expect(h.sent[0]?.data).toMatchObject({ active: "false" });
      expect(h.sent[0]?.alert).toBe(false);
      expect(h.marked[0]?.kind).toBe("live_activity_end");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("leaves iOS devices on their existing delivery path", () => {
    const h = harness();
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      expect(yield* delivery.enqueue({ target: { ...target, platform: "ios" }, state })).toBeNull();
      expect(h.queued).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("honors disabled alert preferences while continuing ongoing activity", () => {
    const h = harness();
    h.current.state = { ...state, phase: "waiting_for_approval" };
    h.current.target.preferences_json = encodeJson({ ...preferences, notifyOnApproval: false });
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent[0]?.data.active).toBe("true");
      expect(h.sent[0]?.data.alert_id).toBeUndefined();
      h.current.target.preferences_json = encodeJson({
        ...preferences,
        notificationsEnabled: false,
      });
      h.current.target.last_aggregate_json = encodeJson(aggregateFor([state]));
      yield* delivery.process({ ...h.job, state: h.current.state });
      expect(h.sent[1]?.data.active).toBe("false");
      expect(h.sent[1]?.data.alert_id).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  });
  for (const ongoing of [true, false]) {
    for (const phase of ["completed", "failed"] as const) {
      it.effect(`does not alert a stale ${phase} without a baseline (ongoing=${ongoing})`, () => {
        const h = harness();
        h.current.state = { ...state, phase, updatedAt: "1969-12-31T23:57:00.000Z" };
        h.current.target.preferences_json = encodeJson({
          ...preferences,
          liveActivitiesEnabled: ongoing,
        });
        return Effect.gen(function* () {
          const delivery = yield* FcmDeliveries;
          yield* delivery.process({ ...h.job, state: h.current.state });
          expect(h.sent.every((message) => !message.alert)).toBe(true);
        }).pipe(Effect.provide(h.layer));
      });
    }
  }

  it.effect(
    "retains finished results without extending expiry on replay and clears expired cards",
    () => {
      const h = harness();
      h.current.state = { ...state, phase: "failed" };
      return Effect.gen(function* () {
        const delivery = yield* FcmDeliveries;
        yield* delivery.process({ ...h.job, state: h.current.state });
        expect(h.sent[0]?.data).toMatchObject({
          active: "false",
          activity_title: "Agent work failed",
          activity_expires_at: "900000",
        });
        yield* TestClock.adjust("5 minutes");
        yield* delivery.process({ ...h.job, queuedAt: 300000, state: null, replay: true });
        expect(h.sent[1]?.data.activity_expires_at).toBe("900000");
        expect(h.sent[1]?.alert).toBe(false);
        yield* TestClock.adjust("11 minutes");
        yield* delivery.process({ ...h.job, queuedAt: 960000, state: null, replay: true });
        expect(h.sent[2]?.data).toMatchObject({ active: "false", activity_expires_at: "0" });
        expect(h.marked.at(-1)?.aggregate).toBeNull();
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("replays an empty card to repair an orphan without a delivery baseline", () => {
    const h = harness();
    h.current.state = null;
    return Effect.gen(function* () {
      const delivery = yield* FcmDeliveries;
      yield* delivery.process({ ...h.job, state: null });
      expect(h.sent[0]?.data.activity_expires_at).toBe("0");
      expect(h.sent[0]?.alert).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it("shows five rows with attention then failure first, including project and status", () => {
    const aggregate = aggregateFor([
      state,
      { ...secondState, phase: "failed" },
      { ...state, threadId: ThreadId.make("approval"), phase: "waiting_for_approval" },
      { ...state, threadId: ThreadId.make("input"), phase: "waiting_for_input" },
      { ...state, threadId: ThreadId.make("done"), phase: "completed" },
    ]);
    const data = androidActivityData(aggregate);
    expect(data.activity_title).toBe("3 active agents · 2 need attention");
    expect(
      Object.entries(data)
        .filter(([key]) => key.startsWith("activity_line_"))
        .map(([, value]) => value),
    ).toEqual([
      "Approval\tFix notifications\tProject",
      "Input\tFix notifications\tProject",
      "Failed\tSecond thread\tProject",
      "Working\tFix notifications\tProject",
      "Done\tFix notifications\tProject",
    ]);
    expect(data.activity_expires_at).toBe(String(24 * 60 * 60 * 1000));
    expect(androidActivityData(aggregateFor([state])).activity_expires_at).toBe(
      String(2 * 60 * 60 * 1000),
    );
  });

  it("fits five Unicode rows and a grouped alert in the FCM budget without corrupting text or routes", () => {
    const longTitle = '🤖漢字"\\'.repeat(30);
    const aggregate = aggregateFor(
      Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`thread-${i}`),
        threadTitle: longTitle,
        projectTitle: longTitle,
      })),
    );
    const data = fitFcmData({
      ...androidActivityData(aggregate),
      t3_kind: "agent_activity",
      device_id: "d".repeat(128),
      user_id: "u".repeat(128),
      updated_at: "1788780000000",
      alert_id: "a".repeat(64),
      alert_title: "5 agents finished",
      alert_body: Array(5).fill(longTitle).join(", "),
      alert_path: "/threads/env/thread",
    });
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(3800);
    expect(data.alert_path).toBe("/threads/env/thread");
    expect(data.activity_path).toBe("/threads/env/thread");
    expect(data.alert_id).toBe("a".repeat(64));
    expect(data.activity_line_4).toContain("Working\t");
    for (const value of Object.values(data))
      expect(new TextDecoder().decode(new TextEncoder().encode(value))).toBe(value);
  });
});

describe("delivery policy regressions", () => {
  it.effect("alerts a quick completion even with a previous unrelated card", () => {
    const h = harness();
    const old = { ...state, threadId: ThreadId.make("old"), phase: "completed" as const };
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([old]));
    h.current.otherStates = [old];
    h.current.state = { ...state, phase: "completed" };
    return Effect.gen(function* () {
      const d = yield* FcmDeliveries;
      yield* d.process(h.job);
      yield* d.process({ ...h.job, state: h.current.state });
      expect(h.sent.filter((x) => x.alert)).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("a muted environment job cannot consume another environment's attention alert", () => {
    const h = harness();
    const other = {
      ...state,
      environmentId: EnvironmentId.make("other"),
      threadId: ThreadId.make("other"),
    };
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([state, other]));
    h.current.otherStates = [{ ...other, phase: "waiting_for_input" }];
    h.current.mutedEnvironments = [state.environmentId];
    return Effect.gen(function* () {
      const d = yield* FcmDeliveries;
      yield* d.process(h.job);
      yield* d.process({ ...h.job, state: h.current.otherStates[0]! });
      expect(h.sent.filter((x) => x.alert)).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it("keeps an older waiting thread visible and alertable beyond five running rows", () => {
    const running = Array.from({ length: 5 }, (_, i) => ({
      ...state,
      threadId: ThreadId.make(`running-${i}`),
    }));
    const waiting = {
      ...state,
      phase: "waiting_for_approval" as const,
      updatedAt: "1969-12-31T23:59:00.000Z",
    };
    const next = aggregateFor([...running, waiting]);
    expect(
      androidAlertForAggregate({
        previousAggregate: aggregateFor(running),
        nextAggregate: next,
        preferences,
        nowMs: 0,
      }),
    ).not.toBeNull();
  });
});

describe("notification-only environments", () => {
  it.effect("alerts independently while another environment has a live card", () => {
    const h = harness();
    const other = {
      ...state,
      environmentId: EnvironmentId.make("other"),
      threadId: ThreadId.make("other"),
    };
    h.current.target.last_aggregate_json = encodeJson(aggregateFor([other]));
    h.current.otherStates = [other];
    h.current.state = { ...state, phase: "waiting_for_input" };
    h.current.notificationOnlyEnvironments = [state.environmentId];
    return Effect.gen(function* () {
      const deliveries = yield* FcmDeliveries;
      yield* deliveries.process({ ...h.job, state: h.current.state });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.alert).toBe(true);
      expect(h.sent[0]?.data.alert_path).toBe(state.deepLink);
    }).pipe(Effect.provide(h.layer));
  });
});

it("continues shrinking text when a longer activity line is already minimal", () => {
  const data = fitFcmData({
    activity_line_0: "Approval\t😀😀😀😀\t😀😀😀😀",
    alert_body: "x".repeat(30),
    device_id: "x".repeat(3680),
  });
  expect(new TextEncoder().encode(encodeJson(data)).length).toBeLessThanOrEqual(3800);
  expect(data.activity_line_0).toBe("Approval\t😀😀😀😀\t😀😀😀😀");
});

it.effect("notification-only jobs do not consume another environment's card alert", () => {
  const h = harness();
  const other = {
    ...state,
    environmentId: EnvironmentId.make("other"),
    threadId: ThreadId.make("other"),
  };
  h.current.target.last_aggregate_json = encodeJson(aggregateFor([other]));
  h.current.otherStates = [{ ...other, phase: "waiting_for_approval" }];
  h.current.state = { ...state, phase: "waiting_for_input" };
  h.current.notificationOnlyEnvironments = [state.environmentId];
  return Effect.gen(function* () {
    const deliveries = yield* FcmDeliveries;
    yield* deliveries.process({ ...h.job, state: h.current.state });
    yield* deliveries.process({ ...h.job, state: h.current.otherStates[0]! });
    expect(h.sent.filter((delivery) => delivery.alert)).toHaveLength(2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("preserves a structured Firebase failure through the queue consumer", () => {
  const h = harness();
  const failure = new FcmClientError({ operation: "send", status: 503 });
  h.current.deliveryFailure = failure;
  return Effect.gen(function* () {
    const deliveries = yield* FcmDeliveries;
    expect(yield* deliveries.process(h.job).pipe(Effect.flip)).toBe(failure);
  }).pipe(Effect.provide(h.layer));
});

it("stops reducing five-character row fields and fits the remaining alert", () => {
  const data = fitFcmData({
    device_id: "x".repeat(3710),
    activity_line_0: "Approval\taaaaa\tbbbbb",
    alert_body: "y".repeat(200),
  });
  expect(data.activity_line_0).toBe("Approval\taaaaa\tbbbbb");
  expect(new TextEncoder().encode(encodeJson(data)).length).toBeLessThanOrEqual(3800);
});

describe("FCM queue message isolation", () => {
  for (const failure of ["invalid-job", "fcm-rejection"] as const) {
    it.effect(`retries only the ${failure} message and delivers the rest of its batch`, () => {
      const h = harness();
      const outcomes = new Map<string, "ack" | "retry">();
      const message = (id: string, body: unknown): Cloudflare.Queues.Message<unknown> => ({
        id,
        body,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        attempts: 1,
        ack: () => {
          if (!outcomes.has(id)) outcomes.set(id, "ack");
        },
        retry: () => {
          if (!outcomes.has(id)) outcomes.set(id, "retry");
        },
      });
      const batch = [
        message("failed", failure === "invalid-job" ? {} : h.job),
        message("healthy", h.job),
      ];
      return Effect.gen(function* () {
        yield* Stream.fromIterable(batch).pipe(
          Stream.tap((item) =>
            Effect.sync(() => {
              h.current.deliveryFailure =
                item.id === "failed" && failure === "fcm-rejection"
                  ? new FcmClientError({ operation: "send", status: 400 })
                  : null;
            }),
          ),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
        );
        // Alchemy acknowledges the batch after a successful stream. Cloudflare
        // ignores those acknowledgements for messages explicitly retried earlier.
        for (const item of batch) item.ack();
        expect([...outcomes]).toEqual([
          ["failed", "retry"],
          ["healthy", "ack"],
        ]);
        expect(h.sent).toHaveLength(1);
        expect(h.marked).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    });
  }
});
