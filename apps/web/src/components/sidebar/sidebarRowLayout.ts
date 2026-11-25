import type { ClientSettings } from "@t3tools/contracts";
import { msg } from "gt-react";
import { createContext, type ReactNode } from "react";

const SIDEBAR_ROW_LINES = ["top", "middle", "bottom", "hidden"] as const;
export type SidebarRowLine = (typeof SIDEBAR_ROW_LINES)[number];

// Ids are stored in client settings, so never rename one.
export const SIDEBAR_ROW_ITEMS = [
  { id: "title", label: msg("Thread title") },
  { id: "projectIcon", label: msg("Project icon") },
  { id: "projectName", label: msg("Project name") },
  { id: "environment", label: msg("Environment") },
  { id: "branch", label: msg("Branch and worktree") },
  { id: "terminals", label: msg("Running terminals") },
  { id: "pullRequest", label: msg("Pull request") },
  { id: "issues", label: msg("Linked issues") },
  { id: "agents", label: msg("Agents") },
  { id: "spacer", label: msg("Spacer", { $context: "flexible empty space in a layout" }) },
] as const;

export type SidebarRowItemId = (typeof SIDEBAR_ROW_ITEMS)[number]["id"];
export type SidebarRowItemForm = "wide" | "compact";

/** Items with a wide and a compact form; the first form is the default. */
export const SIDEBAR_ROW_ITEM_FORMS: Partial<
  Record<SidebarRowItemId, ReadonlyArray<SidebarRowItemForm>>
> = {
  environment: ["wide", "compact"],
};

export interface SidebarRowToken {
  readonly id: SidebarRowItemId;
  readonly form: SidebarRowItemForm | null;
  /** Unique within a layout, so several spacers can be told apart while dragging. */
  readonly key: string;
}

/** Lines that may collapse when a thread has nothing for them; the top line always shows. */
export type SidebarRowCollapsibleLine = "middle" | "bottom";

export type SidebarRowLayout = Readonly<Record<SidebarRowLine, ReadonlyArray<SidebarRowToken>>> & {
  /** Lines kept even when empty, so every card has the same height. */
  readonly keepLines: ReadonlyArray<SidebarRowCollapsibleLine>;
};

type MutableLayout = Record<SidebarRowLine, SidebarRowToken[]> & {
  keepLines: ReadonlyArray<SidebarRowCollapsibleLine>;
};

// Stored as "id" or "id:form". Spacers may repeat; every other item appears once.
const DEFAULT_STORED_LAYOUT: Record<SidebarRowLine, ReadonlyArray<string>> = {
  top: ["projectIcon", "projectName", "spacer"],
  middle: ["title"],
  bottom: [
    "branch",
    "spacer",
    "terminals",
    "pullRequest",
    "issues",
    "environment:compact",
    "agents",
  ],
  hidden: [],
};

const ITEM_IDS = new Set<string>(SIDEBAR_ROW_ITEMS.map((item) => item.id));

function parseToken(stored: string): Omit<SidebarRowToken, "key"> | null {
  const [id, form] = stored.split(":");
  if (id === undefined || !ITEM_IDS.has(id)) return null;
  const forms = SIDEBAR_ROW_ITEM_FORMS[id as SidebarRowItemId];
  return {
    id: id as SidebarRowItemId,
    form: forms ? (forms.find((candidate) => candidate === form) ?? forms[0] ?? null) : null,
  };
}

export function resolveSidebarRowLayout(
  stored: ClientSettings["sidebarRowLayout"],
): SidebarRowLayout {
  const placed = new Set<string>();
  let spacers = 0;
  const layout: MutableLayout = {
    top: [],
    middle: [],
    bottom: [],
    hidden: [],
    // Stored under "keep" next to the lines.
    keepLines: (["middle", "bottom"] as const).filter((line) => stored.keep?.includes(line)),
  };
  const place = (line: SidebarRowLine, token: Omit<SidebarRowToken, "key">) => {
    if (token.id === "spacer") {
      if (line !== "hidden") layout[line].push({ ...token, key: `spacer-${spacers++}` });
      return;
    }
    if (placed.has(token.id)) return;
    placed.add(token.id);
    // Every row needs its title, so a hidden title goes back to the middle line.
    layout[token.id === "title" && line === "hidden" ? "middle" : line].push({
      ...token,
      key: token.id,
    });
  };
  const hasStored = SIDEBAR_ROW_LINES.some((line) => (stored[line]?.length ?? 0) > 0);
  for (const line of SIDEBAR_ROW_LINES) {
    for (const value of (hasStored ? stored[line] : DEFAULT_STORED_LAYOUT[line]) ?? []) {
      const token = parseToken(value);
      if (token) place(line, token);
    }
  }
  // Items a saved layout never mentions, such as ones added later, take their default line.
  for (const line of SIDEBAR_ROW_LINES) {
    for (const value of DEFAULT_STORED_LAYOUT[line]) {
      const token = parseToken(value);
      if (token && token.id !== "spacer") place(line, token);
    }
  }
  return layout;
}

