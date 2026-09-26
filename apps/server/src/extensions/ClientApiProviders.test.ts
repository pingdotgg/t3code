import { EnvironmentId, type ClientProviderServerFrame } from "@t3tools/contracts";
import type { ExtensionViewContext } from "@t3tools/contracts";
import type { HostApiPrincipal } from "@t3tools/extension-runtime";
import { it, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ClientApiProviders, layer as clientApiProvidersLayer } from "./ClientApiProviders.ts";

const ENV = "env-a";
const DESCRIPTORS = [
  { id: "t3.client/theme", version: "1.0.0" },
  { id: "t3.client/notifications", version: "1.0.0" },
] as const;

const testLayer = clientApiProvidersLayer.pipe(
  Layer.provide(
    Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(ENV)),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);

const socket = (connectionId: string, sessionId = "session-a") => ({
  connectionId,
  sessionId,
  announcedOrigin: { surface: "web" },
});

const context: ExtensionViewContext = {
  resource: {
    namespace: "t3.extensions",
    id: "ext.a",
    environmentId: EnvironmentId.make(ENV),
  },
  client: "web",
} as ExtensionViewContext;

const caller = {
  installationId: "ext.a",
  contentHash: "hash-a",
  installationGeneration: 1,
};

const connectInput = (
  providers: readonly { id: string; version: string }[] = [...DESCRIPTORS],
) => ({
  providers: [...providers],
});

/**
 * A schema-valid `getState`/`watchState` payload — the seam enforces the
 * declared `t3.client/*` contracts in both directions, so test envelopes
 * carry the adapter-stamped `target` and real provider outputs.
 */
const SELF_INPUT = { target: { kind: "self" } };
const THEME_STATE = {
  theme: "t3-dark",
  resolvedTheme: "dark",
  systemDark: true,
  followSystem: false,
  appearanceMode: "dark",
  themeHalves: null,
  effectiveTheme: { kind: "stored", theme: "t3-dark" },
  sessionOverlay: null,
};

/** Pulls the next frame off a live connect stream (no TestClock involved). */
const nextFrame = (iterator: AsyncIterator<ClientProviderServerFrame>) =>
  Effect.promise<ClientProviderServerFrame | undefined>(async () => {
    const next = await iterator.next();
    return next.done ? undefined : next.value;
  });

const frameIterator = (stream: Stream.Stream<ClientProviderServerFrame>) =>
  Stream.toAsyncIterableWith(stream, Context.empty())[Symbol.asyncIterator]();

