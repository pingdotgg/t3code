import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type * as PeerEnvironmentRegistry from "./PeerEnvironmentRegistry.ts";
import type * as PeerLinks from "./PeerLinks.ts";

/** Where a peer answer will come from, so a 401 can name the right recovery. */
export interface ResolvedPeerSession {
  readonly url: string;
  readonly token: string;
  readonly from: "link" | "registry";
}

/**
 * The credential a peer answers with: its ordinary link first, else the fleet
 * delegation session it was paired with. Both spellings reach the peer's
 * `/mcp` and `/api`; only an `unknown_link` falls through, so an expired or
 * unreachable link is reported instead of silently using another credential.
 */
export const resolvePeerSession = (deps: {
  readonly links: PeerLinks.PeerLinks["Service"];
  readonly registry: Option.Option<PeerEnvironmentRegistry.PeerEnvironmentRegistry["Service"]>;
}) =>
  Effect.fn("resolvePeerSession")(function* (environmentId: EnvironmentId) {
    const fromLink = yield* Effect.result(deps.links.resolve(environmentId));
    if (Result.isSuccess(fromLink)) {
      return {
        url: fromLink.success.url,
        token: fromLink.success.token,
        from: "link",
      } satisfies ResolvedPeerSession;
    }
    if (Option.isNone(deps.registry) || fromLink.failure.reason !== "unknown_link") {
      return yield* Effect.fail({
        _tag: "link" as const,
        error: fromLink.failure,
      });
    }
    const session = yield* deps.registry.value
      .resolveSession(environmentId)
      .pipe(Effect.mapError((error) => ({ _tag: "registry" as const, error })));
    return {
      url: session.url,
      token: session.token,
      from: "registry",
    } satisfies ResolvedPeerSession;
  });
