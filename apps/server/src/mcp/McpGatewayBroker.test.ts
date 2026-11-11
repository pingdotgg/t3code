import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpGatewayRelayEvent,
  type McpGatewayRelayGrants,
  ThreadId,
  ThreadTaskError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Membership from "../peer/Membership.ts";
import { make } from "./McpGatewayBroker.ts";
import {
  CODE_PAIRED_SUBJECT,
  DESKTOP_APP_SUBJECT,
  layerDependencies,
} from "./McpGatewayBroker.testkit.ts";

type Broker = Effect.Success<typeof make>;

const here = EnvironmentId.make("here");
const remote = EnvironmentId.make("remote");

const failureMessage = <E extends { readonly message: string }>(
  effect: Effect.Effect<unknown, E>,
) => effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }));

/** Connects an app that answers every call with what `answer` returns for its method. */
const serve = (
  broker: Broker,
  owner: string,
  grants: McpGatewayRelayGrants,
  answer: (
    method: string,
    args: ReadonlyArray<unknown>,
  ) => { result?: unknown; error?: string; unreachable?: true; taskError?: unknown },
  subject = CODE_PAIRED_SUBJECT,
) =>
  broker.connect(owner, grants, subject).pipe(
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
      yield* serve(
        broker,
        "desktop",
        { remote: ["read", "send"], other: ["read"] },
        (method) => ({ result: `desktop:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      expect(broker.available()).toBe(true);
      expect((yield* broker.access).grants).toEqual({ remote: ["read", "send"], other: ["read"] });
      expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe(
        "desktop:listProjects",
      );
      expect(yield* broker.forward("listThreads", ["other"], ["other"])).toBe(
        "desktop:listThreads",
      );
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("routes each call only to an app holding the scopes it needs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(
        broker,
        "desktop",
        { remote: ["read", "send"] },
        (method) => ({ result: `desktop:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      yield* serve(
        broker,
        "phone",
        { remote: ["read"] },
        (method) => ({ result: `phone:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe(
        "phone:listProjects",
      );
      const send = { environmentId: "remote", threadId: "thread", text: "hi" };
      expect(yield* broker.forward("sendMessage", [send], ["remote"])).toBe("desktop:sendMessage");
      const control = { environmentId: "remote", threadId: "thread", action: "restart" };
      expect(
        yield* failureMessage(broker.forward("controlThread", [control], ["remote"])),
      ).toContain("remote");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("never lets one app's grant widen the call another app serves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(broker, "desktop", { remote: ["read", "create", "send"] }, (method) => ({
        result: `desktop:${method}`,
      }));
      yield* serve(
        broker,
        "phone",
        { remote: ["read", "artifact"] },
        (method) => ({ result: `phone:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      // Together the two apps hold every scope a handoff needs, but neither holds them all.
      const handoff = { sourceEnvironmentId: "remote", environmentId: "remote" };
      expect(
        yield* failureMessage(broker.forward("handoffThread", [handoff], ["remote"])),
      ).toContain("remote");
    }),
  ).pipe(Effect.provide(layerDependencies())),
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
        yield* serve(
          broker,
          "studio",
          { studio: ["read"] },
          () => ({ result: [summary("studio", "connected")] }),
          DESKTOP_APP_SUBJECT,
        );
        yield* serve(
          broker,
          "laptop",
          { laptop: ["read"], studio: ["read"] },
          () => ({ result: [summary("laptop", "connected"), summary("studio", "connecting")] }),
          DESKTOP_APP_SUBJECT,
        );
        // An app that stopped answering must not hold up the others' environments.
        yield* broker
          .connect("asleep", { asleep: ["read"], laptop: ["read"] }, DESKTOP_APP_SUBJECT)
          .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }));
        const listing = yield* broker
          .forward("listEnvironments", [], [])
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(listing)).toEqual([
          summary("laptop", "connected"),
          summary("studio", "connected"),
        ]);
        // A read the silent app leaves unanswered runs on the next app; the silent app then goes
        // last for that environment.
        const read = yield* broker
          .forward("listProjects", ["laptop"], ["laptop"])
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust("60 seconds");
        const fromLaptop = [summary("laptop", "connected"), summary("studio", "connecting")];
        expect(yield* Fiber.join(read)).toEqual(fromLaptop);
        expect(yield* broker.forward("listProjects", ["laptop"], ["laptop"])).toEqual(fromLaptop);
      }),
    ).pipe(Effect.provide(layerDependencies())),
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
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("keeps a task error an app answers typed, and any other answer untyped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const typed = { _tag: "ThreadTaskError", code: "task_not_found", detail: "No task." };
      let taskError: unknown;
      yield* serve(broker, "desktop", { remote: ["read"] }, () => ({
        error: "task_not_found: No task.",
        taskError,
      }));
      const read = () =>
        Effect.flip(
          Effect.asVoid(
            broker.forward("threadTask", ["remote", { action: "read", input: {} }], ["remote"]),
          ),
        );
      taskError = typed;
      const failure = yield* read();
      expect(failure).toBeInstanceOf(ThreadTaskError);
      expect(failure).toMatchObject({ code: "task_not_found", detail: "No task." });
      // An older app sends only the message; a task error that does not decode is ignored.
      for (const wire of [undefined, { ...typed, code: "bogus" }, { _tag: "ThreadTaskError" }]) {
        taskError = wire;
        const untyped = yield* read();
        expect(untyped._tag).toBe("McpGatewayUnavailableError");
        expect(untyped.message).toBe("task_not_found: No task.");
      }
      // This server's own typed calls still fail as unreachable, never as the app's task error.
      taskError = typed;
      const own = yield* Effect.flip(
        Effect.asVoid(
          broker.call("threadTask", [remote, { action: "projectSnapshot", input: {} }]),
        ),
      );
      expect(own._tag).toBe("McpGatewayUnavailableError");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("rejects answers from another app and fails calls when their app disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const events = yield* broker
        .connect("desktop", { remote: ["read"] }, CODE_PAIRED_SUBJECT)
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
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("relays calls whose arguments hold undefined fields in a form the wire can encode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      // The relay RPC encodes each event as JSON; one unencodable event used to end the app's
      // whole relay stream, so every later call for its environments failed until a restart.
      const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(McpGatewayRelayEvent));
      const received: Array<ReadonlyArray<unknown>> = [];
      yield* broker.connect("desktop", { remote: ["read", "create"] }, CODE_PAIRED_SUBJECT).pipe(
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
  ).pipe(Effect.provide(layerDependencies())),
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
  ).pipe(Effect.provide(layerDependencies())),
);

