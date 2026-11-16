import type { ClientSettings } from "@t3tools/contracts";

// Ids are stored in client settings, so never rename one.
const ALL_THREAD_DETAILS_ITEMS = [
  { id: "target", label: "Target", defaultVisible: true },
  { id: "testRun", label: "Test run", defaultVisible: true },
  { id: "environment", label: "Environment", defaultVisible: true },
  { id: "openIn", label: "Open in editor", defaultVisible: true },
  { id: "scripts", label: "Project scripts", defaultVisible: true },
  { id: "branch", label: "Branch and pull request", defaultVisible: true },
  { id: "gitActions", label: "Git actions", defaultVisible: true },
  { id: "changes", label: "Changes", defaultVisible: true },
  { id: "servers", label: "Servers", defaultVisible: true },
  { id: "automations", label: "Automations", defaultVisible: true },
  { id: "lineage", label: "Lineage", defaultVisible: true },
  { id: "sideChats", label: "Side chats", defaultVisible: true },
  { id: "usage", label: "Usage limits", defaultVisible: false },
  { id: "context", label: "Context window", defaultVisible: false },
] as const;

export type ThreadDetailsItemId = (typeof ALL_THREAD_DETAILS_ITEMS)[number]["id"];

// Exploro is a QA tool. The developer sections stay in the code, so T3 merges stay easy, but never show.
const EXPLORO_HIDDEN_ITEMS: ReadonlySet<ThreadDetailsItemId> = new Set([
  "openIn",
  "scripts",
  "branch",
  "gitActions",
  "changes",
  "servers",
]);

export const THREAD_DETAILS_ITEMS = ALL_THREAD_DETAILS_ITEMS.filter(
  (item) => !EXPLORO_HIDDEN_ITEMS.has(item.id),
);
export type ThreadDetailsVisibility = Readonly<Record<ThreadDetailsItemId, boolean>>;

type ThreadDetailsItem = (typeof ALL_THREAD_DETAILS_ITEMS)[number];
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
    ALL_THREAD_DETAILS_ITEMS.map((item) => [
      item.id,
      !EXPLORO_HIDDEN_ITEMS.has(item.id) &&
        (settings.threadDetailsItems[item.id] ?? defaultVisible(item, settings)),
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

/** Also clears the retired Labs flag, so Usage and Context return to off. */
export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
  threadDetailsUsageEnabled: false,
} satisfies Partial<ClientSettings>;
