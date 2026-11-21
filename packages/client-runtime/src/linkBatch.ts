import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkCreateInput,
  type PeerLinkFailureKind,
  type PeerLinkSummary,
  peerLinkFailureKind,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { LinkableMachine } from "./linkRequest.ts";

/** Pairings a batch opens at once, so a fleet is not signed in to all at the same moment. */
const LINK_BATCH_CONCURRENCY = 4;

/**
 * Why a batch cannot link a machine: the client mints each pairing code there
 * with its own session, and sends it only to addresses it already has for it.
 */
export type LinkBatchBlock =
  | "links_unknown"
  | "linked"
  | "not_connected"
  | "no_access"
  | "no_address";

/** Whether the linking environment's own links are known yet. */
export type LinkListState = "loading" | "failed" | "loaded";

export const linkListState = (query: {
  readonly data: unknown;
  readonly error: unknown;
}): LinkListState => (query.data !== null ? "loaded" : query.error !== null ? "failed" : "loading");

export interface LinkBatchCandidate {
  readonly machine: LinkableMachine;
  readonly blocked: LinkBatchBlock | null;
}

/**
 * `writable` holds the machines where this client's session may create pairing codes.
 * Until `links` has loaded, no machine's `linked` is known, and linking one that is
 * already linked would replace its working token, so none is offered.
 */
export const linkBatchCandidates = (
  machines: ReadonlyArray<LinkableMachine>,
  writable: ReadonlySet<EnvironmentId>,
  links: LinkListState,
): ReadonlyArray<LinkBatchCandidate> =>
  machines.map((machine) => ({
    machine,
    blocked:
      links !== "loaded"
        ? "links_unknown"
        : machine.linked
          ? "linked"
          : !machine.connected
            ? "not_connected"
            : !writable.has(machine.environmentId)
              ? "no_access"
              : machine.urls.length === 0
                ? "no_address"
                : null,
  }));

export const linkBatchBlockLabel = (
  blocked: LinkBatchBlock,
  resolve: MFunctionType = mFallback,
): string => {
  switch (blocked) {
    case "links_unknown":
      return resolve(msg("Not known yet whether it is linked"));
    case "linked":
      return resolve(msg("Already linked"));
    case "not_connected":
      return resolve(msg("This app is not connected to it"));
    case "no_access":
      return resolve(msg("Your session there cannot create pairing codes"));
    case "no_address":
      return resolve(msg("No address another machine can reach"));
  }
};

/** Why the link back, from the linked machine to the linking one, is not offered. */
export type LinkBackBlock =
  | "target_links_off"
  | "target_no_access"
  | "source_no_access"
  | "source_no_address";

/**
 * `hidden`: the user would not expect it, so nothing is shown. `blocked`: both machines are
 * the user's own connected environments, so one line says what is in the way.
 */
export type LinkBackOffer =
  | { readonly kind: "offered" }
  | { readonly kind: "blocked"; readonly reason: LinkBackBlock }
  | { readonly kind: "hidden" };

/**
 * Whether linking `source` to `target` can also link `target` back with no pasted code. The
 * reverse is an ordinary link made on the target: the client creates it there and mints its
 * pairing code on the source, each with its own session, at an address it has for the source.
 */
export const linkBackOffer = (input: {
  /** Null for a machine the client has not saved, such as a typed address. */
  readonly target: {
    readonly connected: boolean;
    /** Linked environments is supported and switched on there. */
    readonly offersLinks: boolean;
    /** The client's session there may create links: `access:write`. */
    readonly writable: boolean;
    /** Its own links: null until they are known. */
    readonly links: ReadonlyArray<Pick<PeerLinkSummary, "environmentId" | "status">> | null;
  } | null;
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly connected: boolean;
    /** The client's session there may create pairing codes: `access:write`. */
    readonly writable: boolean;
    readonly urls: ReadonlyArray<string>;
  };
}): LinkBackOffer => {
  const { target, source } = input;
  if (target === null || !target.connected || !source.connected) return { kind: "hidden" };
  if (!target.offersLinks) return { kind: "blocked", reason: "target_links_off" };
  if (!target.writable) return { kind: "blocked", reason: "target_no_access" };
  if (!source.writable) return { kind: "blocked", reason: "source_no_access" };
  if (source.urls.length === 0) return { kind: "blocked", reason: "source_no_address" };
  // Unknown or already there: offering it could replace a working token.
  if (
    target.links === null ||
    target.links.some(
      (link) => link.environmentId === source.environmentId && link.status !== "expired",
    )
  ) {
    return { kind: "hidden" };
  }
  return { kind: "offered" };
};

export const linkBackBlockLabel = (
  blocked: LinkBackBlock,
  names: { readonly source: string; readonly target: string },
  resolve: MFunctionType = mFallback,
): string => {
  switch (blocked) {
    case "target_links_off":
      return resolve(
        msg("{target} cannot link back: Linked environments is off there.", {
          target: names.target,
        }),
      );
    case "target_no_access":
      return resolve(
        msg("{target} cannot link back: your session there cannot create links.", {
          target: names.target,
        }),
      );
    case "source_no_access":
      return resolve(
        msg("{target} cannot link back: your session on {source} cannot create pairing codes.", {
          source: names.source,
          target: names.target,
        }),
      );
    case "source_no_address":
      return resolve(
        msg("{target} cannot link back: this app has no address for {source} it can reach.", {
          source: names.source,
          target: names.target,
        }),
      );
  }
};

export type LinkBatchFailure = PeerLinkFailureKind | "no_code";

