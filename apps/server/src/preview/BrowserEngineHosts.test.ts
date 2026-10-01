import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type BrowserEngineHostError,
  type BrowserEngineHostStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as BrowserEngineHosts from "./BrowserEngineHosts.ts";
import * as PreviewManager from "./Manager.ts";

const DESKTOP = { socketId: "desktop-ws", grantMethod: "desktop-bootstrap" } as const;
const threadId = ThreadId.make("thread-hosts");

const reasonOf = <A>(effect: Effect.Effect<A, BrowserEngineHostError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const registerHost = Effect.fn("test.registerHost")(function* (
  hosts: BrowserEngineHosts.BrowserEngineHosts["Service"],
  socket: BrowserEngineHosts.BrowserEngineHostSocket,
) {
  const events = yield* Queue.unbounded<BrowserEngineHostStreamEvent>();
  const stream = yield* hosts.register(socket);
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const registered = yield* Queue.take(events);
  if (registered.type !== "registered") throw new Error("expected registration first");
  return { events, fiber, hostConnectionId: registered.hostConnectionId };
});

const openClaimable = Effect.gen(function* () {
  const preview = yield* PreviewManager.PreviewManager;
  const opened = yield* preview.open({ threadId, url: "http://localhost:5173" });
  const { serverEpoch } = yield* preview.listDetails({ threadId });
  return { tabId: opened.tabId, serverEpoch, threadId };
});

it.layer(
  BrowserEngineHosts.layer.pipe(
    Layer.provideMerge(PreviewManager.layer),
    Layer.provide(NodeServices.layer),
  ),
)("BrowserEngineHosts", (it) => {
  it.effect("only a desktop-bootstrap grant session can register or act as a host", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const target = yield* openClaimable;
      // Pairing-link sessions carry the one-time-token grant; CLI, relay and
      // tunnel sessions are issued directly and carry none.
      for (const grantMethod of ["one-time-token", undefined] as const) {
        const remote = { socketId: `remote-${grantMethod ?? "direct"}`, grantMethod };
        expect(yield* reasonOf(hosts.register(remote))).toBe("desktop-required");
        expect(
          yield* reasonOf(
            hosts.claim(remote, { hostConnectionId: "any", target, engineGeneration: "1" }),
          ),
        ).toBe("desktop-required");
      }
      expect(yield* hosts.hasHost).toBe(false);
    }),
  );

  it.effect("a host id is honored only on the socket that registered it", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const target = yield* openClaimable;
      const { hostConnectionId, fiber } = yield* registerHost(hosts, DESKTOP);
      expect(yield* hosts.hasHost).toBe(true);
      // A second desktop window cannot replay the first window's host id.
      const otherWindow = { socketId: "desktop-ws-2", grantMethod: "desktop-bootstrap" } as const;
      expect(
        yield* reasonOf(
          hosts.claim(otherWindow, { hostConnectionId, target, engineGeneration: "1" }),
        ),
      ).toBe("host-not-registered");
      yield* hosts.claim(DESKTOP, { hostConnectionId, target, engineGeneration: "1" });

      yield* Fiber.interrupt(fiber);
      expect(yield* hosts.hasHost).toBe(false);
      // Disconnect retires the id: it cannot be used again even on its socket.
      expect(
        yield* reasonOf(hosts.claim(DESKTOP, { hostConnectionId, target, engineGeneration: "2" })),
      ).toBe("host-not-registered");
    }),
  );

  it.effect("an unanswered command resolves unknown after the bounded wait", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const target = yield* openClaimable;
      const { hostConnectionId, events } = yield* registerHost(hosts, DESKTOP);
      const pending = yield* Effect.forkChild(
        hosts.dispatch({
          hostConnectionId,
          target,
          engineGeneration: "1",
          command: { _tag: "reload" },
        }),
      );
      const command = yield* Queue.take(events);
      if (command.type !== "command") throw new Error("expected a command event");
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(pending)).toEqual({ outcome: "unknown" });
      // A late answer has nothing left to settle and is not an error.
      yield* hosts.commandResult(DESKTOP, {
        hostConnectionId,
        commandId: command.commandId,
        result: { outcome: "applied" },
      });

      expect(
        yield* hosts.dispatch({
          hostConnectionId: "never-registered",
          target,
          engineGeneration: "1",
          command: { _tag: "back" },
        }),
      ).toEqual({ outcome: "unknown" });
    }),
  );
});

