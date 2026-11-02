import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { sanitizeThreadDraftText } from "@t3tools/shared/promptLinks";

import type { EnvironmentProject } from "./state/shell.ts";
import { deriveLogicalProjectKeyFromSettings } from "./state/projectGrouping.ts";

export type ThreadDraftItem = Extract<OrchestrationV2TurnItem, { readonly type: "thread_draft" }>;

/** A machine as the draft card names it: from the client's own catalog, never from the agent. */
export interface ThreadDraftMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** `connectionCatalogDisplayUrl`: a URL, SSH `user@host`, or null or "" for T3 Connect. */
  readonly displayUrl: string | null;
}

const RELAY_ID_PREFIX_LENGTH = 8;

// Direction controls in a name the other machine chose could make it read as another name.
const DIRECTION_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const plain = (text: string) => text.replace(DIRECTION_CONTROLS, "");

function hostText(machine: ThreadDraftMachine): string | null {
  if (!machine.displayUrl) return null;
  const address = plain(machine.displayUrl);
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/**
 * The machine as the picker and the Approve button show it: its label and where it is, so two
 * look-alike labels never look the same. `known` is every machine in the catalog, online or not,
 * so taking one offline never drops the id from another.
 */
export function threadDraftMachineName(
  machine: ThreadDraftMachine,
  known: ReadonlyArray<ThreadDraftMachine>,
): string {
  const host = hostText(machine);
  if (host === null) {
    return `${plain(machine.label)} · T3 Connect ${machine.environmentId.slice(0, RELAY_ID_PREFIX_LENGTH)}`;
  }
  const hostShared = known.some(
    (other) => other.environmentId !== machine.environmentId && hostText(other) === host,
  );
  const label = plain(machine.label);
  return hostShared ? `${label} · ${host} · ${machine.environmentId}` : `${label} · ${host}`;
}

/**
 * The machine the card preselects: the one the agent named if this client may start threads
 * there, else the one machine whose label equals the user's words. Anything looser leaves the
 * choice to the user.
 */
export function threadDraftInitialMachine(
  item: Pick<ThreadDraftItem, "environmentId" | "hint">,
  known: ReadonlyArray<Pick<ThreadDraftMachine, "environmentId" | "label">>,
  eligible: ReadonlySet<EnvironmentId>,
): EnvironmentId | null {
  if (item.environmentId !== undefined) {
    return eligible.has(item.environmentId) ? item.environmentId : null;
  }
  const hint = item.hint?.trim().toLowerCase();
  if (!hint) return null;
  const matches = known.filter((machine) => machine.label.trim().toLowerCase() === hint);
  const [only] = matches;
  return matches.length === 1 && only !== undefined && eligible.has(only.environmentId)
    ? only.environmentId
    : null;
}

/** What a draft card shows, the same on every client. */
export interface ThreadDraftCardModel {
  /** The prompt, checked again here so what the user reads is what the other machine gets. */
  readonly promptText: string;
  readonly hiddenCharacters: number;
  /** Malformed, padded or empty: shown with a warning and never opened. */
  readonly unreadable: boolean;
  /** The machine the agent meant, for the passive row. */
  readonly offeredName: string;
  readonly initialMachine: EnvironmentId | null;
  /** Connected machines this client may start threads on, in catalog order. */
  readonly eligible: ReadonlyArray<ThreadDraftMachine>;
  /** Why the machine the agent meant cannot be chosen, when it meant one. */
  readonly reason: string | null;
  readonly nameOf: (environmentId: EnvironmentId) => string | null;
}

export function threadDraftCardModel(
  item: Pick<ThreadDraftItem, "prompt" | "hiddenCharacters" | "environmentId" | "hint">,
  known: ReadonlyArray<ThreadDraftMachine>,
  connected: ReadonlySet<EnvironmentId>,
  eligibleIds: ReadonlySet<EnvironmentId>,
): ThreadDraftCardModel {
  const prompt = sanitizeThreadDraftText(item.prompt);
  const hint = item.hint === undefined ? undefined : sanitizeThreadDraftText(item.hint);
  const usableHint =
    hint === undefined || hint.malformed || hint.padded || hint.text.length === 0
      ? undefined
      : hint.text;
  const nameOf = (environmentId: EnvironmentId) => {
    const machine = known.find((candidate) => candidate.environmentId === environmentId);
    return machine === undefined ? null : threadDraftMachineName(machine, known);
  };
  const lowerHint = usableHint?.toLowerCase();
  const hintMatches = known.filter((machine) => machine.label.trim().toLowerCase() === lowerHint);
  const named =
    item.environmentId !== undefined
      ? known.find((machine) => machine.environmentId === item.environmentId)
      : hintMatches.length === 1
        ? hintMatches[0]
        : undefined;
  const namedName = named === undefined ? null : threadDraftMachineName(named, known);
  const quotedHint = usableHint === undefined ? null : `"${usableHint}"`;
  const reason =
    item.environmentId !== undefined && named === undefined
      ? `This app does not know ${quotedHint ?? "that machine"}. Add it to open the draft there.`
      : named === undefined || namedName === null || eligibleIds.has(named.environmentId)
        ? null
        : connected.has(named.environmentId)
          ? `${namedName} can't start threads from this app.`
          : `Connect ${namedName} to open it there.`;
  return {
    promptText: prompt.text,
    hiddenCharacters: item.hiddenCharacters + prompt.hiddenCharacters,
    unreadable: prompt.malformed || prompt.padded || prompt.text.length === 0,
    offeredName: namedName ?? quotedHint ?? "another machine",
    initialMachine: threadDraftInitialMachine(
      { environmentId: item.environmentId, hint: usableHint },
      known,
      eligibleIds,
    ),
    eligible: known.filter((machine) => eligibleIds.has(machine.environmentId)),
    reason,
    nameOf,
  };
}

// Fixed, so the match never depends on how the user groups the sidebar.
const MATCH_GROUPING = {
  sidebarProjectGroupingMode: "repository_path",
  sidebarProjectGroupingOverrides: {},
} as const;

/**
 * The project on `environmentId` a draft from `source` opens in: the first one, in the order
 * given, with the same repository and path. Null opens a scratch draft there: the source is a
 * scratch project, or that machine has no such project.
 */
export function threadDraftProjectMatch(
  source: EnvironmentProject | null,
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
): EnvironmentProject | null {
  if (source === null || source.isScratch === true) return null;
  const key = deriveLogicalProjectKeyFromSettings(source, MATCH_GROUPING);
  return (
    projects.find(
      (project) =>
        project.environmentId === environmentId &&
        project.archivedAt == null &&
        project.isScratch !== true &&
        deriveLogicalProjectKeyFromSettings(project, MATCH_GROUPING) === key,
    ) ?? null
  );
}