export const DEFAULT_SIDEBAR_ROW_LAYOUT = resolveSidebarRowLayout({});

function storedLines(layout: SidebarRowLayout): Record<SidebarRowLine | "keep", string[]> {
  return {
    ...(Object.fromEntries(
      SIDEBAR_ROW_LINES.map((line) => [
        line,
        layout[line].map((token) => (token.form ? `${token.id}:${token.form}` : token.id)),
      ]),
    ) as Record<SidebarRowLine, string[]>),
    keep: [...layout.keepLines],
  };
}

export function isDefaultSidebarRowLayout(layout: SidebarRowLayout) {
  const stored = storedLines(layout);
  return (
    layout.keepLines.length === 0 &&
    SIDEBAR_ROW_LINES.every((line) => stored[line].join() === DEFAULT_STORED_LAYOUT[line].join())
  );
}

/** A layout equal to the default saves as `{}`, so later default changes still reach it. */
export function storedSidebarRowLayout(
  layout: SidebarRowLayout,
): ClientSettings["sidebarRowLayout"] {
  return isDefaultSidebarRowLayout(layout) ? {} : storedLines(layout);
}

export function findSidebarRowToken(layout: SidebarRowLayout, key: string) {
  for (const line of SIDEBAR_ROW_LINES) {
    const index = layout[line].findIndex((token) => token.key === key);
    const token = layout[line][index];
    if (token) return { line, index, token };
  }
  return null;
}

function mapLines(
  layout: SidebarRowLayout,
  map: (tokens: ReadonlyArray<SidebarRowToken>) => SidebarRowToken[],
): MutableLayout {
  return {
    ...(Object.fromEntries(SIDEBAR_ROW_LINES.map((line) => [line, map(layout[line])])) as Record<
      SidebarRowLine,
      SidebarRowToken[]
    >),
    keepLines: layout.keepLines,
  };
}

function withoutToken(layout: SidebarRowLayout, key: string) {
  return mapLines(layout, (tokens) => tokens.filter((token) => token.key !== key));
}

/**
 * Moves a token to `index` of `line`; an index past the end appends. A spacer moved to hidden is
 * removed, and the title cannot be hidden.
 */
export function moveSidebarRowToken(
  layout: SidebarRowLayout,
  key: string,
  line: SidebarRowLine,
  index: number,
): SidebarRowLayout {
  const found = findSidebarRowToken(layout, key);
  if (!found || (found.token.id === "title" && line === "hidden")) return layout;
  const next = withoutToken(layout, key);
  if (found.token.id === "spacer" && line === "hidden") return next;
  next[line].splice(Math.max(0, Math.min(index, next[line].length)), 0, found.token);
  return next;
}

export function setSidebarRowTokenForm(
  layout: SidebarRowLayout,
  key: string,
  form: SidebarRowItemForm,
): SidebarRowLayout {
  return mapLines(layout, (tokens) =>
    tokens.map((token) => (token.key === key ? { ...token, form } : token)),
  );
}

export function setSidebarRowLineKept(
  layout: SidebarRowLayout,
  line: SidebarRowCollapsibleLine,
  kept: boolean,
): SidebarRowLayout {
  const others = layout.keepLines.filter((candidate) => candidate !== line);
  return { ...layout, keepLines: kept ? [...others, line] : others };
}

export function insertSidebarRowSpacer(
  layout: SidebarRowLayout,
  line: Exclude<SidebarRowLine, "hidden">,
  index: number,
): { layout: SidebarRowLayout; key: string } {
  const used = new Set(SIDEBAR_ROW_LINES.flatMap((name) => layout[name].map((t) => t.key)));
  let n = 0;
  while (used.has(`spacer-${n}`)) n++;
  const key = `spacer-${n}`;
  const next = withoutToken(layout, key);
  next[line].splice(Math.max(0, Math.min(index, next[line].length)), 0, {
    id: "spacer",
    form: null,
    key,
  });
  return { layout: next, key };
}

/** Hides an item without saving, as the sidebar does for Environment on a single environment. */
export function withoutSidebarRowItem(
  layout: SidebarRowLayout,
  id: SidebarRowItemId,
): SidebarRowLayout {
  return moveSidebarRowToken(layout, id, "hidden", Number.POSITIVE_INFINITY);
}

export interface SidebarRowLayoutItem {
  readonly token: SidebarRowToken;
  /** Null when this thread has nothing to show for the item, such as no pull request. */
  readonly node: ReactNode;
}

/** Set only by the layout editor, which wraps each line of the real row in drag targets. */
export const SidebarRowLayoutEditingContext = createContext<{
  renderLine: (
    line: Exclude<SidebarRowLine, "hidden">,
    items: ReadonlyArray<SidebarRowLayoutItem>,
  ) => ReactNode;
} | null>(null);