const createThread = { environmentId: "remote", projectId: "project", title: "Child" };

it.effect("caps every app's grant at what the roster lets this machine do, at call time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const membership = yield* Membership.Membership;
      const putMember = (
        environmentId: EnvironmentId,
        access: "full-access" | "approval-required" | "read-only" | "revoked",
      ) => membership.put({ environmentId, label: environmentId, nodeId: null, access });
      yield* putMember(here, "full-access");
      yield* putMember(remote, "full-access");
      yield* membership.putApp({ appId: "desktop", label: "Desktop", access: "full-access" });
      yield* serve(
        broker,
        "desktop",
        { remote: ["read", "create", "send"] },
        (method) => ({ result: method }),
        "network-app:desktop",
      );
      expect(yield* broker.forward("createThread", [createThread], ["remote"])).toBe(
        "createThread",
      );
      // Apps carry no agent mode ceiling, so anything short of full access only reads.
      for (const access of ["approval-required", "read-only"] as const) {
        yield* putMember(here, access);
        expect(
          yield* failureMessage(broker.forward("createThread", [createThread], ["remote"])),
        ).not.toBe("ok");
        expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe("listProjects");
      }
      yield* putMember(here, "revoked");
      expect(
        yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"])),
      ).not.toBe("ok");
      expect(yield* failureMessage(broker.forward("listEnvironments", [], []))).not.toBe("ok");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("relays a network member only through an app of the network, within its access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const membership = yield* Membership.Membership;
      yield* membership.put({
        environmentId: here,
        label: "here",
        nodeId: null,
        access: "full-access",
      });
      yield* membership.put({
        environmentId: remote,
        label: "remote",
        nodeId: null,
        access: "full-access",
      });
      // A session paired by code has no identity the roster can bind to a member.
      yield* serve(broker, "browser", { remote: ["read", "create"] }, (method) => ({
        result: `browser:${method}`,
      }));
      expect(
        yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"])),
      ).not.toBe("ok");
      yield* membership.putApp({ appId: "phone", label: "Phone", access: "full-access" });
      yield* serve(
        broker,
        "phone",
        { remote: ["read", "create"], elsewhere: ["read"] },
        (method) => ({ result: `phone:${method}` }),
        "network-app:phone",
      );
      expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe(
        "phone:listProjects",
      );
      // An app of the network reaches its members, not an environment outside it.
      expect(
        yield* failureMessage(broker.forward("listProjects", ["elsewhere"], ["elsewhere"])),
      ).not.toBe("ok");
      yield* membership.putApp({ appId: "phone", label: "Phone", access: "read-only" });
      expect(
        yield* failureMessage(broker.forward("createThread", [createThread], ["remote"])),
      ).not.toBe("ok");
      yield* membership.putApp({ appId: "phone", label: "Phone", access: "revoked" });
      expect(
        yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"])),
      ).not.toBe("ok");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("relays nothing while linked environments is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(broker, "desktop", { remote: ["read"] }, (method) => ({ result: method }));
      expect(
        yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"])),
      ).toContain("Linked environments is off");
      expect(yield* failureMessage(broker.call("listThreads", [remote]))).toContain(
        "Linked environments is off",
      );
    }),
  ).pipe(Effect.provide(layerDependencies({ linksOff: true }))),
);

