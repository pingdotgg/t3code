import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type OrchestrationV2TurnItem,
  type PeerLinkRequestAnswerInput,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import type { EnvironmentPresentation } from "./connection/presentation.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./connection/routes.ts";

export type LinkRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>;

/** The access a request opens with: the agent's suggestion, else supervised. */
export const linkRequestDefaultAccess = (
  item: Pick<LinkRequestItem, "requestedAccess">,
): AuthMcpClientAccess => item.requestedAccess ?? "approval-required";

/** What the card calls the other environment: its own name, else the address asked for. */
export const linkRequestTargetName = (item: Pick<LinkRequestItem, "label" | "url">): string =>
  item.label?.trim() || item.url || "a machine";

/** A machine the user could link a thread's environment to. */
export interface LinkableMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly connected: boolean;
  /** Whether the thread's environment already has a link to it. */
  readonly linked: boolean;
  /**
   * Where the client knows it answers, most preferred first: the addresses it
   * reports, then the saved routes. The server keeps only those that answer
   * as this machine. Empty for a machine reached only over T3 Connect or SSH.
   */
  readonly urls: ReadonlyArray<string>;
}

/**
 * The machines in the client's catalog other than the thread's own
 * environment, in catalog order. `linkedIds` are the environments the thread's
 * environment links to already.
 */
export function linkableMachines(input: {
  readonly environments: ReadonlyArray<
    EnvironmentPresentation & { readonly environmentId: EnvironmentId }
  >;
  readonly threadEnvironmentId: EnvironmentId;
  readonly linkedIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<LinkableMachine> {
  return input.environments
    .filter((environment) => environment.environmentId !== input.threadEnvironmentId)
    .map((environment) => {
      const reported = (environment.serverConfig?.directEndpoints ?? []).map(
        (endpoint) => endpoint.httpBaseUrl,
      );
      const saved = connectionRoutes(environment.entry).flatMap((route) => {
        const url = routeHttpBaseUrl(route);
        return url === null ? [] : [url];
      });
      return {
        environmentId: environment.environmentId,
        label: environment.entry.target.label,
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        connected: environment.connection.phase === "connected",
        linked: input.linkedIds.has(environment.environmentId),
        urls: [...new Set([...reported, ...saved])],
      };
    });
}

const words = (text: string) =>
  ` ${text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .join(" ")
    .trim()} `;
const NO_MATCH = 4;

/**
 * How well a machine's name matches the agent's hint, which is often the
 * user's own words ("my box"): exact, prefix, substring, then a hint that
 * names it among other words ("the box on hetzner").
 */
const hintRank = (label: string, hint: string) => {
  const name = label.trim().toLowerCase();
  const wanted = hint
    .trim()
    .toLowerCase()
    .replace(/^(?:my|our|the)\s+/, "");
  if (name === wanted) return 0;
  if (name.startsWith(wanted)) return 1;
  if (name.includes(wanted)) return 2;
  if (words(wanted).includes(words(name))) return 3;
  return NO_MATCH;
};

/** The machines best match for the agent's hint first, each rank in catalog order. */
export function rankMachinesByHint<T extends { readonly label: string }>(
  machines: ReadonlyArray<T>,
  hint: string | undefined,
): ReadonlyArray<T> {
  if (hint === undefined || hint.trim().length === 0) return machines;
  return machines
    .map((machine, index) => ({ machine, index, rank: hintRank(machine.label, hint) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ machine }) => machine);
}

/** The machine a card opens on: the one it names, else the hint's best match. */
export function linkRequestInitialMachine(
  item: Pick<LinkRequestItem, "environmentId" | "hint">,
  machines: ReadonlyArray<LinkableMachine>,
): EnvironmentId | null {
  if (item.environmentId !== undefined) return item.environmentId;
  if (item.hint === undefined) return null;
  const [best] = rankMachinesByHint(machines, item.hint);
  return best !== undefined && hintRank(best.label, item.hint) < NO_MATCH
    ? best.environmentId
    : null;
}

/** What a link request card shows: the actions while pending, otherwise a one-line outcome. */
export type LinkRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "linked" | "declined" | "ended" | "failed";
      readonly label: string;
    };

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked. `accessLabel`
 * names an access level the way the client's access picker does.
 */
export function linkRequestDisplay(
  item: Pick<
    LinkRequestItem,
    "linkStatus" | "label" | "url" | "linkedLabel" | "linkedAccess" | "failure"
  >,
  visibility: "local" | "inherited" | "synthetic",
  accessLabel: (access: AuthMcpClientAccess) => string,
): LinkRequestDisplay {
  switch (item.linkStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: "Waiting for an answer in the original thread" };
    case "linked":
      return {
        kind: "answered",
        outcome: "linked",
        label: `Linked ${item.linkedLabel ?? linkRequestTargetName(item)}${
          item.linkedAccess === undefined ? "" : ` · ${accessLabel(item.linkedAccess)}`
        }`,
      };
    case "declined":
      return { kind: "answered", outcome: "declined", label: "Declined" };
    case "failed":
      return {
        kind: "answered",
        outcome: "failed",
        label: `Could not link: ${item.failure ?? "the other environment refused"}`,
      };
    case "cancelled":
      return { kind: "answered", outcome: "ended", label: "Request ended" };
  }
}

/**
 * Builds the RPC payload for an answer. A link with a blank code returns null,
 * since the server rejects it; callers keep Link disabled instead.
 */
export function linkRequestAnswerInput(
  item: Pick<LinkRequestItem, "id" | "threadId">,
  answer:
    | {
        readonly type: "link";
        /** The machine picked, or an address typed in its place. */
        readonly target:
          | Pick<LinkableMachine, "environmentId" | "label" | "urls">
          | { readonly url: string };
        readonly access: AuthMcpClientAccess;
        readonly pairingCode: string;
      }
    | { readonly type: "use-existing"; readonly environmentId: EnvironmentId }
    | { readonly type: "decline" },
): PeerLinkRequestAnswerInput | null {
  const base = { threadId: item.threadId, turnItemId: item.id };
  if (answer.type !== "link") return { ...base, answer };
  const pairingCode = answer.pairingCode.trim();
  if (pairingCode.length === 0) return null;
  const { target } = answer;
  if ("url" in target) {
    const url = target.url.trim();
    if (url.length === 0) return null;
    return { ...base, answer: { type: "link", urls: [url], access: answer.access, pairingCode } };
  }
  const [first, ...rest] = target.urls;
  if (first === undefined) return null;
  return {
    ...base,
    answer: {
      type: "link",
      environmentId: target.environmentId,
      label: target.label,
      urls: [first, ...rest],
      access: answer.access,
      pairingCode,
    },
  };
}

/** Failures whose message is written for the user and never echoes the request payload. */
const USER_FACING_FAILURE_TAGS = new Set([
  "PeerLinkRequestError",
  "EnvironmentAuthorizationError",
  "PeerPairingCodeError",
]);

/**
 * Inline error copy for a failed answer. Only known errors pass their message
 * through: anything else (transport or encoding failures) gets the generic
 * copy, so the pairing code can never surface in the UI.
 */
export function linkRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
