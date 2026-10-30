import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type OrchestrationV2TurnItem,
  type PeerLinkRequestAnswerInput,
  type PeerLinkSummary,
  resolveEnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { EnvironmentPresentation } from "./connection/presentation.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./connection/routes.ts";
import type { RelayDiscoveredEnvironment } from "./relay/discovery.ts";

export type LinkRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "link_request" }>;

/** Whether an environment offers links: it supports them and its Linked environments beta is on. */
export const offersLinkedEnvironments = (
  config: Pick<ServerConfig, "environment" | "settings"> | null | undefined,
): boolean =>
  config?.environment.capabilities.peerLinks === true && config.settings.linkedEnvironmentsEnabled;

/**
 * The machines an environment's agents can work on, by name: its links that have not
 * expired, named as this client names them, else as the link does.
 */
export function linkedEnvironmentNames(input: {
  readonly links: ReadonlyArray<Pick<PeerLinkSummary, "environmentId" | "label" | "status">>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}): ReadonlyMap<EnvironmentId, string> {
  const names = new Map(
    input.environments.map((environment) => [environment.environmentId, environment.label]),
  );
  return new Map(
    input.links.flatMap((link) =>
      link.status === "expired"
        ? []
        : [[link.environmentId, names.get(link.environmentId) ?? link.label] as const],
    ),
  );
}

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
  /** Found on the user's T3 Connect account rather than saved in this client. */
  readonly connectOnly: boolean;
  /** Whether the thread's environment already has a link to it. */
  readonly linked: boolean;
  /**
   * Where the client knows it answers, most preferred first: the addresses it
   * reports, then its saved routes, then its T3 Connect address. The server
   * keeps only those that answer as this machine. Empty for a machine reached
   * only over SSH, whose forward lives in this client.
   */
  readonly urls: ReadonlyArray<string>;
}

/**
 * The catalog's machines other than the thread's own, in catalog order, then those only T3
 * Connect knows. `links` are the thread environment's; an expired one no longer counts as
 * linked. `connect` is what relay discovery found, and a server reaches a machine there as a
 * browser does, so its Connect address is usable.
 */
export function linkableMachines(input: {
  readonly environments: ReadonlyArray<
    EnvironmentPresentation & { readonly environmentId: EnvironmentId }
  >;
  readonly threadEnvironmentId: EnvironmentId;
  readonly links: ReadonlyArray<Pick<PeerLinkSummary, "environmentId" | "status">>;
  readonly connect: ReadonlyMap<string, RelayDiscoveredEnvironment>;
}): ReadonlyArray<LinkableMachine> {
  const linkedIds = new Set(
    input.links.flatMap((link) => (link.status === "expired" ? [] : [link.environmentId])),
  );
  const saved = input.environments
    .filter((environment) => environment.environmentId !== input.threadEnvironmentId)
    .map((environment) => {
      const reported = (environment.serverConfig?.directEndpoints ?? []).map(
        (endpoint) => endpoint.httpBaseUrl,
      );
      const routes = connectionRoutes(environment.entry).flatMap((route) => {
        const url = route.target._tag === "RelayConnectionTarget" ? null : routeHttpBaseUrl(route);
        return url === null ? [] : [url];
      });
      const connect = input.connect.get(environment.environmentId)?.environment.endpoint;
      return {
        environmentId: environment.environmentId,
        label: environment.entry.target.label,
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
        connected: environment.connection.phase === "connected",
        connectOnly: false,
        linked: linkedIds.has(environment.environmentId),
        urls: [
          ...new Set([
            ...reported,
            ...routes,
            ...(connect === undefined ? [] : [connect.httpBaseUrl]),
          ]),
        ],
      };
    });
  const savedIds = new Set<string>(saved.map((machine) => machine.environmentId));
  const connectOnly = [...input.connect.values()]
    .filter(
      ({ environment }) =>
        environment.environmentId !== input.threadEnvironmentId &&
        !savedIds.has(environment.environmentId),
    )
    .map(({ environment, status }) => {
      const descriptor = Option.getOrUndefined(status)?.descriptor;
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        machine: resolveEnvironmentMachineKind(
          descriptor === undefined ? null : { environment: descriptor },
        ),
        connected: false,
        connectOnly: true,
        linked: linkedIds.has(environment.environmentId),
        urls: [environment.endpoint.httpBaseUrl],
      };
    });
  return [...saved, ...connectOnly];
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