it.effect("connect mints a registered frame and filters unknown providers", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(
      socket("conn-1"),
      connectInput([
        ...DESCRIPTORS,
        { id: "t3.client/ghost", version: "1.0.0" },
        { id: "t3.client/theme", version: "99.0.0" },
      ]),
    );
    const frames = yield* stream.pipe(Stream.take(1), Stream.runCollect);
    const registered = frames[0];
    expect(registered?.type).toBe("registered");
    if (registered?.type !== "registered") return;
    expect(registered.connectionId).toBe("conn-1");
    expect(registered.accepted.map((p) => p.id)).toEqual([
      "t3.client/theme",
      "t3.client/notifications",
    ]);
    expect(registered.rejected).toEqual([
      { id: "t3.client/ghost", reason: "unknown-provider" },
      { id: "t3.client/theme", reason: "unsupported-version" },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("invoke routes a frame to the owning socket and resolves on respond", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("conn-2"), connectInput());
    const frames = frameIterator(stream);
    const pending = yield* providers
      .invoke({
        connectionId: "conn-2",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.forkChild);
    yield* nextFrame(frames); // registered
    const frame = yield* nextFrame(frames);
    expect(frame?.type).toBe("invoke");
    if (frame?.type !== "invoke") return;
    expect(frame.method).toBe("getState");
    expect(frame.caller.installationId).toBe("ext.a");
    // A respond on the wrong socket is dropped, not routed.
    yield* providers.respond("conn-foreign", {
      requestId: frame.requestId,
      ok: true,
      value: { spoofed: true },
    });
    yield* providers.respond("conn-2", {
      requestId: frame.requestId,
      ok: true,
      value: THEME_STATE,
    });
    const result = yield* Fiber.join(pending);
    expect(result).toEqual(THEME_STATE);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("invoke fails unavailable when the provider is not hosted", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const exit = yield* providers
      .invoke({
        connectionId: "conn-missing",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.exit);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("client-provider-unavailable");
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("disconnect fails pending invokes and revokes correlations", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("conn-3"), connectInput());
    const revoked = { called: false };
    const frames = frameIterator(stream);
    yield* nextFrame(frames); // registered — stream live, conn-3 connected
    yield* providers.registerCorrelation("corr-1", {
      connectionId: "conn-3",
      kind: "notification",
      deliver: () => {},
      revoked: () => {
        revoked.called = true;
      },
    });
    // Returning the iterator ends the connect stream — the disconnect signal.
    yield* Effect.promise(() => frames.return!());
    expect(revoked.called).toBe(true);
    // Registration on the now-dead connection is refused.
    const stale = yield* providers
      .registerCorrelation("corr-1b", {
        connectionId: "conn-3",
        kind: "notification",
        deliver: () => {},
        revoked: () => {},
      })
      .pipe(Effect.exit);
    expect(stale._tag).toBe("Failure");
    // A live connection fails its in-flight invokes when the socket dies.
    const stream2 = yield* providers.connect(socket("conn-4"), connectInput());
    const pending = yield* providers
      .invoke({
        connectionId: "conn-4",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
        timeoutMs: 30_000,
      })
      .pipe(Effect.forkChild);
    yield* stream2.pipe(Stream.take(1), Stream.runDrain);
    const exit = yield* Fiber.await(pending);
    expect(exit._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("subscriptions deliver emits on the owning socket and close cleanly", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("conn-5"), connectInput());
    const frames = frameIterator(stream);
    const subscription = yield* providers.openSubscription({
      connectionId: "conn-5",
      apiId: "t3.client/theme",
      name: "watchState",
      input: SELF_INPUT,
      context,
      caller,
    });
    yield* nextFrame(frames); // registered
    const openFrame = yield* nextFrame(frames);
    expect(openFrame?.type).toBe("subscriptionOpen");
    if (openFrame?.type !== "subscriptionOpen") return;
    const subscriptionId = openFrame.subscriptionId;
    // Emits on a foreign socket are dropped; owner emits land on the sink.
    yield* providers.emit("conn-foreign", {
      correlationId: subscriptionId,
      event: { type: "data", value: { spoofed: true } },
    });
    yield* providers.emit("conn-5", {
      correlationId: subscriptionId,
      event: { type: "data", value: THEME_STATE },
    });
    const first = yield* Effect.promise(() => subscription.events[Symbol.asyncIterator]().next());
    expect(first.done).toBe(false);
    expect((first as { value: { value: unknown } }).value.value).toEqual(THEME_STATE);
    // subscriptionClose reaches the client; the sink completes.
    yield* subscription.close();
    const closeFrame = yield* nextFrame(frames);
    expect(closeFrame?.type).toBe("subscriptionClose");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a reconnect replaces the connection — old pending fails, stale teardown kills nothing",
  () =>
    Effect.gen(function* () {
      const providers = yield* ClientApiProviders;
      const first = yield* providers.connect(socket("conn-9"), connectInput());
      const firstFrames = frameIterator(first);
      yield* nextFrame(firstFrames); // registered
      const pending = yield* providers
        .invoke({
          connectionId: "conn-9",
          apiId: "t3.client/theme",
          method: "getState",
          input: SELF_INPUT,
          context,
          caller,
          timeoutMs: 30_000,
        })
        .pipe(Effect.forkChild);
      yield* nextFrame(firstFrames); // the dispatched invoke
      // The same connectionId reconnects — the old socket is replaced.
      const second = yield* providers.connect(socket("conn-9"), connectInput());
      // The invoke dispatched to the dead socket can never be responded to:
      // it fails at replace time, not at timeout.
      const exit = yield* Fiber.await(pending);
      expect(exit._tag).toBe("Failure");
      expect(String((exit as { cause: unknown }).cause)).toContain("connection closed");
      // The old stream ending must not tear the replacement down.
      yield* Effect.promise(() => firstFrames.return!());
      const secondFrames = frameIterator(second);
      yield* nextFrame(secondFrames); // registered
      const followUp = yield* providers
        .invoke({
          connectionId: "conn-9",
          apiId: "t3.client/theme",
          method: "getState",
          input: SELF_INPUT,
          context,
          caller,
        })
        .pipe(Effect.forkChild);
      const frame = yield* nextFrame(secondFrames);
      expect(frame?.type).toBe("invoke");
      if (frame?.type === "invoke") {
        yield* providers.respond("conn-9", {
          requestId: frame.requestId,
          ok: true,
          value: THEME_STATE,
        });
      }
      const result = yield* Fiber.join(followUp);
      expect(result).toEqual(THEME_STATE);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a mid-flight abort cancels the pending invoke and a late respond is dropped", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("conn-10"), connectInput());
    const frames = frameIterator(stream);
    yield* nextFrame(frames); // registered
    const controller = new AbortController();
    const pending = yield* providers
      .invoke({
        connectionId: "conn-10",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
        timeoutMs: 30_000,
        signal: controller.signal,
      })
      .pipe(Effect.forkChild);
    const invokeFrame = yield* nextFrame(frames);
    expect(invokeFrame?.type).toBe("invoke");
    controller.abort();
    // The abort reaches the client as a cancel frame; the waiter fails fast.
    const cancel = yield* nextFrame(frames);
    expect(cancel?.type).toBe("cancel");
    const exit = yield* Fiber.await(pending);
    expect(exit._tag).toBe("Failure");
    expect(String((exit as { cause: unknown }).cause)).toContain("client-request-timeout");
    // A respond for the dead request is dropped — the record is already gone.
    if (invokeFrame?.type === "invoke") {
      yield* providers.respond("conn-10", {
        requestId: invokeFrame.requestId,
        ok: true,
        value: { late: true },
      });
    }
    // The connection stays live and keeps routing.
    const followUp = yield* providers
      .invoke({
        connectionId: "conn-10",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.forkChild);
    expect((yield* nextFrame(frames))?.type).toBe("invoke");
    yield* Fiber.interrupt(followUp);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("resolveTarget binds hints to the caller's own session only", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    yield* Effect.asVoid(providers.connect(socket("conn-6", "session-a"), connectInput()));
    yield* Effect.asVoid(providers.connect(socket("conn-7", "session-b"), connectInput()));
    const envSession = (id: string) =>
      ({ kind: "environment-session", id }) as unknown as HostApiPrincipal;
    // Own-session hint resolves; a sibling session's connection is denied.
    const resolved = yield* providers.resolveTarget(ENV, envSession("session-a"), "conn-6");
    expect(resolved).toBe("conn-6");
    const foreign = yield* providers
      .resolveTarget(ENV, envSession("session-a"), "conn-7")
      .pipe(Effect.exit);
    expect(foreign._tag).toBe("Failure");
    // No hint, stale connection, and provider sessions are all denied.
    const noHint = yield* providers
      .resolveTarget(ENV, envSession("session-a"), undefined)
      .pipe(Effect.exit);
    expect(noHint._tag).toBe("Failure");
    const stale = yield* providers
      .resolveTarget(ENV, envSession("session-a"), "conn-gone")
      .pipe(Effect.exit);
    expect(stale._tag).toBe("Failure");
    const provider = yield* providers
      .resolveTarget(
        ENV,
        { kind: "provider-session", id: "p" } as unknown as HostApiPrincipal,
        "conn-6",
      )
      .pipe(Effect.exit);
    expect(provider._tag).toBe("Failure");
    // Host-originated calls may name any live connection explicitly.
    const hostResolved = yield* providers.resolveTarget(
      ENV,
      { kind: "host" } as unknown as HostApiPrincipal,
      "conn-7",
    );
    expect(hostResolved).toBe("conn-7");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("listTargets reports live connections for this environment only", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    yield* Effect.asVoid(providers.connect(socket("conn-8"), connectInput()));
    const targets = yield* providers.listTargets(ENV);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.connectionId).toBe("conn-8");
    expect(targets[0]?.providers.map((p) => p.id)).toEqual([
      "t3.client/theme",
      "t3.client/notifications",
    ]);
    expect(yield* providers.listTargets("env-b")).toEqual([]);
    expect(yield* providers.hasProvider(ENV, "t3.client/theme")).toBe(true);
    expect(yield* providers.hasProvider(ENV, "t3.client/panels")).toBe(false);
    expect(yield* providers.connectionForSession("session-a", "conn-8")).toBe(true);
    expect(yield* providers.connectionForSession("session-b", "conn-8")).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("enforces the declared private schemas in both directions", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("conn-11"), connectInput());
    const frames = frameIterator(stream);
    yield* nextFrame(frames); // registered

    // An input missing the adapter-stamped `target` never reaches the socket.
    const badInput = yield* providers
      .invoke({
        connectionId: "conn-11",
        apiId: "t3.client/theme",
        method: "getState",
        input: {},
        context,
        caller,
      })
      .pipe(Effect.exit);
    expect(badInput._tag).toBe("Failure");
    expect(String((badInput as { cause: unknown }).cause)).toContain("provider-rejected");

    // Undeclared ops and streams are refused before dispatch.
    const badMethod = yield* providers
      .invoke({
        connectionId: "conn-11",
        apiId: "t3.client/theme",
        method: "notARealOp",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.exit);
    expect(badMethod._tag).toBe("Failure");
    const badStream = yield* providers
      .openSubscription({
        connectionId: "conn-11",
        apiId: "t3.client/theme",
        name: "notARealStream",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.exit);
    expect(badStream._tag).toBe("Failure");

    // A claimed success that violates the retained output schema fails the waiter.
    const pending = yield* providers
      .invoke({
        connectionId: "conn-11",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.forkChild);
    const invokeFrame = yield* nextFrame(frames);
    expect(invokeFrame?.type).toBe("invoke");
    if (invokeFrame?.type !== "invoke") return;
    yield* providers.respond("conn-11", {
      requestId: invokeFrame.requestId,
      ok: true,
      value: { state: 1 },
    });
    const exit = yield* Fiber.await(pending);
    expect(exit._tag).toBe("Failure");
    expect(String((exit as { cause: unknown }).cause)).toContain("provider-rejected");

    // An out-of-schema event fails the subscription, not the connection.
    const subscription = yield* providers.openSubscription({
      connectionId: "conn-11",
      apiId: "t3.client/theme",
      name: "watchState",
      input: SELF_INPUT,
      context,
      caller,
    });
    const openFrame = yield* nextFrame(frames);
    expect(openFrame?.type).toBe("subscriptionOpen");
    if (openFrame?.type !== "subscriptionOpen") return;
    yield* providers.emit("conn-11", {
      correlationId: openFrame.subscriptionId,
      event: { type: "data", value: { n: 1 } },
    });
    const eventExit = yield* Effect.promise(() =>
      subscription.events[Symbol.asyncIterator]().next(),
    ).pipe(Effect.exit);
    expect(eventExit._tag).toBe("Failure");
    expect(String((eventExit as { cause: unknown }).cause)).toContain("provider-rejected");

    // Unrelated requests are undisturbed.
    const followUp = yield* providers
      .invoke({
        connectionId: "conn-11",
        apiId: "t3.client/theme",
        method: "getState",
        input: SELF_INPUT,
        context,
        caller,
      })
      .pipe(Effect.forkChild);
    const followUpFrame = yield* nextFrame(frames);
    expect(followUpFrame?.type).toBe("invoke");
    if (followUpFrame?.type === "invoke") {
      yield* providers.respond("conn-11", {
        requestId: followUpFrame.requestId,
        ok: true,
        value: THEME_STATE,
      });
    }
    expect(yield* Fiber.join(followUp)).toEqual(THEME_STATE);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("closed stream frames still obey the copyJson envelope bound", () =>
  Effect.gen(function* () {
    const providers = yield* ClientApiProviders;
    const stream = yield* providers.connect(socket("r2-closed"), connectInput());
    const frames = frameIterator(stream);
    yield* nextFrame(frames); // registered
    const sub = yield* providers.openSubscription({
      connectionId: "r2-closed",
      apiId: "t3.client/theme",
      name: "watchState",
      input: SELF_INPUT,
      context,
      caller,
    });
    const frame = yield* nextFrame(frames);
    if (frame?.type !== "subscriptionOpen") throw new Error("missing subscription");
    yield* providers.emit("r2-closed", {
      correlationId: frame.subscriptionId,
      event: { type: "closed", value: "x".repeat(70 * 1024) },
    });
    const result = yield* Effect.promise(() => sub.events[Symbol.asyncIterator]().next()).pipe(
      Effect.exit,
    );
    yield* sub.close();
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer)),
);
