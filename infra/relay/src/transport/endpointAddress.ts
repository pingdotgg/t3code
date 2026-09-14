import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

import { managedEndpointDigestInput } from "../deploymentConfig.ts";
import { type RelayEndpointAddress, relayRouteKey, relayUserDigestInput } from "./routing.ts";

/**
 * Derives the opaque hub and endpoint keys for one linked environment. The
 * endpoint key reuses the managed endpoint digest so it stays stable for an
 * environment that moves between Cloudflare Tunnel and T3 relay.
 */
export const relayEndpointAddress = (
  crypto: Crypto.Crypto,
  input: {
    readonly namespace: string;
    readonly userId: string;
    readonly environmentId: string;
  },
) =>
  Effect.gen(function* () {
    const sha256Hex = (value: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(value))
        .pipe(Effect.map(Encoding.encodeHex));
    const environmentHash = yield* sha256Hex(
      managedEndpointDigestInput(input.namespace, input.userId, input.environmentId),
    );
    const userHash = yield* sha256Hex(relayUserDigestInput(input.namespace, input.userId));
    return {
      userKey: relayRouteKey(userHash),
      endpointKey: relayRouteKey(environmentHash),
    } satisfies RelayEndpointAddress;
  });
