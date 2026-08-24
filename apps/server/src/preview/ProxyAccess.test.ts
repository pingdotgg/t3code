import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "./PortScanner.ts";
import {
  issueProxyTicket,
  PREVIEW_PROXY_ENTRY_PREFIX,
  redeemEntryTicket,
  verifySessionCookie,
} from "./ProxyAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-preview-proxy-test-",
});

const environmentService = (id: string) =>
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
    getDescriptor: Effect.die("unused"),
  });

const discoveredServer = {
  host: "127.0.0.1",
  port: 5173,
  url: "http://127.0.0.1:5173/",
  processName: null,
  pid: null,
  terminal: null,
};

const portDiscoveryLayer = Layer.succeed(
  PortScanner.PortDiscovery,
  PortScanner.PortDiscovery.of({
    scan: () => Effect.succeed([discoveredServer]),
    subscribe: () => Effect.void,
    retain: Effect.void,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  }),
);

const testLayer = Layer.mergeAll(
  Layer.succeed(ServerEnvironment.ServerEnvironment, environmentService("environment-proxy-test")),
  portDiscoveryLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  TestClock.layer(),
).pipe(Layer.provideMerge(NodeServices.layer));

const entryToken = (entryPath: string) => entryPath.slice(`${PREVIEW_PROXY_ENTRY_PREFIX}/`.length);

describe("PreviewProxyAccess", () => {
  it.effect("rejects malformed, non-loopback, and undiscovered targets", () =>
    Effect.gen(function* () {
      expect(yield* issueProxyTicket({ url: "not a url" }).pipe(Effect.flip)).toMatchObject({
        reason: "invalid-url",
      });
      expect(
        yield* issueProxyTicket({ url: "https://127.0.0.1:5173/" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-url" });
      expect(
        yield* issueProxyTicket({ url: "http://example.com:5173/" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-local" });
      expect(
        yield* issueProxyTicket({ url: "http://127.0.0.1:9999/" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "not-discovered" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues tickets that redeem once into a verifiable session cookie", () =>
    Effect.gen(function* () {
      const ticket = yield* issueProxyTicket({ url: "http://127.0.0.1:5173/" });
      expect(ticket.entryPath.startsWith(`${PREVIEW_PROXY_ENTRY_PREFIX}/`)).toBe(true);

      const redemption = yield* redeemEntryTicket(entryToken(ticket.entryPath));
      expect(redemption.ok).toBe(true);
      if (!redemption.ok) return;
      expect(redemption.claims).toMatchObject({ host: "127.0.0.1", port: 5173 });

      const claims = yield* verifySessionCookie(redemption.cookieValue);
      expect(claims).toMatchObject({ kind: "session", host: "127.0.0.1", port: 5173 });

      // Second redemption of the same entry ticket fails.
      expect(yield* redeemEntryTicket(entryToken(ticket.entryPath))).toEqual({
        ok: false,
        reason: "reused",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired entry tickets and expired session cookies", () =>
    Effect.gen(function* () {
      const ticket = yield* issueProxyTicket({ url: "http://127.0.0.1:5173/" });
      yield* TestClock.adjust(Duration.minutes(3));
      expect(yield* redeemEntryTicket(entryToken(ticket.entryPath))).toEqual({
        ok: false,
        reason: "expired",
      });

      const freshTicket = yield* issueProxyTicket({ url: "http://127.0.0.1:5173/" });
      const redemption = yield* redeemEntryTicket(entryToken(freshTicket.entryPath));
      expect(redemption.ok).toBe(true);
      if (!redemption.ok) return;
      yield* TestClock.adjust(Duration.hours(13));
      expect(yield* verifySessionCookie(redemption.cookieValue)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered tokens and tickets from another environment", () =>
    Effect.gen(function* () {
      const ticket = yield* issueProxyTicket({ url: "http://127.0.0.1:5173/" });
      const token = entryToken(ticket.entryPath);

      expect(yield* redeemEntryTicket(`${token}tampered`)).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(yield* redeemEntryTicket("garbage")).toEqual({ ok: false, reason: "malformed" });

      // Same signing key, different environment id: explicit cross-environment rejection.
      expect(
        yield* redeemEntryTicket(token).pipe(
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            environmentService("environment-someone-else"),
          ),
        ),
      ).toEqual({ ok: false, reason: "cross-environment" });

      // The genuine environment can still redeem it afterwards.
      expect((yield* redeemEntryTicket(token)).ok).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
