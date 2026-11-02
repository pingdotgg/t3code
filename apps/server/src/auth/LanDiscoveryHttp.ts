import { LanDiscoveryChallenge } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as LanDiscoveryProof from "./LanDiscoveryProof.ts";

const isLanDiscoveryChallenge = Schema.is(LanDiscoveryChallenge);

const headers = { "cache-control": "no-store" };
const rejected = HttpServerResponse.empty({ status: 400, headers });
const maxBodyBytes = 8192;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const limit = yield* Ref.make({ since: 0, count: 0 });
    const discovery = yield* LanDiscoveryProof.LanDiscoveryProof;
    return HttpRouter.add(
      "POST",
      "/api/lan-discovery/proof",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const allowed = yield* Ref.modify(limit, (previous) => {
          const current = now - previous.since >= 10_000 ? { since: now, count: 0 } : previous;
          return [current.count < 120, { ...current, count: current.count + 1 }] as const;
        });
        if (!allowed) return rejected;
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Number(request.headers["content-length"] ?? "0") > maxBodyBytes) return rejected;
        const input = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBodyBytes)),
          Effect.option,
        );
        if (Option.isNone(input) || !isLanDiscoveryChallenge(input.value)) return rejected;
        const { payload, nonce } = input.value;
        const socket = NodeHttpServerRequest.toIncomingMessage(request).socket;
        if (socket?.localAddress === undefined || socket.localPort === undefined) return rejected;
        const proof = yield* discovery
          .prove({ payload, nonce, address: socket.localAddress, port: socket.localPort })
          .pipe(Effect.option);
        return Option.isSome(proof)
          ? HttpServerResponse.jsonUnsafe({ proof: proof.value }, { headers })
          : rejected;
      }),
    );
  }),
);