it.effect(
  "relays to a network member through this machine's own desktop app, within its access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const membership = yield* Membership.Membership;
        const putMember = (environmentId: EnvironmentId, access: "full-access" | "read-only") =>
          membership.put({ environmentId, label: environmentId, nodeId: null, access });
        yield* putMember(here, "full-access");
        yield* putMember(remote, "full-access");
        // Any other session paired by code still cannot reach a member.
        yield* serve(broker, "browser", { remote: ["read", "create"] }, (method) => ({
          result: `browser:${method}`,
        }));
        expect(
          yield* failureMessage(broker.forward("listProjects", ["remote"], ["remote"])),
        ).not.toBe("ok");
        yield* serve(
          broker,
          "desktop",
          { remote: ["read", "create", "send"] },
          (method) => ({ result: `desktop:${method}` }),
          DESKTOP_APP_SUBJECT,
        );
        expect(yield* broker.forward("createThread", [createThread], ["remote"])).toBe(
          "desktop:createThread",
        );
        // This server's own task calls take the same route under the same cap.
        const assign = { action: "remoteAssign", input: {} } as const;
        const snapshot = { action: "projectSnapshot", input: {} } as const;
        expect(yield* broker.call("threadTask", [remote, assign])).toBe("desktop:threadTask");
        yield* putMember(here, "read-only");
        expect(
          yield* failureMessage(broker.forward("createThread", [createThread], ["remote"])),
        ).toContain("read-only");
        expect(yield* failureMessage(broker.call("threadTask", [remote, assign]))).toContain(
          "read-only",
        );
        expect(yield* broker.call("threadTask", [remote, snapshot])).toBe("desktop:threadTask");
        expect(yield* broker.forward("listProjects", ["remote"], ["remote"])).toBe(
          "desktop:listProjects",
        );
      }),
    ).pipe(Effect.provide(layerDependencies())),
);

