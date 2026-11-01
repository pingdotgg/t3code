import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { DEFAULT_CLIENT_SETTINGS, type DesktopDiscordPresence } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

import type { DiscordActivity } from "./discord/discordIpc.ts";
import { make, type DiscordPresenceConnector } from "./DesktopDiscordPresence.ts";

it.effect("discards a pending publish when disabled", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activities: Array<DiscordActivity | null> = [];
    let closes = 0;
    const connector: DiscordPresenceConnector = async () => {
      started.resolve();
      await release.promise;
      return fakeClient(activities, () => {
        closes += 1;
      });
    };
    const service = yield* make({ connector, clientId: "42" });
    const publishing = yield* service.set(presence).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const disabling = yield* service.set(null).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    release.resolve();
    yield* Fiber.join(publishing);
    yield* Fiber.join(disabling);
    expect(activities).toEqual([null]);
    expect(closes).toBe(1);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("serializes connection attempts and ignores an old client's close", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activities: Array<DiscordActivity | null> = [];
    const callbacks: Array<() => void> = [];
    let connects = 0;
    const connector: DiscordPresenceConnector = async (input) => {
      connects += 1;
      callbacks.push(input.onClose);
      started.resolve();
      await release.promise;
      return fakeClient(activities);
    };
    const service = yield* make({ connector, clientId: "42" });
    const first = yield* service.set(presence).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const second = yield* service.set({ ...presence, workingThreads: 2 }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    release.resolve();
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(connects).toBe(1);
    expect(activities.every((activity) => activity?.state === "Running 2 agents")).toBe(true);
    yield* service.set(null);
    yield* service.set(presence);
    expect(connects).toBe(2);
    callbacks[0]!();
    expect(yield* service.getStatus()).toBe("connected");
    yield* service.set(presence);
    expect(connects).toBe(2);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

const presence: DesktopDiscordPresence = {
  projectName: "t3code",
  modelLabel: "Claude Sonnet 4.5",
  workingThreads: 1,
  attentionThreads: 0,
};

const lastOf = <T>(values: ReadonlyArray<T>): T | undefined => values[values.length - 1];

const fakeClient = (activities: Array<DiscordActivity | null>, onClose?: () => void) => ({
  setActivity: (activity: DiscordActivity | null) => activities.push(activity),
  close: () => onClose?.(),
});

it.effect("connects once and mirrors the activity, then clears on null", () =>
  Effect.gen(function* () {
    let connects = 0;
    let closes = 0;
    const activities: Array<DiscordActivity | null> = [];
    const connector: DiscordPresenceConnector = async () => {
      connects += 1;
      return fakeClient(activities, () => {
        closes += 1;
      });
    };
    const service = yield* make({ connector, clientId: "42" });

    yield* service.set(presence);
    expect(connects).toBe(1);
    expect(lastOf(activities)).toMatchObject({ details: "In t3code", state: "Running an agent" });

    yield* service.set({ ...presence, workingThreads: 2 });
    expect(connects).toBe(1);
    expect(lastOf(activities)).toMatchObject({ state: "Running 2 agents" });

    yield* service.set(null);
    expect(lastOf(activities)).toBeNull();
    expect(closes).toBe(1);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("re-renders the current activity when the field selection changes", () =>
  Effect.gen(function* () {
    const activities: Array<DiscordActivity | null> = [];
    const connector: DiscordPresenceConnector = async () => fakeClient(activities);
    const service = yield* make({ connector, clientId: "42" });

    yield* service.set(presence);
    yield* service.configure(["model"]);
    expect(lastOf(activities)).toMatchObject({
      state: "Claude Sonnet 4.5",
    });
    expect(lastOf(activities)?.details).toBeUndefined();

    // An identical selection is a no-op, and configuring before any summary
    // arrives must not connect.
    const pushed = activities.length;
    yield* service.configure(["model"]);
    expect(activities.length).toBe(pushed);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("uses the build channel's art and version in the activity", () =>
  Effect.gen(function* () {
    const activities: Array<DiscordActivity | null> = [];
    const connector: DiscordPresenceConnector = async () => fakeClient(activities);
    const service = yield* make({
      connector,
      clientId: "42",
      branding: {
        assetKey: "nightly",
        label: "T3 Code (Nightly)",
        version: "0.0.45-nightly.20261011",
      },
    });

    yield* service.set(presence);
    expect(lastOf(activities)).toMatchObject({
      assets: {
        large_image: "nightly",
        large_text: "T3 Code (Nightly) 0.0.45-nightly.20261011",
      },
    });
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("reports nothing while Discord is unavailable and reconnects on the next update", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const activities: Array<DiscordActivity | null> = [];
    const connector: DiscordPresenceConnector = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Discord is not running");
      return fakeClient(activities);
    };
    const service = yield* make({ connector, clientId: "42" });

    yield* service.set(presence);
    expect(attempts).toBe(1);
    expect(activities).toHaveLength(0);

    yield* service.set(presence);
    expect(attempts).toBe(2);
    expect(lastOf(activities)).toMatchObject({ state: "Running an agent" });
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("stays inert when no Discord client id is configured", () =>
  Effect.gen(function* () {
    let connects = 0;
    let closed = 0;
    const connector: DiscordPresenceConnector = async () => {
      connects += 1;
      return fakeClient([], () => {
        closed += 1;
      });
    };
    const service = yield* make({ connector, clientId: "" });

    expect(yield* service.getStatus()).toBe("unconfigured");
    yield* service.set(presence);
    yield* service.configure(["model"]);
    expect(connects).toBe(0);
    expect(closed).toBe(0);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("reports connection status transitions the settings UI can show", () =>
  Effect.gen(function* () {
    const statuses: Array<string> = [];
    let attempts = 0;
    const connector: DiscordPresenceConnector = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Discord is not running");
      return fakeClient([]);
    };
    const service = yield* make({
      connector,
      clientId: "42",
      onStatusChange: (status) => statuses.push(status),
    });

    expect(yield* service.getStatus()).toBe("connecting");
    yield* service.set(presence);
    expect(yield* service.getStatus()).toBe("disconnected");
    yield* service.set(presence);
    expect(yield* service.getStatus()).toBe("connected");
    expect(statuses).toEqual(["disconnected", "connected"]);
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("reports a disconnect when the socket closes", () =>
  Effect.gen(function* () {
    let close = () => {};
    let attempts = 0;
    const connector: DiscordPresenceConnector = async (input) => {
      attempts += 1;
      close = input.onClose;
      if (attempts === 1) input.onClose();
      return fakeClient([]);
    };
    const service = yield* make({ connector, clientId: "42" });

    yield* service.set(presence);
    expect(yield* service.getStatus()).toBe("disconnected");
    yield* service.set(presence);
    expect(attempts).toBe(2);
    expect(yield* service.getStatus()).toBe("connected");
    close();
    expect(yield* service.getStatus()).toBe("disconnected");
  }).pipe(Effect.provide(DesktopClientSettings.layerTest()), Effect.scoped),
);

it.effect("uses the saved field selection on the first publish", () =>
  Effect.gen(function* () {
    const activities: Array<DiscordActivity | null> = [];
    const service = yield* make({
      connector: async () => fakeClient(activities),
      clientId: "42",
    });
    yield* service.set(presence);
    expect(lastOf(activities)).toEqual({
      state: "Claude Sonnet 4.5",
      assets: { large_image: "black", large_text: "T3 Code" },
    });
  }).pipe(
    Effect.provide(
      DesktopClientSettings.layerTest(
        Option.some({
          ...DEFAULT_CLIENT_SETTINGS,
          discordPresenceFields: ["model"],
        }),
      ),
    ),
    Effect.scoped,
  ),
);
