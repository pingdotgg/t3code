import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BearerConnectionTarget } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { resolveTcpPortForwardSocketUrl } from "./portForward.ts";

describe("TCP port forward authorization", () => {
  it.effect("issues a destination-bound bearer ticket and returns the bridge URL", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((input, init) => {
        calls.push([input, init ?? {}]);
        return Promise.resolve(
          Response.json({
            ticket: "single-use-ticket",
            expiresAt: "2026-08-12T12:00:30.000Z",
          }),
        );
      }) satisfies typeof fetch;
      const environmentId = EnvironmentId.make("environment-a");

      const socketUrl = yield* resolveTcpPortForwardSocketUrl({
        prepared: {
          environmentId,
          label: "Remote",
          httpBaseUrl: "https://remote.example.com/base",
          socketUrl: "wss://remote.example.com/ws?wsTicket=control-ticket",
          httpAuthorization: { _tag: "Bearer", token: "access-token" },
          target: new BearerConnectionTarget({
            environmentId,
            label: "Remote",
            connectionId: "remote-a",
          }),
        },
        signer: Option.none(),
        remoteHost: "127.0.0.1",
        remotePort: 4321,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(socketUrl).toBe("wss://remote.example.com/ws/tcp-forward?ticket=single-use-ticket");
      expect(String(calls[0]?.[0])).toBe("https://remote.example.com/api/auth/tcp-forward-ticket");
      expect(calls[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer access-token" }),
        }),
      );
      const body = calls[0]?.[1].body;
      expect(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)).toBe(
        '{"remoteHost":"127.0.0.1","remotePort":4321}',
      );
    }),
  );
});