export type LinkAttemptOutcome =
  | { readonly kind: "linked" }
  | { readonly kind: "failed"; readonly failure: LinkBatchFailure; readonly detail: string | null };

/** `back` is set when the link back was asked for: it never changes how the link itself went. */
export type LinkBatchOutcome =
  | { readonly kind: "linked"; readonly back?: LinkAttemptOutcome }
  | { readonly kind: "failed"; readonly failure: LinkBatchFailure; readonly detail: string | null };

export const linkBatchFailureLabel = (
  failure: LinkBatchFailure,
  resolve: MFunctionType = mFallback,
): string => {
  switch (failure) {
    case "unreachable":
      return resolve(msg("Unreachable"));
    case "code_refused":
      return resolve(msg("Pairing code refused"));
    case "wrong_environment":
      return resolve(msg("Another environment answered"));
    case "no_code":
      return resolve(msg("Could not get a pairing code there"));
    case "other":
      return resolve(msg("Could not link"));
  }
};

/**
 * Only the linking environment's own error passes its message through:
 * anything else may carry the request, and with it the pairing code.
 */
const linkFailure = (failure: unknown): LinkAttemptOutcome & { readonly kind: "failed" } => {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "PeerLinkError" &&
    "reason" in failure &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    const error = failure as unknown as Parameters<typeof peerLinkFailureKind>[0];
    return { kind: "failed", failure: peerLinkFailureKind(error), detail: failure.message };
  }
  return { kind: "failed", failure: "other", detail: null };
};

type BatchMachine = Pick<LinkableMachine, "environmentId" | "label" | "urls">;

type MintPairingCode = (
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
) => Promise<Result.Result<string, unknown>>;

/**
 * One link to `machine`: a one-use code minted there with the client's session, handed to
 * `link` with the addresses the client has for it. The code stays in this call.
 */
export async function linkWithMintedCode(input: {
  readonly machine: BatchMachine;
  readonly access: AuthMcpClientAccess;
  readonly mint: MintPairingCode;
  readonly link: (input: PeerLinkCreateInput) => Promise<Result.Result<unknown, unknown>>;
}): Promise<LinkAttemptOutcome> {
  const { machine } = input;
  const [url, ...alternateUrls] = machine.urls;
  if (url === undefined) return { kind: "failed", failure: "unreachable", detail: null };
  try {
    const minted = await input.mint(machine.environmentId, input.access);
    if (Result.isFailure(minted)) return { kind: "failed", failure: "no_code", detail: null };
    const linked = await input.link({
      url,
      ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
      expectedEnvironmentId: machine.environmentId,
      expectedLabel: machine.label,
      pairingCode: minted.success,
      access: input.access,
    });
    return Result.isSuccess(linked) ? { kind: "linked" } : linkFailure(linked.failure);
  } catch {
    return { kind: "failed", failure: "other", detail: null };
  }
}

/**
 * Links each machine as a single link is made: a one-use code minted on that
 * machine with the client's session there, then handed to the linking
 * environment with the addresses the client has for it. A failure stops only
 * its own machine. Codes stay in this call and are never reported.
 */
export async function runLinkBatch(input: {
  readonly machines: ReadonlyArray<BatchMachine>;
  readonly access: AuthMcpClientAccess;
  readonly mint: MintPairingCode;
  readonly link: (input: PeerLinkCreateInput) => Promise<Result.Result<unknown, unknown>>;
  /**
   * Also links each of `targets` back to `source` once its own link is made. `link` creates
   * the link on that machine. A failure here is reported beside the link it follows.
   */
  readonly back?: {
    readonly source: BatchMachine;
    readonly targets: ReadonlySet<EnvironmentId>;
    readonly link: (
      environmentId: EnvironmentId,
      input: PeerLinkCreateInput,
    ) => Promise<Result.Result<unknown, unknown>>;
  };
  /** Called once, at the end: listing probes every linked machine, so `link` must not refresh. */
  readonly refreshLinks: () => void;
  readonly onOutcome?: (environmentId: EnvironmentId, outcome: LinkBatchOutcome) => void;
}): Promise<ReadonlyMap<EnvironmentId, LinkBatchOutcome>> {
  const outcomes = new Map<EnvironmentId, LinkBatchOutcome>();
  const { access, mint, back } = input;
  const linkOne = async (machine: BatchMachine): Promise<LinkBatchOutcome> => {
    const outcome = await linkWithMintedCode({ machine, access, mint, link: input.link });
    if (outcome.kind !== "linked" || !back?.targets.has(machine.environmentId)) return outcome;
    return {
      kind: "linked",
      back: await linkWithMintedCode({
        machine: back.source,
        access,
        mint,
        link: (create) => back.link(machine.environmentId, create),
      }),
    };
  };
  const queue = [...input.machines];
  const worker = async () => {
    for (let machine = queue.shift(); machine !== undefined; machine = queue.shift()) {
      const outcome = await linkOne(machine);
      outcomes.set(machine.environmentId, outcome);
      input.onOutcome?.(machine.environmentId, outcome);
    }
  };
  await Promise.all(Array.from({ length: LINK_BATCH_CONCURRENCY }, worker));
  if ([...outcomes.values()].some((outcome) => outcome.kind === "linked")) input.refreshLinks();
  return outcomes;
}

/** How a batch went, and the machines a retry would run again. */
export const linkBatchSummary = (outcomes: ReadonlyMap<EnvironmentId, LinkBatchOutcome>) => {
  const failed = [...outcomes].flatMap(([environmentId, outcome]) =>
    outcome.kind === "failed" ? [environmentId] : [],
  );
  return { linked: outcomes.size - failed.length, failed };
};
