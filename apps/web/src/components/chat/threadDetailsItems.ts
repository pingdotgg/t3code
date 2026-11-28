import type { ClientSettings } from "@t3tools/contracts";
import { msg } from "gt-react";

// Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: msg("Environment and worktree"), defaultVisible: true },
  { id: "openIn", label: msg("Open in editor"), defaultVisible: true },
  { id: "scripts", label: msg("Project scripts"), defaultVisible: true },
  { id: "branch", label: msg("Branch and pull request"), defaultVisible: true },
  { id: "gitActions", label: msg("Git actions"), defaultVisible: true },
  {
    id: "changes",
    label: msg("Changes", { $context: "thread details item: version control changes" }),
    defaultVisible: true,
  },
  {
    id: "servers",
    label: msg("Servers", { $context: "thread details item: running dev servers" }),
    defaultVisible: true,
  },
  { id: "automations", label: msg("Automations"), defaultVisible: true },
  {
    id: "lineage",
    label: msg("Lineage", { $context: "thread details item: parent and child agents" }),
    defaultVisible: true,
  },
  { id: "sideChats", label: msg("Side chats"), defaultVisible: true },
  { id: "tasks", label: msg("Agent tasks"), defaultVisible: false },
  { id: "usage", label: msg("Usage limits"), defaultVisible: true },
  { id: "context", label: msg("Context window"), defaultVisible: true },
  {
    id: "machineLoad",
    label: msg("Machine load", { $context: "thread details item: CPU, memory and disk use" }),
    defaultVisible: false,
  },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

type ThreadDetailsItem = (typeof THREAD_DETAILS_ITEMS)[number];
type ThreadDetailsItemSettings = Pick<
  ClientSettings,
  "threadDetailsItems" | "threadDetailsUsageEnabled"
>;

export function resolveThreadDetailsVisibility(
  settings: ThreadDetailsItemSettings,
): ThreadDetailsVisibility {
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      settings.threadDetailsItems[item.id] ?? item.defaultVisible,
    ]),
  ) as Record<ThreadDetailsItemId, boolean>;
}

/** Stores only choices that differ from the default, so a later default change reaches everyone else. */
export function setThreadDetailsItem(
  settings: ThreadDetailsItemSettings,
  item: ThreadDetailsItem,
  visible: boolean,
): ClientSettings["threadDetailsItems"] {
  const { [item.id]: _previous, ...rest } = settings.threadDetailsItems;
  return visible === item.defaultVisible ? rest : { ...rest, [item.id]: visible };
}

export function isDefaultThreadDetailsVisibility(visibility: ThreadDetailsVisibility) {
  return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

/** Restore the canvas defaults and clear the retired Labs flag. */
export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
  threadDetailsUsageEnabled: false,
} satisfies Partial<ClientSettings>;
