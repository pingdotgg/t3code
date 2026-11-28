import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { ServerConfig } from "../config.ts";
import { gmailDefaultRedirectUri } from "./GmailCallback.ts";

const local = "http://127.0.0.1:3773/oauth/gmail/callback";
const remote = "https://work.example.test/oauth/gmail/callback";

const callback = (host?: string, configured?: string) =>
  gmailDefaultRedirectUri().pipe(
    Effect.provideService(ServerConfig, { host, port: 3773 } as ServerConfig["Service"]),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(
          configured === undefined ? {} : { HYAKKI_GMAIL_REDIRECT_URI: configured },
        ),
      ),
    ),
  );

it.effect("uses only a loopback address the listener can serve", () =>
  Effect.gen(function* () {
    for (const [host, expected] of [
      [undefined, local],
      ["0.0.0.0", local],
      ["127.0.0.9", local.replace("127.0.0.1", "127.0.0.9")],
      ["::1", local.replace("127.0.0.1", "[::1]")],
      ["::", local.replace("127.0.0.1", "[::1]")],
    ] as const) {
      expect(yield* callback(host)).toBe(expected);
    }
    const localhost = callback("localhost").pipe(
      Effect.provide(
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("::1", 4773),
        }),
      ),
    );
    expect(yield* localhost).toBe("http://[::1]:4773/oauth/gmail/callback");
  }),
);

it.effect("requires explicit HTTPS for a LAN-only or unresolved hostname bind", () =>
  Effect.gen(function* () {
    for (const host of ["192.168.1.5", "2001:db8::1", "listener.example.test"]) {
      expect(yield* Effect.isFailure(callback(host))).toBe(true);
      expect(yield* Effect.isFailure(callback(host, local))).toBe(true);
      expect(yield* callback(host, remote)).toBe(remote);
    }
  }),
);

it.effect(
  "accepts only canonical host overrides; invalid overrides do not fall back to loopback",
  () =>
    Effect.gen(function* () {
      expect(yield* callback(undefined, local)).toBe(local);
      expect(yield* callback(undefined, "")).toBe(local);
      for (const uri of [
        " ",
        local.replace(":3773", ":3774"),
        local.replace("127.0.0.1", "127.1"),
        local.replace("127.0.0.1", "work.example.test"),
        remote + "?",
        remote + "#",
        remote + "/",
        remote.replace("work.", "user@work."),
        remote.replace("/oauth/", "/other/../oauth/"),
      ]) {
        expect(yield* Effect.isFailure(callback(undefined, uri))).toBe(true);
      }
    }),
);
