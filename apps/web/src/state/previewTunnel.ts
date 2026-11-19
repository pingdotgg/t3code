import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { mintMediaTicket } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const PREVIEW_TUNNEL_PATH = "/api/preview/tunnel";
const TICKET_REFRESH_MARGIN_MS = 30_000;

// Reading the prepared connection here re-mints for the route in use after a route switch.
const previewTunnelAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      // Desktop main cannot send this window's cookies, so only ticketed connections tunnel.
      if (prepared === null || prepared.httpAuthorization === null) return Effect.succeed(null);
      return mintMediaTicket(prepared).pipe(
        Effect.map((ticket) => {
          const url = new URL(
            environmentEndpointUrl(prepared.httpBaseUrl, PREVIEW_TUNNEL_PATH).replace(
              /^http/,
              "ws",
            ),
          );
          url.searchParams.set("wsTicket", Redacted.value(ticket.ticket));
          return { url: url.toString(), expiresAtMillis: DateTime.toEpochMillis(ticket.expiresAt) };
        }),
      );
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`preview-tunnel-access:${environmentId}`)),
);

/** The environment's tunnel WebSocket URL with a live media ticket, or null when unreachable. */
export function readPreviewTunnelUrl(environmentId: EnvironmentId): Promise<string | null> {
  const atom = previewTunnelAccessAtom(environmentId);
  const current = appAtomRegistry.get(atom);
  const reusable =
    AsyncResult.isSuccess(current) &&
    current.value !== null &&
    current.value.expiresAtMillis - Date.now() > TICKET_REFRESH_MARGIN_MS;
  if (!reusable && !current.waiting) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.map((access) => access?.url ?? null),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
