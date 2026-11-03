// Trust relay headers only with a mint-key-signed proof; otherwise handle the webhook as a direct request.
import { RelayHookDeliveryProofPayload } from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** Covers the relay's 24-hour hold plus a margin. */
const MAX_PROOF_AGE_SECONDS = 25 * 60 * 60;

const decodePayload = Schema.decodeUnknownOption(RelayHookDeliveryProofPayload);
const text = (bytes: Option.Option<Uint8Array>) =>
  Option.map(bytes, (value) => new TextDecoder().decode(value));

export class RelayDeliveryProof extends Context.Service<
  RelayDeliveryProof,
  {
    readonly verify: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly hookId: string;
    }) => Effect.Effect<
      Option.Option<{ readonly deliveryId: string; readonly receivedAt: string }>
    >;
  }
>()("t3/scheduledTasks/RelayDeliveryProof") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const verify: RelayDeliveryProof["Service"]["verify"] = Effect.fn("webhook.verifyRelayDelivery")(
    function* (input) {
      const proof = input.headers[RELAY_HOOK_DELIVERY_HEADER];
      const deliveryId = input.headers["x-t3-relay-delivery-id"];
      const receivedAt = input.headers["x-t3-relay-received-at"];
      if (proof === undefined || deliveryId === undefined || receivedAt === undefined) {
        return Option.none();
      }
      const publicKey = text(yield* secrets.get(CLOUD_MINT_PUBLIC_KEY));
      const issuer = Option.orElse(text(yield* secrets.get(RELAY_ISSUER_SECRET)), () =>
        Option.none<string>(),
      );
      const relayUrl = text(yield* secrets.get(RELAY_URL_SECRET));
      const relayIssuer = Option.isSome(issuer) ? issuer : relayUrl;
      if (Option.isNone(publicKey) || Option.isNone(relayIssuer)) return Option.none();
      const environmentId = yield* environment.getEnvironmentId;
      const payload = yield* verifyRelayJwt({
        publicKey: publicKey.value,
        token: proof,
        typ: RELAY_HOOK_DELIVERY_TYP,
        issuer: normalizeRelayIssuer(relayIssuer.value),
        audience: `t3-env:${environmentId}`,
        nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
        maxTokenAge: MAX_PROOF_AGE_SECONDS,
      }).pipe(Effect.map(decodePayload), Effect.orElseSucceed(Option.none));
      // The proof must name exactly this delivery, so it cannot be lifted onto another one.
      if (
        Option.isNone(payload) ||
        payload.value.environmentId !== environmentId ||
        payload.value.deliveryId !== deliveryId ||
        payload.value.receivedAt !== receivedAt ||
        payload.value.hookId !== input.hookId
      ) {
        return Option.none();
      }
      return Option.some({ deliveryId, receivedAt });
    },
    Effect.orElseSucceed(Option.none),
  );
  return RelayDeliveryProof.of({ verify });
});

export const layer = Layer.effect(RelayDeliveryProof, make);
