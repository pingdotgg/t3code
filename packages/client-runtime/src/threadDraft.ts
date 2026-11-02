import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";

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
    const prefix = machine.environmentId.slice(0, RELAY_ID_PREFIX_LENGTH);
    const prefixShared = known.some(
      (other) =>
        other.environmentId !== machine.environmentId &&
        hostText(other) === null &&
        other.environmentId.startsWith(prefix),
    );
    return `${plain(machine.label)} · T3 Connect ${prefixShared ? machine.environmentId : prefix}`;
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
