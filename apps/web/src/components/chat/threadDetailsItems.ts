import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { ClientSettings } from "@t3tools/contracts";

// Ids are stored in client settings, so never rename one.
export const THREAD_DETAILS_ITEMS = [
  { id: "environment", label: "chat.details.environment", defaultVisible: true },
  { id: "openIn", label: "chat.details.openIn", defaultVisible: true },
  { id: "scripts", label: "chat.details.scripts", defaultVisible: true },
  { id: "branch", label: "chat.details.branch", defaultVisible: true },
  { id: "gitActions", label: "chat.details.gitActions", defaultVisible: true },
  { id: "changes", label: "chat.details.changes", defaultVisible: true },
  { id: "servers", label: "chat.details.servers", defaultVisible: true },
  { id: "automations", label: "chat.details.automations", defaultVisible: true },
  { id: "lineage", label: "chat.details.lineage", defaultVisible: true },
  { id: "sideChats", label: "chat.details.sideChats", defaultVisible: true },
  { id: "usage", label: "chat.details.usage", defaultVisible: false },
  { id: "context", label: "chat.details.context", defaultVisible: false },
] as const satisfies readonly {
  readonly id: string;
  readonly label: MessageKey;
  readonly defaultVisible: boolean;
}[];

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

/** Also clears the retired Labs flag, so Usage and Context return to off. */
export const RESET_THREAD_DETAILS_ITEMS = {
  threadDetailsItems: {},
  threadDetailsUsageEnabled: false,
} satisfies Partial<ClientSettings>;
