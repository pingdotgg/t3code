import type { ClientSettings } from "@t3tools/contracts";
import { arrayMove } from "@dnd-kit/sortable";
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
  { id: "usage", label: msg("Usage limits"), defaultVisible: false },
  { id: "context", label: msg("Context window"), defaultVisible: false },
] as const;

export type ThreadDetailsItemId = (typeof THREAD_DETAILS_ITEMS)[number]["id"];
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

type ThreadDetailsItem = (typeof THREAD_DETAILS_ITEMS)[number];
type ThreadDetailsItemSettings = Pick<
  ClientSettings,
  "threadDetailsItems" | "threadDetailsUsageEnabled"
>;

// People who turned on the retired Labs toggle keep Usage and Context until they change them here.
function defaultVisible(item: ThreadDetailsItem, settings: ThreadDetailsItemSettings) {
  return item.id === "usage" || item.id === "context"
    ? settings.threadDetailsUsageEnabled
    : item.defaultVisible;
}

export function resolveThreadDetailsVisibility(
  settings: ThreadDetailsItemSettings,
): ThreadDetailsVisibility {
  return Object.fromEntries(
    THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      settings.threadDetailsItems[item.id] ?? defaultVisible(item, settings),
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
  return visible === defaultVisible(item, settings) ? rest : { ...rest, [item.id]: visible };
}

export function isDefaultThreadDetailsVisibility(visibility: ThreadDetailsVisibility) {
  return THREAD_DETAILS_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

// The card's movable blocks. A block in a group shares one section with group neighbors next to it.
// Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_BLOCKS = [
  { id: "environment", group: "workspace", label: msg("Environment and worktree") },
  { id: "openIn", group: "workspace", label: msg("Open in editor") },
  { id: "scripts", group: "workspace", label: msg("Project scripts") },
  { id: "branch", group: "versionControl", label: msg("Branch and pull request") },
  { id: "git", group: "versionControl", label: msg("Git actions") },
  { id: "repositories", group: "versionControl", label: msg("Repositories") },
  {
    id: "servers",
    group: null,
    label: msg("Servers", { $context: "thread details item: running dev servers" }),
  },
  { id: "automations", group: null, label: msg("Automations") },
  { id: "relationships", group: null, label: msg("Lineage and side chats") },
  { id: "usage", group: null, label: msg("Usage limits") },
  { id: "context", group: null, label: msg("Context window") },
] as const;

export type ThreadDetailsBlockId = (typeof THREAD_DETAILS_BLOCKS)[number]["id"];

const DEFAULT_BLOCK_ORDER = THREAD_DETAILS_BLOCKS.map((block) => block.id);

/** Saved order first; a block it never mentions, such as one added later, keeps its default neighbor. */
export function resolveThreadDetailsOrder(
  settings: Pick<ClientSettings, "threadDetailsOrder">,
): ReadonlyArray<ThreadDetailsBlockId> {
  const order = [
    ...new Set(
      settings.threadDetailsOrder.filter((id): id is ThreadDetailsBlockId =>
        DEFAULT_BLOCK_ORDER.includes(id as ThreadDetailsBlockId),
      ),
    ),
  ];
  DEFAULT_BLOCK_ORDER.forEach((id, index) => {
    if (order.includes(id)) return;
    const previous = DEFAULT_BLOCK_ORDER[index - 1];
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, id);
  });
  return order;
}

/** Moves a block to where `target` is; an order equal to the default saves as `[]`. */
export function moveThreadDetailsBlock(
  order: ReadonlyArray<ThreadDetailsBlockId>,
  id: ThreadDetailsBlockId,
  target: ThreadDetailsBlockId,
): ClientSettings["threadDetailsOrder"] {
  const next = arrayMove([...order], order.indexOf(id), order.indexOf(target));
  return isDefaultThreadDetailsOrder(next) ? [] : next;
}

export function isDefaultThreadDetailsOrder(order: ReadonlyArray<ThreadDetailsBlockId>) {
  return order.join() === DEFAULT_BLOCK_ORDER.join();
}

/** Also clears the retired Labs flag, so Usage and Context return to off. */
export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
  threadDetailsOrder: [],
  threadDetailsUsageEnabled: false,
} satisfies Partial<ClientSettings>;
