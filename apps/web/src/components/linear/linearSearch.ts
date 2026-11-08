export type LinearView =
  | "mine"
  | "all"
  | "active"
  | "backlog"
  | "triage"
  | "created"
  | "subscribed"
  | "inbox"
  | "projects"
  | "cycles"
  | "documents";
export interface LinearSearch {
  view: LinearView;
  team?: string | undefined;
  issue?: string | undefined;
  parent?: string | undefined;
  project?: string | undefined;
  cycle?: string | undefined;
  q?: string | undefined;
  document?: string | undefined;
  statusId?: string | undefined;
  assignee?: string | undefined;
  label?: string | undefined;
  board?: boolean | undefined;
  archived?: boolean | undefined;
}
const views: ReadonlyArray<LinearView> = [
  "mine",
  "all",
  "active",
  "backlog",
  "triage",
  "created",
  "subscribed",
  "inbox",
  "projects",
  "cycles",
  "documents",
];
export function parseLinearSearch(raw: Record<string, unknown>): LinearSearch {
  const view = views.find((view) => view === raw.view);
  return {
    view: view ?? "mine",
    ...Object.fromEntries(
      [
        "team",
        "issue",
        "parent",
        "project",
        "cycle",
        "q",
        "document",
        "statusId",
        "assignee",
        "label",
      ].flatMap((key) =>
        typeof raw[key] === "string" && raw[key] ? [[key, raw[key].slice(0, 200)]] : [],
      ),
    ),
    ...(raw.board === true ? { board: true } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
  };
}
