import { msg } from "gt-i18n";

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
  { id: "time", label: msg("Time", { $context: "how long ago a thread was active" }) },
  { id: "spacer", label: msg("Spacer", { $context: "flexible empty space in a layout" }) },
] as const;

export type SidebarRowItemId = (typeof SIDEBAR_ROW_ITEMS)[number]["id"];
export type SidebarRowItemForm = "wide" | "compact";

/** Items with a wide and a compact form; the first form is the default. */
const SIDEBAR_ROW_ITEM_FORMS: Partial<Record<SidebarRowItemId, ReadonlyArray<SidebarRowItemForm>>> =
  {
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

export type StoredSidebarRowLayout = Readonly<Record<string, ReadonlyArray<string>>>;
type DefaultStoredLayout = Readonly<Record<SidebarRowLine, ReadonlyArray<string>>> & {
  readonly keep?: ReadonlyArray<SidebarRowCollapsibleLine>;
};

// Stored as "id" or "id:form". Spacers may repeat; every other item appears once.
const DEFAULT_STORED_LAYOUT: DefaultStoredLayout = {
  top: ["projectIcon", "projectName", "spacer", "time"],
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

/** Mobile's thread list keeps its two-line look until someone edits the layout. */
export const MOBILE_DEFAULT_STORED_LAYOUT: DefaultStoredLayout = {
  top: ["projectIcon", "title", "time"],
  middle: [],
  bottom: ["environment:wide", "spacer", "pullRequest", "agents"],
  hidden: ["projectName", "branch", "terminals", "issues"],
  keep: ["middle", "bottom"],
};

export function resolveSidebarRowLayout(
  stored: StoredSidebarRowLayout,
  defaults: DefaultStoredLayout = DEFAULT_STORED_LAYOUT,
): SidebarRowLayout {
  const placed = new Set<string>();
  let spacers = 0;
  const layout: MutableLayout = {
    top: [],
    middle: [],
    bottom: [],
    hidden: [],
    keepLines: [],
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
  // Stored under "keep" next to the lines.
  const keep = hasStored ? stored.keep : defaults.keep;
  // Height is all-or-nothing: an older layout that kept one line keeps both.
  layout.keepLines = keep?.some((line) => line === "middle" || line === "bottom")
    ? ["middle", "bottom"]
    : [];
  for (const line of SIDEBAR_ROW_LINES) {
    for (const value of (hasStored ? stored[line] : defaults[line]) ?? []) {
      const token = parseToken(value);
      if (token) place(line, token);
    }
  }
  // Items a saved layout never mentions, such as ones added later, take their default line.
  for (const line of SIDEBAR_ROW_LINES) {
    for (const value of defaults[line]) {
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

export function isDefaultSidebarRowLayout(
  layout: SidebarRowLayout,
  defaults: DefaultStoredLayout = DEFAULT_STORED_LAYOUT,
) {
  const stored = storedLines(layout);
  return (
    stored.keep.join() === (defaults.keep ?? []).join() &&
    SIDEBAR_ROW_LINES.every((line) => stored[line].join() === defaults[line].join())
  );
}

/** A layout equal to the default saves as `{}`, so later default changes still reach it. */
export function storedSidebarRowLayout(
  layout: SidebarRowLayout,
  defaults: DefaultStoredLayout = DEFAULT_STORED_LAYOUT,
): StoredSidebarRowLayout {
  return isDefaultSidebarRowLayout(layout, defaults) ? {} : storedLines(layout);
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

export type SidebarRowVisibleLine = Exclude<SidebarRowLine, "hidden">;

/**
 * What each line of a thread row holds, or null when it folds away. A line with nothing but
 * agents and spacers folds, and its agents join the title's line. A kept line holds its place
 * unless it has no items at all, which would only add an empty row to every card.
 */
export function resolveSidebarRowLines(input: {
  readonly lines: Readonly<Record<SidebarRowVisibleLine, ReadonlyArray<SidebarRowToken>>>;
  readonly titleLine: SidebarRowVisibleLine;
  readonly keepLines: ReadonlyArray<SidebarRowCollapsibleLine>;
  /** False when this thread has nothing to show for the item, such as no pull request. */
  readonly hasContent: (token: SidebarRowToken) => boolean;
}): Record<SidebarRowVisibleLine, ReadonlyArray<SidebarRowToken> | null> {
  const folds = (line: SidebarRowVisibleLine) => {
    const tokens = input.lines[line];
    const kept =
      line !== "top" &&
      input.keepLines.includes(line) &&
      tokens.some((token) => token.id !== "spacer");
    return (
      line !== "top" &&
      line !== input.titleLine &&
      !kept &&
      !tokens.some(
        (token) => token.id !== "agents" && token.id !== "spacer" && input.hasContent(token),
      )
    );
  };
  const folded = (["middle", "bottom"] as const).filter(folds);
  const foldedAgents = folded.flatMap((line) =>
    input.lines[line].filter((token) => token.id === "agents"),
  );
  const resolve = (line: SidebarRowVisibleLine) =>
    folded.includes(line as SidebarRowCollapsibleLine)
      ? null
      : line === input.titleLine
        ? [...input.lines[line], ...foldedAgents]
        : input.lines[line];
  return { top: resolve("top"), middle: resolve("middle"), bottom: resolve("bottom") };
}