it.layer(
  BrowserEngineHosts.layer.pipe(
    Layer.provideMerge(PreviewManager.layer),
    Layer.provide(NodeServices.layer),
  ),
)("BrowserEngineHosts profile commands", (it) => {
  it.effect("with no registered host a profile command is no-host, never unknown", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      expect(yield* hosts.dispatchProfile({ _tag: "listProfiles" })).toEqual({
        outcome: "no-host",
      });
    }),
  );

  it.effect("a profile command rides its own frame and returns the host's answer", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const { hostConnectionId, events } = yield* registerHost(hosts, DESKTOP);
      const pending = yield* Effect.forkChild(
        hosts.dispatchProfile({ _tag: "clearCookies", profileId: "work" }),
      );
      const frame = yield* Queue.take(events);
      expect(frame).toMatchObject({
        type: "profile-command",
        command: { _tag: "clearCookies", profileId: "work" },
      });
      if (frame.type !== "profile-command") throw new Error("expected a profile frame");
      // Another socket cannot answer for this host.
      const otherWindow = { socketId: "desktop-ws-2", grantMethod: "desktop-bootstrap" } as const;
      expect(
        yield* reasonOf(
          hosts.commandResult(otherWindow, {
            hostConnectionId,
            commandId: frame.commandId,
            result: { outcome: "applied" },
          }),
        ),
      ).toBe("host-not-registered");
      yield* hosts.commandResult(DESKTOP, {
        hostConnectionId,
        commandId: frame.commandId,
        result: { outcome: "rejected", reason: "unknown-profile" },
      });
      expect(yield* Fiber.join(pending)).toEqual({
        outcome: "rejected",
        reason: "unknown-profile",
      });
    }),
  );

  it.effect("cookie import waits past the ordinary bound but not forever", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const { events } = yield* registerHost(hosts, DESKTOP);
      const pending = yield* Effect.forkChild(
        hosts.dispatchProfile({
          _tag: "importCookies",
          profileId: "work",
          sourceId: "chrome",
          sourceProfile: "p0",
          requester: "t3.browser",
        }),
      );
      yield* Queue.take(events);
      // The user is still answering the host prompt at the ordinary bound.
      yield* TestClock.adjust("10 seconds");
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(BrowserEngineHosts.IMPORT_ACK_TIMEOUT_MS);
      expect(yield* Fiber.join(pending)).toEqual({ outcome: "unknown" });
    }),
  );

  it.effect("a host disconnect settles an in-flight profile command as unknown", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const { events, fiber } = yield* registerHost(hosts, DESKTOP);
      const pending = yield* Effect.forkChild(
        hosts.dispatchProfile({ _tag: "clearCache", profileId: "default" }),
      );
      yield* Queue.take(events);
      yield* Fiber.interrupt(fiber);
      expect(yield* Fiber.join(pending)).toEqual({ outcome: "unknown" });
      expect(yield* hosts.dispatchProfile({ _tag: "listProfiles" })).toEqual({
        outcome: "no-host",
      });
    }),
  );

  it.effect("a profile answer to a page command is refused, not treated as applied", () =>
    Effect.gen(function* () {
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const target = yield* openClaimable;
      const { hostConnectionId, events } = yield* registerHost(hosts, DESKTOP);
      const pending = yield* Effect.forkChild(
        hosts.dispatch({
          hostConnectionId,
          target,
          engineGeneration: "1",
          command: { _tag: "reload" },
        }),
      );
      const frame = yield* Queue.take(events);
      if (frame.type !== "command") throw new Error("expected a command frame");
      yield* hosts.commandResult(DESKTOP, {
        hostConnectionId,
        commandId: frame.commandId,
        result: { outcome: "declined" },
      });
      expect(yield* Fiber.join(pending)).toEqual({ outcome: "rejected", reason: "failed" });
    }),
  );
});

const DESKTOP_BOOTSTRAP_TOKEN = "desktop-bootstrap-token";

const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.layer(
  Layer.mergeAll(
    BrowserEngineHosts.layer.pipe(Layer.provideMerge(PreviewManager.layer)),
    EnvironmentAuth.layer.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.identityLayer),
      Layer.provide(
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) => ({
            ...config,
            desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN,
          })),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-engine-host-auth-" })),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer)),
)("BrowserEngineHosts session gate", (it) => {
  it.effect("a CLI-issued session with the desktop subject cannot register", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const hosts = yield* BrowserEngineHosts.BrowserEngineHosts;
      const socketFor = (session: EnvironmentAuth.AuthenticatedSession, socketId: string) => ({
        socketId,
        grantMethod: session.grantMethod,
      });

      // `t3 auth session issue --subject desktop-bootstrap` makes this call.
      const cliIssued = yield* auth.issueSession({ subject: "desktop-bootstrap" });
      const cliSession = yield* auth.authenticateHttpRequest(bearerRequest(cliIssued.token));
      expect(cliSession.subject).toBe("desktop-bootstrap");
      expect(yield* reasonOf(hosts.register(socketFor(cliSession, "cli-ws")))).toBe(
        "desktop-required",
      );

      const desktop = yield* auth.exchangeBootstrapCredentialForAccessToken(
        DESKTOP_BOOTSTRAP_TOKEN,
        undefined,
        { deviceType: "desktop" },
      );
      const desktopSession = yield* auth.authenticateHttpRequest(
        bearerRequest(desktop.access_token),
      );
      // The desktop's WebSocket authenticates with a ticket; it reads the same row.
      const sessions = yield* SessionStore.SessionStore;
      const ticket = yield* sessions.issueWebSocketToken(desktopSession.sessionId);
      expect((yield* sessions.verifyWebSocketToken(ticket.token)).grantMethod).toBe(
        "desktop-bootstrap",
      );
      const { hostConnectionId } = yield* registerHost(
        hosts,
        socketFor(desktopSession, "desktop-ws"),
      );
      expect(hostConnectionId).toBeTruthy();
    }),
  );
});
