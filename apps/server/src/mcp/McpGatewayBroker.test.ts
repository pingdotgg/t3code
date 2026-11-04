import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpGatewayRelayEvent,
  type McpGatewayRelayGrants,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./McpGatewayBroker.ts";

type Broker = Effect.Success<typeof make>;

const failureMessage = <E extends { readonly message: string }>(
  effect: Effect.Effect<unknown, E>,
) => effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }));

/** Connects an app that answers every call with what `answer` returns for its method. */
const serve = (
  broker: Broker,
  owner: string,
  grants: McpGatewayRelayGrants,
  answer: (method: string, args: ReadonlyArray<unknown>) => { result?: unknown; error?: string },
) =>
  broker.connect(owner, grants).pipe(
    Stream.runForEach((event) =>
      broker.respond(owner, {
        connectionId: event.connectionId,
        invocationId: event.invocationId,
        ...answer(event.method, event.args),
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

it.effect("runs calls on the newest app that reaches every environment in them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      expect(broker.available()).toBe(false);
      yield* serve(broker, "laptop", { remote: ["read"] }, (method) => ({
        result: `laptop:${method}`,
      }));
      yield* serve(broker, "desktop", { remote: ["read", "send"], other: ["read"] }, (method) => ({
        result: `desktop:${method}`,
      }));
      expect(broker.available()).toBe(true);
      expect(broker.grants()).toEqual({ remote: ["read", "send"], other: ["read"] });
      expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe(
        "desktop:listProjects",
      );
      expect(yield* broker.forward("listThreads", ["other"], ["other"])).toBe(
        "desktop:listThreads",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "lists every connected app's environments and routes around an app that stopped answering",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const summary = (environmentId: string, connectionState: string) => ({
          environmentId,
          label: environmentId,
          connectionState,
          targetKind: "remote",
        });
        yield* serve(broker, "studio", { studio: ["read"] }, () => ({
          result: [summary("studio", "connected")],
        }));
        yield* serve(broker, "laptop", { laptop: ["read"], studio: ["read"] }, () => ({
          result: [summary("laptop", "connected"), summary("studio", "connecting")],
        }));
        // An app that stopped answering must not hold up the others' environments.
        yield* broker
          .connect("asleep", { asleep: ["read"], laptop: ["read"] })
          .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }));
        const listing = yield* broker
          .forward("listEnvironments", [], [])
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(listing)).toEqual([
          summary("laptop", "connected"),
          summary("studio", "connected"),
        ]);
        // Having timed out, the silent app no longer takes calls another app can run.
        expect(yield* broker.forward("listProjects", ["laptop"], ["laptop"])).toEqual([
          summary("laptop", "connected"),
          summary("studio", "connecting"),
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails calls no connected app can run, and reports app errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const none = yield* Effect.exit(broker.forward("listProjects", ["remote"], ["remote"]));
      expect(Exit.isFailure(none)).toBe(true);
      yield* serve(broker, "desktop", { remote: ["read"] }, () => ({ error: "not granted" }));
      expect(yield* failureMessage(broker.forward("listProjects", ["other"], ["other"]))).toContain(
        "other",
      );
      expect(yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"]))).toBe(
        "not granted",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects answers from another app and fails calls when their app disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const events = yield* broker
        .connect("desktop", { remote: ["read"] })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
      const call = yield* broker
        .forward("listProjects", ["remote"], ["remote"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const [event] = yield* Fiber.join(events);
      const spoofed = yield* Effect.exit(
        broker.respond("intruder", {
          connectionId: event!.connectionId,
          invocationId: event!.invocationId,
          result: "spoofed",
        }),
      );
      expect(Exit.isFailure(spoofed)).toBe(true);
      // The stream ended after one event, which disconnects its app.
      expect(yield* failureMessage(Fiber.join(call))).toContain("disconnected");
      expect(broker.available()).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("relays calls whose arguments hold undefined fields in a form the wire can encode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      // The relay RPC encodes each event as JSON; one unencodable event used to end the app's
      // whole relay stream, so every later call for its environments failed until a restart.
      const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(McpGatewayRelayEvent));
      const received: Array<ReadonlyArray<unknown>> = [];
      yield* broker.connect("desktop", { remote: ["read", "create"] }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* encode(event);
            received.push(event.args);
            yield* broker.respond("desktop", {
              connectionId: event.connectionId,
              invocationId: event.invocationId,
              result: event.method,
            });
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      // Profile sharing sends profiles whose optional model selection is undefined.
      const profiles = [{ name: "Builder", modelSelection: undefined, runtimeMode: "auto" }];
      expect(
        yield* broker.forward("replicateProfiles", ["remote", profiles, undefined], ["remote"]),
      ).toBe("replicateProfiles");
      expect(yield* broker.forward("listThreads", ["remote"], ["remote"])).toBe("listThreads");
      expect(received).toEqual([
        ["remote", [{ name: "Builder", runtimeMode: "auto" }]],
        ["remote"],
      ]);
      expect(broker.available()).toBe(true);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(
        yield* failureMessage(broker.forward("createSkill", ["remote", cyclic], ["remote"])),
      ).toContain("cannot be relayed");
      expect(broker.available()).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("checks this server's own calls against their contract both ways", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const remote = EnvironmentId.make("remote");
      yield* serve(broker, "desktop", { remote: ["read"] }, (method, args) =>
        method === "listThreads"
          ? {
              result: {
                items: [{ id: "child", settledAt: "2026-10-22T09:00:00.000Z", extra: true }],
              },
            }
          : { result: { id: args[1], runs: "not a list" } },
      );
      const listed = yield* broker.call("listThreads", [remote]);
      expect(listed.items.map((item) => item.id)).toEqual(["child"]);
      expect(DateTime.isDateTime(listed.items[0]?.settledAt)).toBe(true);
      expect(
        yield* failureMessage(broker.call("getThread", [remote, ThreadId.make("child")])),
      ).toContain("cannot read");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
