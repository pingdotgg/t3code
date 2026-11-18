import { parseRightPanelMenuChoice, type RightPanelMenuChoice } from "@t3tools/contracts";

/** The "+" menu's and launcher's items, in order. Choices are stored by id: never rename one. */
export const RIGHT_PANEL_MENU_ITEM_IDS = [
  "browser",
  "terminal",
  "files",
  "diff",
  "pull-request",
  "pull-requests",
  "device",
  "side-chat",
  "replies",
  "dashboard",
  "whiteboard",
] as const;
export type RightPanelMenuItemId = (typeof RIGHT_PANEL_MENU_ITEM_IDS)[number];

type MenuLayer = Readonly<Partial<Record<RightPanelMenuItemId, RightPanelMenuChoice>>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMenuItemId = (id: string): id is RightPanelMenuItemId =>
  (RIGHT_PANEL_MENU_ITEM_IDS as ReadonlyArray<string>).includes(id);

/** Drops unknown ids and fields that do not parse, so those fall through to the layer below. */
export function parseMenuLayer(raw: unknown): MenuLayer {
  const layer: Partial<Record<RightPanelMenuItemId, RightPanelMenuChoice>> = {};
  if (!isRecord(raw)) return layer;
  for (const [id, value] of Object.entries(raw)) {
    if (!isMenuItemId(id)) continue;
    const choice = parseRightPanelMenuChoice(value);
    if (choice !== undefined) layer[id] = choice;
  }
  return layer;
}

/** `layer` with `id`'s choice replaced; an empty choice removes the entry. Unknown ids survive. */
export function setMenuChoice(
  layer: unknown,
  id: RightPanelMenuItemId,
  choice: RightPanelMenuChoice,
): Record<string, unknown> {
  const { [id]: _previous, ...rest } = isRecord(layer) ? layer : {};
  return Object.keys(choice).length === 0 ? rest : { ...rest, [id]: choice };
}

export interface MenuAction {
  readonly id: RightPanelMenuItemId;
  readonly shortcut: string;
  readonly available: boolean;
}

/** The action with its letter decided here, so no longer the literal it was built with. */
export type ArrangedAction<A> = { [K in keyof A]: K extends "shortcut" ? string : A[K] };

const BUILT_IN = 0;
const MACHINE = 1;
const BROWSER = 2;

/**
 * Per item and field: browser, else machine, else the action's own letter. Hidden items drop out.
 * A letter goes to available items before disabled ones; within each, the layer that set it wins,
 * then menu order. Items that lose show no letter.
 */
export function arrangeSurfaceActions<A extends MenuAction>(
  actions: ReadonlyArray<A>,
  machine: MenuLayer,
  browser: MenuLayer,
): Array<ArrangedAction<A>> {
  const shown = actions.flatMap((action, order) => {
    if (browser[action.id]?.hidden ?? machine[action.id]?.hidden ?? false) return [];
    const browserKey = browser[action.id]?.key;
    const machineKey = machine[action.id]?.key;
    const [key, layer] =
      browserKey !== undefined
        ? [browserKey, BROWSER]
        : machineKey !== undefined
          ? [machineKey, MACHINE]
          : [action.shortcut.toUpperCase(), BUILT_IN];
    return [{ action, order, key, layer }];
  });
  const letters = new Map<(typeof shown)[number], string>();
  const taken = new Set<string>();
  for (const available of [true, false]) {
    const claims = shown
      .filter((item) => item.action.available === available && item.key !== "")
      .toSorted((left, right) => right.layer - left.layer || left.order - right.order);
    for (const claim of claims) {
      if (taken.has(claim.key)) continue;
      taken.add(claim.key);
      letters.set(claim, claim.key);
    }
  }
  return shown.map(
    (item) => ({ ...item.action, shortcut: letters.get(item) ?? "" }) as ArrangedAction<A>,
  );
}