it.effect("runs a call on the earliest session paired by code whose own grant covers it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(broker, "laptop", { elsewhere: ["read"] }, (method) => ({
        result: `laptop:${method}`,
      }));
      yield* serve(broker, "studio", { elsewhere: ["read", "create"] }, (method) => ({
        result: `studio:${method}`,
      }));
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "laptop:listProjects",
      );
      // A grant that only reads never blocks one that covers the call.
      const elsewhere = { ...createThread, environmentId: "elsewhere" };
      expect(yield* broker.forward("createThread", [elsewhere], ["elsewhere"])).toBe(
        "studio:createThread",
      );
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("runs a call on another app only when it cannot have run on the first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const elsewhere = { ...createThread, environmentId: "elsewhere" };
      const laptopCalls: Array<string> = [];
      yield* serve(broker, "laptop", { elsewhere: ["read", "create"] }, (method) => {
        laptopCalls.push(method);
        return { result: `laptop:${method}` };
      });
      // This machine's desktop app goes first, takes one call at a time, and never answers.
      yield* broker.connect("desktop", { elsewhere: ["read", "create"] }, DESKTOP_APP_SUBJECT).pipe(
        Stream.runForEach(() => Effect.never),
        Effect.forkScoped({ startImmediately: true }),
      );
      const read = yield* broker
        .forward("listProjects", ["elsewhere"], ["elsewhere"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      // Queued behind the read, this write never reaches the desktop app.
      const queued = yield* broker
        .forward("createThread", [elsewhere], ["elsewhere"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("60 seconds");
      expect(yield* Fiber.join(read)).toBe("laptop:listProjects");
      expect(yield* Fiber.join(queued)).toBe("laptop:createThread");

      // A write the app received but never answered may have run, so it is not run again.
      yield* broker
        .connect("desktop-again", { elsewhere: ["read", "create"] }, DESKTOP_APP_SUBJECT)
        .pipe(
          Stream.runForEach(() => Effect.never),
          Effect.forkScoped({ startImmediately: true }),
        );
      laptopCalls.length = 0;
      const delivered = yield* broker
        .forward("createThread", [elsewhere], ["elsewhere"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("60 seconds");
      expect(yield* failureMessage(Fiber.join(delivered))).toContain("may have run");
      expect(laptopCalls).toEqual([]);
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("offers a call only to apps that could relay it, whoever connected first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const membership = yield* Membership.Membership;
      yield* membership.put({
        environmentId: here,
        label: "here",
        nodeId: null,
        access: "full-access",
      });
      yield* membership.putApp({ appId: "phone", label: "Phone", access: "full-access" });
      // An app of the network does not relay a machine outside it, so it is never offered one.
      const phone = yield* serve(
        broker,
        "phone",
        { elsewhere: ["read"] },
        (method) => ({ result: `phone:${method}` }),
        "network-app:phone",
      );
      yield* serve(broker, "laptop", { elsewhere: ["read"] }, (method) => ({
        result: `laptop:${method}`,
      }));
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "laptop:listProjects",
      );
      yield* Fiber.interrupt(phone);
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "laptop:listProjects",
      );
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("frees an environment a session paired by code held once it disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const first = yield* serve(broker, "first", { elsewhere: ["read"] }, (method) => ({
        result: `first:${method}`,
      }));
      yield* serve(broker, "second", { elsewhere: ["read"] }, (method) => ({
        result: `second:${method}`,
      }));
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "first:listProjects",
      );
      yield* Fiber.interrupt(first);
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "second:listProjects",
      );
      // This machine's own desktop app vouches for what it relays, so it goes first.
      yield* serve(
        broker,
        "desktop",
        { elsewhere: ["read"] },
        (method) => ({ result: `desktop:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      yield* serve(broker, "third", { elsewhere: ["read"] }, (method) => ({
        result: `third:${method}`,
      }));
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "desktop:listProjects",
      );
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("refuses a call that names no environment its scopes can be checked on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(
        broker,
        "desktop",
        { remote: ["read", "create", "send", "artifact", "admin", "lifecycle"] },
        (method) => ({ result: method }),
        DESKTOP_APP_SUBJECT,
      );
      const refused = [
        broker.forward("handoffThread", [{ environmentId: "remote" }], ["remote"]),
        broker.forward("createThread", [{ projectId: "project" }], []),
        broker.forward("unknownMethod" as never, ["remote"], ["remote"]),
      ];
      for (const call of refused) expect(yield* failureMessage(call)).not.toBe("ok");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect(
  "shows agents only what the roster lets this machine reach, and why the rest is not",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make;
        const membership = yield* Membership.Membership;
        yield* membership.put({
          environmentId: here,
          label: "here",
          nodeId: null,
          access: "read-only",
        });
        yield* membership.put({
          environmentId: remote,
          label: "remote",
          nodeId: null,
          access: "full-access",
        });
        yield* serve(
          broker,
          "browser",
          { remote: ["read"], elsewhere: ["read", "create"] },
          () => ({}),
        );
        const access = yield* broker.access;
        expect(access.grants).toEqual({ elsewhere: ["read"] });
        expect(access.refusals.remote).toContain("network");
        expect(broker.view()).toEqual(access);
        // An app is shown what this server would relay for it, by the same rules.
        yield* membership.putApp({ appId: "phone", label: "Phone", access: "full-access" });
        const preview = yield* broker.preview(
          "phone-session",
          { remote: ["read", "create"], elsewhere: ["read"] },
          "network-app:phone",
        );
        expect(preview.grants).toEqual({ remote: ["read"] });
        expect(preview.refusals.elsewhere).toContain("not in the network");
        expect(preview.limit).toContain("read-only");
      }),
    ).pipe(Effect.provide(layerDependencies())),
);

it.effect("gives a task watch its own longest wait before trying another app", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const watch = ["elsewhere", { action: "watch", input: {} }];
      for (const [delay, answeredBy] of [
        ["60001 millis", "desktop:threadTask"],
        ["120001 millis", "laptop:threadTask"],
      ] as const) {
        const broker = yield* make;
        yield* serve(broker, "laptop", { elsewhere: ["read"] }, (method) => ({
          result: `laptop:${method}`,
        }));
        // The desktop app answers a quiet watch only when it ends.
        yield* broker.connect("desktop", { elsewhere: ["read"] }, DESKTOP_APP_SUBJECT).pipe(
          Stream.runForEach((event) =>
            Effect.sleep(event.method === "threadTask" ? delay : "0 millis").pipe(
              Effect.andThen(
                broker.respond("desktop", {
                  connectionId: event.connectionId,
                  invocationId: event.invocationId,
                  result: `desktop:${event.method}`,
                }),
              ),
              Effect.ignore,
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const watched = yield* broker
          .forward("threadTask", watch, ["elsewhere"])
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust(delay);
        expect(yield* Fiber.join(watched)).toBe(answeredBy);
      }
      // A watch that answers within its wait leaves its app first in line.
      const broker = yield* make;
      yield* serve(broker, "laptop", { elsewhere: ["read"] }, (method) => ({
        result: `laptop:${method}`,
      }));
      yield* broker.connect("desktop", { elsewhere: ["read"] }, DESKTOP_APP_SUBJECT).pipe(
        Stream.runForEach((event) =>
          Effect.sleep(event.method === "threadTask" ? "60001 millis" : "0 millis").pipe(
            Effect.andThen(
              broker.respond("desktop", {
                connectionId: event.connectionId,
                invocationId: event.invocationId,
                result: `desktop:${event.method}`,
              }),
            ),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const watched = yield* broker
        .forward("threadTask", watch, ["elsewhere"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("60001 millis");
      yield* Fiber.join(watched);
      expect(yield* broker.forward("listProjects", ["elsewhere"], ["elsewhere"])).toBe(
        "desktop:listProjects",
      );
    }),
  ).pipe(Effect.provide(layerDependencies())),
);

it.effect("routes around an app per environment it cannot reach, not for its errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      yield* serve(broker, "laptop", { c: ["read"] }, (method) => ({ result: `laptop:${method}` }));
      yield* serve(
        broker,
        "phone",
        { b: ["read"] },
        (method) => ({ result: `phone:${method}` }),
        DESKTOP_APP_SUBJECT,
      );
      let failNext = true;
      // The desktop app goes first; it reaches c, but not b.
      yield* serve(
        broker,
        "desktop",
        { b: ["read"], c: ["read"] },
        (method, args) =>
          args[0] === "b"
            ? { error: "b is not connected in this app.", unreachable: true }
            : failNext
              ? ((failNext = false), { error: "Project not found." })
              : { result: `desktop:${method}` },
        DESKTOP_APP_SUBJECT,
      );
      const list = (environmentId: string) =>
        broker.forward("listProjects", [environmentId], [environmentId]);
      // An application error goes back to the agent and leaves the app first in line.
      expect(yield* failureMessage(list("c"))).toBe("Project not found.");
      expect(yield* list("b")).toBe("phone:listProjects");
      expect(yield* list("c")).toBe("desktop:listProjects");
      expect(yield* list("b")).toBe("phone:listProjects");
      expect(yield* list("c")).toBe("desktop:listProjects");
    }),
  ).pipe(Effect.provide(layerDependencies())),
);
