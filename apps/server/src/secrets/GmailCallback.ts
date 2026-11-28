import { GMAIL_CALLBACK_PATH } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { ServerConfig } from "../config.ts";

class GmailCallbackUnavailable extends Schema.TaggedError<GmailCallbackUnavailable>()(
  "GmailCallbackUnavailable",
  {},
) {}

export const gmailCallbackSetup =
  "Configure a reachable HTTPS callback for this server, or finish setup on its loopback listener.";

function configuredAddress(server: ServerConfig["Service"]) {
  const host = server.host ?? "127.0.0.1";
  const ip = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // Don't resolve names here: localhost may bind a different family. Use the actual listener.
  return Result.getOrUndefined(NetAddress.inetAddressFromIpString(ip, server.port));
}

function localCallback(bound: NetAddress.InetAddress) {
  if (!bound.port) return undefined;
  const ip = bound.address;
  if (!NetAddress.isLoopback(ip) && !NetAddress.isUnspecified(ip)) return undefined;
  const host = NetAddress.isUnspecified(ip)
    ? NetAddress.isIpv4Address(ip)
      ? "127.0.0.1"
      : "[::1]"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(ip));
  return new URL(GMAIL_CALLBACK_PATH, `http://${host}:${bound.port}`).href;
}

// The desktop renderer and its backend can have different origins. Never advertise a renderer
// port or infer the callback from forwarded request headers. A proxy may advertise its public URI.
export const gmailDefaultRedirectUri = Effect.fnUntraced(function* () {
  const server = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const listener = Option.getOrUndefined(yield* Effect.serviceOption(HttpServer.HttpServer));
  const bound = listener?.address ?? (server && configuredAddress(server));
  const loopback = NetAddress.isInetAddress(bound) ? localCallback(bound) : undefined;
  const configured = Option.getOrUndefined(
    yield* Config.option(Config.String("HYAKKI_GMAIL_REDIRECT_URI")),
  );
  if (configured === undefined || configured === loopback) {
    if (loopback) return loopback;
  } else if (configured.length <= 2048) {
    const url = URL.parse(configured);
    if (url?.protocol === "https:" && configured === `${url.origin}${GMAIL_CALLBACK_PATH}`) {
      return configured;
    }
  }
  return yield* new GmailCallbackUnavailable();
});
