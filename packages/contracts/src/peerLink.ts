import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import {
  EnvironmentId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  OrchestratorMcpThreadStatus,
  OrchestratorMcpThreadTimelineItem,
} from "./orchestratorMcp.ts";

/**
 * A link from this environment to another one (the peer). This environment
 * signed in to the peer's `/mcp` as an outside agent, with a pairing code from
 * the peer, so its agents can work there. The peer enforces the access chosen
 * at linking, and revokes the link from its own Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/** Whether a link can be used now, as worked out when it is listed. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

/**
 * A link's name only, for a client that may read threads here but not manage access: enough to
 * name and open a linked environment's threads, without its addresses, access or health.
 */
export const PeerLinkName = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type PeerLinkName = typeof PeerLinkName.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`t3 pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  /**
   * The environment the user means. Addresses that answer as another one are
   * skipped, and only those that answer as this one are kept.
   */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** What the user calls that environment, to name it when it cannot be reached. */
  expectedLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
    "disabled",
  ]),
  message: Schema.String,
  /** The environment that answered at the addresses of the one the user picked, when one did. */
  answeredAs: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** What went wrong with one link, as a batch reports it per machine. */
export type PeerLinkFailureKind = "unreachable" | "code_refused" | "wrong_environment" | "other";

export const peerLinkFailureKind = (
  error: Pick<PeerLinkError, "reason" | "answeredAs">,
): PeerLinkFailureKind =>
  error.answeredAs !== undefined
    ? "wrong_environment"
    : error.reason === "unreachable" || error.reason === "not_a_t3_environment"
      ? "unreachable"
      : error.reason === "pairing_rejected"
        ? "code_refused"
        : "other";

/**
 * A page of a linked environment's thread, read for a client of this environment over the link.
 * No cursor reads the newest page; `beforePosition` pages back and `afterPosition` reads what
 * came after, which is also how an open view refreshes.
 */
export const PeerLinkThreadReadInput = Schema.Struct({
  /** The linked environment the thread lives in. */
  environmentId: EnvironmentId,
  threadId: ThreadId,
  beforePosition: Schema.optionalKey(NonNegativeInt),
  afterPosition: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
});
export type PeerLinkThreadReadInput = typeof PeerLinkThreadReadInput.Type;

export const PeerLinkThreadPage = Schema.Struct({
  /** What this environment calls the linked one. */
  label: Schema.String,
  thread: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
    status: OrchestratorMcpThreadStatus,
    model: Schema.String,
  }),
  /** Oldest first. Each page is bounded in items and in bytes. */
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  /** Pass as `beforePosition` for the page before this one; null at the thread's start. */
  earlierPosition: Schema.NullOr(NonNegativeInt),
  /** More items follow this page already, so the next read need not wait. */
  hasMore: Schema.Boolean,
});
export type PeerLinkThreadPage = typeof PeerLinkThreadPage.Type;

/** Why a linked environment's thread could not be read, with the reason in words. */
export class PeerLinkThreadReadError extends Schema.TaggedError<PeerLinkThreadReadError>()(
  "PeerLinkThreadReadError",
  {
    reason: Schema.Literals([
      /** Linked environments is off here. */
      "disabled",
      "unknown_link",
      "expired",
      /** The linked environment no longer accepts the link, or refuses the read. */
      "rejected",
      "unreachable",
      "thread_not_found",
      /** The linked environment runs a version that cannot page a thread backwards. */
      "incompatible",
    ]),
    /** What this environment calls the linked one, when it still has the link. */
    label: Schema.NullOr(Schema.String),
    message: Schema.String,
    /** The failure underneath, when the read got as far as the link or the linked environment. */
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome and the access the user chose.
 */
export const PeerLinkRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("link"),
      /** The machine the user picked, when they picked one rather than typing an address. */
      environmentId: Schema.optionalKey(EnvironmentId),
      /** What the client calls that machine. */
      label: Schema.optionalKey(TrimmedNonEmptyString),
      /** The addresses the client knows for that machine, most preferred first. */
      urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
      access: AuthMcpClientAccess,
      pairingCode: TrimmedNonEmptyString,
    }),
    /** Answers with a machine this environment is already linked to, as it is. */
    Schema.Struct({ type: Schema.Literal("use-existing"), environmentId: EnvironmentId }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type PeerLinkRequestAnswerInput = typeof PeerLinkRequestAnswerInput.Type;

const PEER_LINK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
} as const;

export const PeerLinkRequestFailureReason = Schema.Literals(
  Object.keys(PEER_LINK_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof PEER_LINK_REQUEST_FAILURE_MESSAGES
  >,
);
export type PeerLinkRequestFailureReason = typeof PeerLinkRequestFailureReason.Type;

/**
 * Answering a link request failed before anything was linked. A link the
 * other environment refused is not this error: the card records it as failed.
 */
export class PeerLinkRequestError extends Schema.TaggedError<PeerLinkRequestError>()(
  "PeerLinkRequestError",
  {
    reason: PeerLinkRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return PEER_LINK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
