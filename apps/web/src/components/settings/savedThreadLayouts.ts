import {
  DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
  type ClientSettings,
  type SavedThreadRowLayout,
  type SidebarThreadRowPlacement,
} from "@t3tools/contracts/settings";

type LayoutSettings = Pick<
  ClientSettings,
  | "sidebarThreadRowLayout"
  | "sidebarSavedThreadLayouts"
  | "sidebarActiveThreadLayoutId"
  | "sidebarThreadRowLayoutMode"
  | "sidebarCompactThreadRows"
>;

export const STANDARD_THREAD_LAYOUT: SavedThreadRowLayout = {
  id: "preset:standard",
  name: "Standard",
  layout: [
    { component: "projectIcon", row: 1, alignment: "left" },
    { component: "project", row: 1, alignment: "left" },
    { component: "pin", row: 1, alignment: "right" },
    { component: "status", row: 1, alignment: "right" },
    { component: "duration", row: 1, alignment: "right" },
    { component: "title", row: 2, alignment: "left" },
    { component: "worktree", row: 3, alignment: "left" },
    { component: "branch", row: 3, alignment: "left" },
    { component: "terminal", row: 3, alignment: "right" },
    { component: "pullRequest", row: 3, alignment: "right" },
    { component: "provider", row: 3, alignment: "right" },
  ],
};
export const COMPACT_THREAD_LAYOUT: SavedThreadRowLayout = {
  id: "preset:compact",
  name: "Compact",
  layout: DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
};
export const BUILT_IN_THREAD_LAYOUTS = [STANDARD_THREAD_LAYOUT, COMPACT_THREAD_LAYOUT];
const isPreset = (id: string) => BUILT_IN_THREAD_LAYOUTS.some((item) => item.id === id);
const sameLayout = (
  left: ReadonlyArray<SidebarThreadRowPlacement>,
  right: ReadonlyArray<SidebarThreadRowPlacement>,
) =>
  left.length === right.length &&
  left.every(
    (item, i) =>
      item.component === right[i]?.component &&
      item.row === right[i]?.row &&
      item.alignment === right[i]?.alignment,
  );

/** Keep built-ins out of saved state and preserve arrangements from before the layout library. */
export function resolveSavedThreadLayouts(settings: LayoutSettings) {
  const mode =
    settings.sidebarThreadRowLayoutMode === "standard" && settings.sidebarCompactThreadRows
      ? "compact"
      : settings.sidebarThreadRowLayoutMode;
  const saved = settings.sidebarSavedThreadLayouts.filter((item) => !isPreset(item.id));
  const active = saved.find((item) => item.id === settings.sidebarActiveThreadLayoutId);
  const custom = {
    id: "current",
    name: "My layout",
    ...active,
    layout: settings.sidebarThreadRowLayout,
  };
  const hasCustom =
    !!active || mode === "custom" || !sameLayout(custom.layout, DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT);
  const customLayouts = !hasCustom
    ? saved
    : active
      ? saved.map((item) => (item.id === active.id ? custom : item))
      : [custom, ...saved.filter((item) => item.id !== custom.id)];
  const preset = mode === "custom" ? null : mode;
  const current =
    preset === "standard"
      ? STANDARD_THREAD_LAYOUT
      : preset === "compact"
        ? COMPACT_THREAD_LAYOUT
        : custom;
  return { layouts: [...BUILT_IN_THREAD_LAYOUTS, ...customLayouts], current, preset };
}

type LayoutAction =
  | { type: "edit"; id: string; layout: ReadonlyArray<SidebarThreadRowPlacement> }
  | { type: "select"; id: string }
  | { type: "create"; id: string; duplicate: boolean }
  | { type: "rename"; id: string; name: string }
  | { type: "delete" };

export function changeSavedThreadLayout(
  settings: LayoutSettings,
  action: LayoutAction,
): LayoutSettings | null {
  const resolved = resolveSavedThreadLayouts(settings);
  let { current } = resolved;
  let saved = resolved.layouts.filter((item) => !isPreset(item.id));
  const create = (id: string, base: string, layout: ReadonlyArray<SidebarThreadRowPlacement>) => {
    if (resolved.layouts.some((item) => item.id === id)) return null;
    let name = base;
    for (let n = 2; resolved.layouts.some((item) => item.name === name); n++) name = `${base} ${n}`;
    return { id, name, layout };
  };
  switch (action.type) {
    case "edit": {
      if (sameLayout(current.layout, action.layout)) return null;
      const edited = resolved.preset
        ? create(action.id, `${current.name} copy`, action.layout)
        : { ...current, layout: action.layout };
      if (!edited) return null;
      current = edited;
      break;
    }
    case "select": {
      const selected = resolved.layouts.find((item) => item.id === action.id);
      if (!selected) return null;
      if (isPreset(selected.id)) {
        return {
          sidebarThreadRowLayout: settings.sidebarThreadRowLayout,
          sidebarThreadRowLayoutMode:
            selected.id === STANDARD_THREAD_LAYOUT.id ? "standard" : "compact",
          sidebarCompactThreadRows: false,
          sidebarActiveThreadLayoutId: resolved.preset
            ? settings.sidebarActiveThreadLayoutId
            : current.id,
          sidebarSavedThreadLayouts: saved,
        };
      }
      current = selected;
      break;
    }
    case "create": {
      const created = create(
        action.id,
        action.duplicate ? `${current.name.slice(0, 65)} copy` : "Layout",
        action.duplicate ? current.layout : DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
      );
      if (!created) return null;
      current = created;
      break;
    }
    case "rename": {
      const name = action.name.trim();
      if (!name || name.length > 80 || name === current.name) return null;
      const renamed = resolved.preset
        ? create(action.id, name, current.layout)
        : { ...current, name };
      if (!renamed) return null;
      current = renamed;
      break;
    }
    case "delete": {
      if (resolved.preset) return null;
      saved = saved.filter((item) => item.id !== current.id);
      const next = saved[0];
      if (!next)
        return {
          sidebarThreadRowLayoutMode: "standard",
          sidebarCompactThreadRows: false,
          sidebarThreadRowLayout: DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
          sidebarActiveThreadLayoutId: null,
          sidebarSavedThreadLayouts: [],
        };
      current = next;
      break;
    }
  }
  return {
    sidebarThreadRowLayoutMode: "custom",
    sidebarCompactThreadRows: false,
    sidebarThreadRowLayout: current.layout,
    sidebarActiveThreadLayoutId: current.id,
    sidebarSavedThreadLayouts: saved.some((item) => item.id === current.id)
      ? saved.map((item) => (item.id === current.id ? current : item))
      : [...saved, current],
  };
}
