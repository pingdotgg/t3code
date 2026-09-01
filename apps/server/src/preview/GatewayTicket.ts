import { PortSchema } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SIGNING_SECRET_NAME = "preview-gateway-signing-key";
const TICKET_TTL_MS = 5 * 60_000;

const TicketClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("preview-gateway"),
  port: PortSchema,
  expiresAt: Schema.Number,
});

const TicketClaimsJson = Schema.fromJsonString(TicketClaims);
const decodeClaims = Schema.decodeUnknownOption(TicketClaimsJson);
const encodeClaims = Schema.encodeSync(TicketClaimsJson);

const decodeTicketClaims = (payload: string): Option.Option<typeof TicketClaims.Type> => {
  try {
    return decodeClaims(base64UrlDecodeUtf8(payload));
  } catch {
    return Option.none();
  }
};

const loadSigningSecret = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issuePreviewGatewayTicket = Effect.fn("PreviewGatewayTicket.issue")(function* (
  port: number,
) {
  const secret = yield* loadSigningSecret;
  const expiresAt = (yield* Clock.currentTimeMillis) + TICKET_TTL_MS;
  const payload = base64UrlEncode(
    encodeClaims({ version: 1, kind: "preview-gateway", port, expiresAt }),
  );
  return {
    ticket: `${payload}.${signPayload(payload, secret)}`,
    expiresAt: DateTime.makeUnsafe(expiresAt),
    port,
  };
});

export const validatePreviewGatewayTicket = Effect.fn("PreviewGatewayTicket.validate")(function* (
  ticket: string,
) {
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra) return null;
  const secret = yield* loadSigningSecret;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;
  const claims = decodeTicketClaims(payload);
  if (Option.isNone(claims) || claims.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return null;
  }
  return claims.value;
});
