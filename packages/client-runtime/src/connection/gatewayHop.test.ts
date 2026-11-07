import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as GatewayHop from "./gatewayHop.ts";
import { RelayConnectionTarget, type PreparedConnection } from "./model.ts";

const GATEWAY_ID = EnvironmentId.make("env_gateway");
const TARGET = new RelayConnectionTarget({ environmentId: GATEWAY_ID, label: "Gateway" });
const PREPARED: PreparedConnection = {
  environmentId: GATEWAY_ID,
  label: "Gateway",
  httpBaseUrl: "https://previous.example.test/",
  socketUrl: "wss://previous.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "stale-token", expiresAtEpochMs: 0 },
  target: TARGET,
};

describe("GatewayHopAuthorization", () => {
  it.effect(
    "mints a DPoP ticket with the renewed token and endpoint, not the prepared ones",
    () => {
      const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      const proofTokens: Array<string | undefined> = [];
      const layer = GatewayHop.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            RpcHttp.layerRemoteHttpClient(async (input, init) => {
              requests.push({
                url: String(input),
                authorization: new Headers(init?.headers).get("authorization"),
              });
              return Response.json({ ticket: "hop", expiresAt: "2026-05-01T12:05:00.000Z" });
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
              authorizeDpopHttp: () =>
                Effect.succeed({
                  environmentId: GATEWAY_ID,
                  label: "Gateway",
                  httpBaseUrl: "https://current.example.test/",
                  httpAuthorization: {
                    _tag: "Dpop",
                    accessToken: "current-token",
                    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                  },
                }),
            }),
            Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({
              createProof: ({ accessToken }) =>
                Effect.sync(() => {
                  proofTokens.push(accessToken);
                  return "proof";
                }),
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const hop = yield* GatewayHop.GatewayHopAuthorization;
        yield* hop.remember(GATEWAY_ID, Option.some(PREPARED));

        expect(yield* hop.issueTicket(GATEWAY_ID)).toEqual(Option.some("hop"));
        expect(requests).toEqual([
          {
            url: "https://current.example.test/api/auth/websocket-ticket/media",
            authorization: "DPoP current-token",
          },
        ]);
        expect(proofTokens).toEqual(["current-token"]);
      }).pipe(Effect.provide(layer));
    },
  );
});
