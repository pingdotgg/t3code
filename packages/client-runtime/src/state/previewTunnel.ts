import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { mintMediaTicket } from "./deviceHubAccess.ts";
import { socketProofUrl } from "./environmentSocket.ts";

const TICKET_REFRESH_MARGIN_MS = 30_000;

/**
 * Reads an environment's loopback tunnel URL (`/api/preview/tunnel` with a media ticket) for a
 * native webview proxy. Tickets are reused until shortly before they expire, and reading the
 * prepared connection re-mints for the route in use after a route switch. A DPoP ticket's URL
 * carries a fresh single-use proof each read, since the proxy asks once per connection.
 */
export function createPreviewTunnelUrlReader<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<HttpClient.HttpClient | R, E>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
}) {
  const accessAtom = Atom.family((environmentId: EnvironmentId) =>
    input.runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(input.preparedConnectionAtom(environmentId)));
        // Mid-reconnect, wait for the connection rather than refuse the page; the read times out.
        if (prepared === null) return Effect.never;
        // The proxy cannot send cookies, so only ticketed connections tunnel.
        if (prepared.httpAuthorization === null) return Effect.succeed(null);
        return Effect.gen(function* () {
          const ticket = yield* mintMediaTicket(prepared);
          const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
          const url = new URL(
            environmentEndpointUrl(prepared.httpBaseUrl, "/api/preview/tunnel").replace(
              /^http/,
              "ws",
            ),
          );
          const accessToken = Redacted.value(ticket.ticket);
          url.searchParams.set("wsTicket", accessToken);
          // A DPoP ticket opens a socket only with a proof of its own, and the proxy cannot sign.
          const prove =
            prepared.httpAuthorization?._tag !== "Dpop" || Option.isNone(signer)
              ? undefined
              : signer.value.createProof({
                  method: "GET",
                  url: socketProofUrl(url),
                  accessToken,
                });
          return {
            url: url.toString(),
            expiresAtMillis: DateTime.toEpochMillis(ticket.expiresAt),
            prove,
          };
        });
      })
      .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`preview-tunnel-access:${environmentId}`)),
  );

  return (environmentId: EnvironmentId): Promise<string | null> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const atom = accessAtom(environmentId);
        const current = input.registry.get(atom);
        const now = yield* Clock.currentTimeMillis;
        const reusable =
          AsyncResult.isSuccess(current) &&
          current.value !== null &&
          current.value.expiresAtMillis - now > TICKET_REFRESH_MARGIN_MS;
        if (!reusable && !current.waiting) input.registry.refresh(atom);
        const access = yield* AtomRegistry.getResult(input.registry, atom, {
          suspendOnWaiting: true,
        });
        if (!access) return null;
        if (access.prove === undefined) return access.url;
        const url = new URL(access.url);
        url.searchParams.set("dpop", yield* access.prove);
        return url.toString();
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => null),
      ),
    );
}
