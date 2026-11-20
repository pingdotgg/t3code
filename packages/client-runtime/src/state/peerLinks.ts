import {
  type EnvironmentId,
  type PeerLinkSummary,
  type PeerLinkThreadInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  followLinkedThread,
  keepLinkedThreadView,
  type LinkedThreadView,
} from "../linkedThread.ts";
import { request, subscribe } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** The environment a client reads through, and the linked environment's thread it reads. */
export interface LinkedThreadViewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PeerLinkThreadInput;
}

const threadViewKey = ({ environmentId, input }: LinkedThreadViewTarget) =>
  JSON.stringify({
    environmentId,
    input: { environmentId: input.environmentId, threadId: input.threadId },
  });

export function createPeerLinkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:list",
    tag: WS_METHODS.peerLinksList,
    // Listing probes every linked environment, so a list stays fresh briefly.
    staleTimeMs: 10_000,
  });
  // Names only, for opening linked threads with thread read access; it probes nothing.
  const names = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:names",
    tag: WS_METHODS.peerLinksNames,
    staleTimeMs: 10_000,
  });
  const refreshLinks = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: {} }));
      registry.refresh(names({ environmentId, input: {} }));
    });
  const threadStream = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:peer-links:thread-stream",
    idleTtlMs: 0,
    subscribe: (input: PeerLinkThreadInput) =>
      followLinkedThread({
        items: subscribe(WS_METHODS.peerLinksSubscribeThread, input),
        historyPage: (cursor) =>
          request(WS_METHODS.peerLinksThreadHistoryPage, { ...input, cursor }),
      }),
  });
  /**
   * What a view of the thread last showed. It outlives the subscription for a while, so coming
   * back to the view shows the thread at once while the stream starts again.
   */
  const lastThreadView = Atom.family((key: string) =>
    Atom.make<LinkedThreadView | null>(null).pipe(
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`environment-data:peer-links:last-thread-view:${key}`),
    ),
  );
  /**
   * A linked environment's thread, streamed while a view reads it. The subscription ends with its
   * last reader, which closes the stream at the linked environment too.
   */
  const threadView = Atom.family((key: string) => {
    const stream = threadStream(JSON.parse(key) as LinkedThreadViewTarget);
    return Atom.make((get) => {
      const live = get(stream);
      if (AsyncResult.isSuccess(live)) {
        const kept = lastThreadView(key);
        get.set(kept, keepLinkedThreadView(get.once(kept), live.value));
      }
      return live;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:peer-links:thread-view:${key}`));
  });
  return {
    list,
    names,
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:link",
      tag: WS_METHODS.peerLinksLink,
      onSuccess: ({ environmentId }, registry) => refreshLinks(registry, environmentId),
    }),
    // Leaves the list alone: a batch refreshes it once, when it ends (`runLinkBatch`).
    linkInBatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:link-in-batch",
      tag: WS_METHODS.peerLinksLink,
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:unlink",
      tag: WS_METHODS.peerLinksUnlink,
      onSuccess: ({ environmentId }, registry) => refreshLinks(registry, environmentId),
    }),
    threadView: (target: LinkedThreadViewTarget) => threadView(threadViewKey(target)),
    lastThreadView: (target: LinkedThreadViewTarget) => lastThreadView(threadViewKey(target)),
    /** One item of a linked environment's thread in full, for a row the reader opened. */
    threadItem: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:peer-links:thread-item",
      tag: WS_METHODS.peerLinksThreadItem,
      idleTtlMs: 0,
    }),
    /** Asks for a one-time pairing with a linked environment. Its answer is a credential: never cached. */
    pairClient: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:pair-client",
      tag: WS_METHODS.peerLinksPairClient,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.environmentId]),
      },
    }),
    // An agent's link card. One answer per card at a time.
    answerRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:answer-request",
      tag: WS_METHODS.peerLinksAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
      onSuccess: ({ environmentId }, registry) => refreshLinks(registry, environmentId),
    }),
  };
}

const EXPIRY_WARNING_DAYS = 5;

export type PeerLinkHealth =
  | { readonly kind: "reachable"; readonly expiresInDays: number | null }
  | { readonly kind: "unreachable"; readonly detail: string | null }
  | { readonly kind: "failing"; readonly detail: string }
  | { readonly kind: "expired" };

/**
 * Listing only checks that the peer answers, so a link whose last call failed
 * (the peer revoked it, say) is `failing` with the recorded reason; the next
 * successful call clears it.
 */
export function peerLinkHealth(link: PeerLinkSummary, now: DateTime.Utc): PeerLinkHealth {
  if (link.status === "expired" || DateTime.isLessThanOrEqualTo(link.expiresAt, now)) {
    return { kind: "expired" };
  }
  if (link.status === "unreachable") return { kind: "unreachable", detail: link.lastError };
  if (link.lastError !== null) return { kind: "failing", detail: link.lastError };
  const days = Math.ceil(Duration.toDays(DateTime.distance(now, link.expiresAt)));
  return { kind: "reachable", expiresInDays: days <= EXPIRY_WARNING_DAYS ? days : null };
}
