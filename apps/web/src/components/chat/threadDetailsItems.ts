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

// The card's sections, which move as a unit. Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_SECTIONS = [
  {
    id: "workspace",
    label: msg("Workspace"),
    items: ["environment", "openIn", "scripts"],
    headingIds: ["thread-details-workspace-heading"],
  },
  {
    id: "versionControl",
    label: msg("Version control"),
    items: ["branch", "gitActions", "changes"],
    headingIds: ["thread-details-version-control-heading"],
  },
  {
    id: "servers",
    label: msg("Servers", { $context: "thread details item: running dev servers" }),
    items: ["servers"],
    headingIds: ["thread-details-servers-heading"],
  },
  {
    id: "automations",
    label: msg("Automations"),
    items: ["automations"],
    headingIds: ["thread-details-automations-heading"],
  },
  {
    id: "relationships",
    label: msg("Lineage and side chats"),
    items: ["lineage", "sideChats"],
    headingIds: ["thread-details-lineage-heading", "thread-details-side-chats-heading"],
  },
  {
    id: "usage",
    label: msg("Usage limits"),
    items: ["usage"],
    headingIds: ["thread-details-usage-heading"],
  },
  {
    id: "context",
    label: msg("Context window"),
    items: ["context"],
    headingIds: ["thread-details-context-heading"],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: unknown;
  items: ReadonlyArray<ThreadDetailsItemId>;
  headingIds: ReadonlyArray<string>;
}>;

export type ThreadDetailsSectionId = (typeof THREAD_DETAILS_SECTIONS)[number]["id"];

const DEFAULT_SECTION_ORDER = THREAD_DETAILS_SECTIONS.map((section) => section.id);

/** Saved order first; a section it never mentions, such as one added later, keeps its default neighbor. */
export function resolveThreadDetailsOrder(
  settings: Pick<ClientSettings, "threadDetailsOrder">,
): ReadonlyArray<ThreadDetailsSectionId> {
  const order = [
    ...new Set(
      settings.threadDetailsOrder.filter((id): id is ThreadDetailsSectionId =>
        DEFAULT_SECTION_ORDER.includes(id as ThreadDetailsSectionId),
      ),
    ),
  ];
  DEFAULT_SECTION_ORDER.forEach((id, index) => {
    if (order.includes(id)) return;
    const previous = DEFAULT_SECTION_ORDER[index - 1];
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, id);
  });
  return order;
}

/** Moves a section by `steps`; an order equal to the default saves as `[]`. */
export function moveThreadDetailsSection(
  order: ReadonlyArray<ThreadDetailsSectionId>,
  id: ThreadDetailsSectionId,
  steps: number,
): ClientSettings["threadDetailsOrder"] {
  const from = order.indexOf(id);
  const to = Math.max(0, Math.min(order.length - 1, from + steps));
  const next = order.filter((candidate) => candidate !== id);
  next.splice(to, 0, id);
  return isDefaultThreadDetailsOrder(next) ? [] : next;
}

export function isDefaultThreadDetailsOrder(order: ReadonlyArray<ThreadDetailsSectionId>) {
  return order.join() === DEFAULT_SECTION_ORDER.join();
}

/** The section a heading id belongs to, for the card's right-click menu. */
export function threadDetailsSectionForHeading(headingId: string | undefined) {
  return THREAD_DETAILS_SECTIONS.find((section) =>
    (section.headingIds as ReadonlyArray<string>).includes(headingId ?? ""),
  );
}

/** Also clears the retired Labs flag, so Usage and Context return to off. */
export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
  threadDetailsOrder: [],
  threadDetailsUsageEnabled: false,
} satisfies Partial<ClientSettings>;
