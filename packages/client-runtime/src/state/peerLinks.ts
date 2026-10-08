import {
  type OrchestrationV2ThreadShell,
  type PeerLinkSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Links to other environments, kept by one environment's server. */
export function createPeerLinkEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peer-links:list",
    tag: WS_METHODS.peerLinksList,
    // Listing probes every linked environment, so a list stays fresh briefly.
    staleTimeMs: 10_000,
  });
  return {
    list,
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:link",
      tag: WS_METHODS.peerLinksLink,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peer-links:unlink",
      tag: WS_METHODS.peerLinksUnlink,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
  };
}

/** Moving threads to linked environments, as one environment's server does it. */
export function createThreadHandoffEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    options: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-handoff:options",
      tag: WS_METHODS.threadHandoffOptions,
      // Each read probes every linked environment for a matching project.
      staleTimeMs: 15_000,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-handoff:start",
      tag: WS_METHODS.threadHandoffStart,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-handoff:cancel",
      tag: WS_METHODS.threadHandoffCancel,
    }),
  };
}

/** What a thread's banner says about its move, or nothing when there is none to show. */
export function threadHandoffNotice(
  handoff: NonNullable<OrchestrationV2ThreadShell["handoff"]> | null | undefined,
): {
  readonly tone: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string | null;
} | null {
  if (handoff === null || handoff === undefined) return null;
  switch (handoff.state) {
    case "pending":
      return {
        tone: "info",
        title: `Moving to ${handoff.label} when this turn ends`,
        detail: "Send a message to keep it here instead.",
      };
    case "departing":
      return { tone: "info", title: `Moving to ${handoff.label}…`, detail: null };
    case "departed":
      return {
        tone: "info",
        title: `This thread continues on ${handoff.label}`,
        detail: "This copy is read-only.",
      };
    case "failed":
      return {
        tone: "error",
        title: `Could not move to ${handoff.label}`,
        detail: handoff.lastError,
      };
  }
}

/** Links expire after 30 days and cannot be renewed yet, so warn this long before. */
const EXPIRY_WARNING_DAYS = 5;

export type PeerLinkHealth =
  | { readonly kind: "reachable"; readonly expiresInDays: number | null }
  | { readonly kind: "unreachable"; readonly detail: string | null }
  | { readonly kind: "failing"; readonly detail: string }
  | { readonly kind: "expired" };

/**
 * What a link's row says about it. `expiresInDays` is set only inside the
 * warning window, while the link still works but has to be renewed soon.
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
