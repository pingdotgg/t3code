import { ChevronDownIcon, ChevronUpIcon, MousePointer2Icon, PlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createVividThemeColors,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
  updateThemeColorFamily,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import {
  clearThemeInspectorHover,
  clearThemeInspectorHighlights,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

type ThemeEditorColorFamily = Readonly<{
  id: string;
  label: string;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  families: ReadonlyArray<ThemeEditorColorFamily>;
}> = [
  {
    id: "foundation",
    title: "Foundation",
    families: [
      {
        id: "background",
        label: "Background",
        role: "canvas",
        roles: ["canvas", "chrome", "toolbar"],
      },
      { id: "surface", label: "Surface", role: "surface", roles: ["surface"] },
      {
        id: "raised-surface",
        label: "Raised surface",
        role: "surfaceRaised",
        roles: ["surfaceRaised"],
      },
      {
        id: "overlay",
        label: "Overlay",
        role: "surfaceOverlay",
        roles: ["surfaceOverlay"],
      },
      {
        id: "text",
        label: "Text",
        role: "text",
        roles: ["text", "toolbarForeground", "toolbarControlForeground"],
      },
      {
        id: "muted-text",
        label: "Muted text",
        role: "mutedForeground",
        roles: [
          "textMuted",
          "mutedForeground",
          "placeholder",
          "secondaryLabel",
          "iconMuted",
          "sidebarMutedForeground",
        ],
      },
      {
        id: "border",
        label: "Border",
        role: "border",
        roles: ["border", "toolbarBorder", "sidebarBorder"],
      },
      { id: "input", label: "Input", role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    title: "Brand & content",
    families: [
      {
        id: "subtle-surface",
        label: "Subtle surface",
        role: "secondary",
        roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"],
      },
      {
        id: "highlight-surface",
        label: "Highlight surface",
        role: "accentSurface",
        roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"],
      },
      {
        id: "accent",
        label: "Accent",
        role: "accent",
        roles: [
          "accent",
          "accentForeground",
          "focus",
          "update",
          "updateForeground",
          "updateSurface",
          "terminalCursor",
        ],
      },
      {
        id: "action",
        label: "Action",
        role: "messageAction",
        roles: ["messageAction", "messageActionForeground", "messageActionHover"],
      },
      {
        id: "message-surface",
        label: "Message surface",
        role: "messageSurface",
        roles: ["messageSurface", "messageForeground"],
      },
      {
        id: "code-surface",
        label: "Code surface",
        role: "codeBackground",
        roles: ["codeBackground", "codeForeground"],
      },
    ],
  },
  {
    id: "context",
    title: "Context",
    families: [
      {
        id: "sidebar-background",
        label: "Sidebar background",
        role: "sidebar",
        roles: ["sidebar", "sidebarForeground"],
      },
      {
        id: "sidebar-controls",
        label: "Sidebar controls",
        role: "sidebarControlSurface",
        roles: ["sidebarControlSurface"],
      },
      {
        id: "sidebar-selection",
        label: "Sidebar selection",
        role: "sidebarRowSelected",
        roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      },
      {
        id: "terminal-background",
        label: "Terminal background",
        role: "terminalBackground",
        roles: [
          "terminalBackground",
          "terminalForeground",
          "terminalSelection",
          "terminalScrollbar",
          "terminalScrollbarHover",
        ],
      },
    ],
  },
  {
    id: "status",
    title: "Status",
    families: [
      {
        id: "error",
        label: "Error",
        role: "error",
        roles: ["error", "errorForeground", "errorSurface"],
      },
      {
        id: "warning",
        label: "Warning",
        role: "warning",
        roles: ["warning", "warningForeground", "warningSurface"],
      },
    ],
  },
];

const THEME_EDITOR_COLOR_FAMILIES = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families);
const THEME_EDITOR_COLOR_FAMILY_BY_ROLE = new Map(
  THEME_EDITOR_COLOR_FAMILIES.flatMap((family) =>
    family.roles.map((role) => [role, family] as const),
  ),
);

function getThemeEditorColorFamily(role: ThemeColorRole): ThemeEditorColorFamily | null {
  return THEME_EDITOR_COLOR_FAMILY_BY_ROLE.get(role) ?? null;
}

type ThemeEditorColors = ThemeColors;
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

// A draft with no source theme starts as the standard T3 Code look — the
// palette on screen when no theme is installed — so creating from the default
// theme changes nothing until the user edits a color.
function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getStandardThemeColors(appearance);
  // The editor keeps the user's exact picks and derives the rest through the
  // perceptual vivid engine, so a two-color theme carries its own identity.
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      /** Set when a create merged its palette into an existing theme. */
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  /** The theme a new theme starts from, so tuning what you already use is a
   *  matter of editing rather than rebuilding. Null starts from the defaults. */
  seedTheme?: ThemeDefinition | null;
  /** Prefilled name for an explicit duplicate; a plain create stays unnamed. */
  seedName?: string | undefined;
  /** Reapplies the stored theme once the draft stops being previewed. */
  restoreTheme: () => void;
}) {
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  // Null parks the panel at its default corner; a value is a dragged spot,
  // kept clamped so the header can always be grabbed again.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // Null keeps the responsive default size; a value is a corner-grip resize.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    // Where the panel's top-left sits: the grip only moves the opposite
    // corner, so the room to grow is measured from here.
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    // A panel sized wider than the window can no longer be clamped back into
    // view by position alone -- its right edge (close, minimize, the grip)
    // stays off screen. So the size shrinks to fit first, then the position
    // is re-clamped against the new size.
    const clamp = () => {
      const margin = 8;
      let clampedWidth: number | undefined;
      let clampedHeight: number | undefined;
      setSize((current) => {
        if (!current) return current;
        clampedWidth = Math.max(280, Math.min(current.width, window.innerWidth - margin * 2));
        clampedHeight = Math.max(220, Math.min(current.height, window.innerHeight - margin * 2));
        return { width: clampedWidth, height: clampedHeight };
      });
      setPosition((current) => {
        if (!current) return current;
        const clamped = clampPosition(current.x, current.y, clampedWidth);
        // Dragging may park the panel with only its header showing, but a
        // window resize should pull the whole thing back into view when it
        // fits -- otherwise the grip ends up below the fold. Minimized, the
        // stored height is not applied (the panel hugs its header), so the
        // rendered height is what has to fit.
        const height = isMinimized
          ? (panelRef.current?.offsetHeight ?? 0)
          : (clampedHeight ?? panelRef.current?.offsetHeight ?? 0);
        const maxY = Math.max(margin, window.innerHeight - height - margin);
        return { x: clamped.x, y: Math.min(clamped.y, maxY) };
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [isMinimized, open]);

  // The draft only reaches the live app once this open has been seeded;
  // previewing in the seeding commit would paint the previous session's
  // colors for a frame.
  const [isDraftSeeded, setIsDraftSeeded] = useState(false);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      // Editing works on the theme itself; creating starts from the theme
      // that is currently in use, so tuning what you already run is an edit
      // away instead of a rebuild from the defaults.
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;
      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Themes saved by the guided editor carry the managed flag; anything
      // else (imports, hand-edited files, older saves) opens in advanced mode
      // so guided regeneration cannot silently discard hand-tuned colors. A
      // seeded new theme follows the same rule: its palette is only safe to
      // regenerate when the guided editor produced it.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setColorsByAppearance(nextColors);
      setSelectedRole(null);
      setUsageCount(null);
      setIsInspecting(false);
      setError(null);
      setIsDraftSeeded(true);
    }
    if (!open && isDraftSeeded) setIsDraftSeeded(false);
    previousOpenRef.current = open;
  }, [editingTheme, initialAppearance, isDraftSeeded, open, seedName, seedTheme]);

  // A name an installed theme already uses combines instead of failing:
  // creating adds the new palette to that theme, and renaming an existing
  // theme onto it folds the edited palette in and retires the old entry —
  // light "My Theme" plus a dark "My Theme" become one theme with both modes.
  // Labels are matched as well as derived ids: a rename keeps a theme's
  // original id, so its label is the only name a user can see and retype.
  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();
  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  // The appearance a mode button would produce can be blocked two ways: the
  // merge target already has that palette, or the theme being edited never
  // had it (adding one is a create-with-same-name away).
  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return `“${editingTheme?.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return `“${mergeTarget?.label}” already has a ${appearance} palette.`;
    }
    return null;
  };

  // Typing a name whose theme already owns the selected appearance flips the
  // draft to the free side, so the merge affordance works without a manual
  // toggle. Both sides taken leaves the selection alone; save is blocked with
  // an explanation instead.
  const mergeTargetId = mergeTarget?.id ?? null;
  const takenAppearancesKey = takenAppearances.join(",");
  useEffect(() => {
    if (isEditing || mergeTargetId === null) return;
    const taken = takenAppearancesKey.split(",").filter(Boolean) as ThemeAppearance[];
    if (taken.length !== 1) return;
    setActiveAppearance((current) => {
      if (!taken.includes(current)) return current;
      return taken[0] === "light" ? "dark" : "light";
    });
  }, [isEditing, mergeTargetId, takenAppearancesKey]);

  // The whole app wears the draft while the editor is open, so a role change
  // is judged on the real interface rather than a miniature. The stored theme
  // comes back when the editor closes, including on cancel.
  useEffect(() => {
    if (!open || !isDraftSeeded) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, isDraftSeeded, open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = useCallback(
    (role: ThemeColorRole, value: string) => {
      setColorsByAppearance((current) => {
        const nextColors = { ...current[activeAppearance], [role]: value };
        const shouldManageColors =
          !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

        return {
          ...current,
          [activeAppearance]: isAdvanced
            ? updateThemeColorFamily(activeAppearance, current[activeAppearance], role, value)
            : shouldManageColors
              ? getManagedEditorColors(activeAppearance, nextColors)
              : nextColors,
        };
      });
      if (!isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
        setSimpleColorsDirtyByAppearance((current) => ({
          ...current,
          [activeAppearance]: true,
        }));
      }
    },
    [activeAppearance, isAdvanced],
  );

  const selectThemeRole = useCallback((role: ThemeColorRole, reveal = false) => {
    const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
    setSelectedRole(visibleRole);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector(`[data-theme-color-role="${visibleRole}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const toggleThemeRole = useCallback((role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  }, []);

  const clearInspectorSelection = useCallback(() => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  }, []);

  const selectedHighlightRoles = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.roles ?? [selectedRole])
      : THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(
            (role) =>
              colorsByAppearance[activeAppearance][role].trim().toLowerCase() ===
              colorsByAppearance[activeAppearance][selectedRole].trim().toLowerCase(),
          )
        : [selectedRole]
    : [];
  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  useEffect(() => {
    clearThemeInspectorHighlights();
    if (!open || selectedRole === null) {
      setUsageCount(null);
      return;
    }
    // Picking a new element needs the unobscured app, so suspend the existing
    // spotlight while the picker is armed.
    if (isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // A refresh snapshots computed styles for the whole tree twice, so it is
    // throttled rather than run per frame: a streaming reply or a virtualized
    // list mutates the DOM continuously and would otherwise stall the main
    // thread for as long as the inspector is open.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();
    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));
      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };
      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }
      scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;
    const scheduleSpotlightRefresh = () => {
      spotlightFrame ??= requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  useEffect(() => {
    if (!open || !isInspecting) {
      clearThemeInspectorHover();
      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(
        inspection,
        getThemeEditorColorFamily(inspection.role)?.label ?? getThemeRoleLabel(inspection.role),
      );
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }

      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }

      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      selectThemeRole(inspection.role, true);
      shouldDisarmAfterClick = true;
    };
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearHover();
      clearInspectorSelection();
    };
    const refreshHover = () => {
      if (!hoverInspection) return;
      hoverFrame ??= requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection) {
          showThemeInspectorHover(
            hoverInspection,
            getThemeEditorColorFamily(hoverInspection.role)?.label ??
              getThemeRoleLabel(hoverInspection.role),
          );
        }
      });
    };
    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [clearInspectorSelection, isInspecting, open, selectThemeRole]);

  const handleAdvancedChange = useCallback(
    (checked: boolean) => {
      setIsAdvanced(checked);
      if (checked) return;
      if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
        setSelectedRole(null);
      }

      // Regenerate every appearance the theme will save, not just the visible
      // one, so the palettes shown after toggling match what gets saved.
      const managedAppearances: ReadonlyArray<ThemeAppearance> =
        editingTheme && getThemeModes(editingTheme).length > 1
          ? ["light", "dark"]
          : [activeAppearance];
      setSimpleColorsDirtyByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) next[appearance] = true;
        return next;
      });
      setColorsByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) {
          next[appearance] = getManagedEditorColors(appearance, current[appearance]);
        }
        return next;
      });
    },
    [activeAppearance, editingTheme, selectedRole],
  );

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name your theme first.");
      return;
    }

    try {
      // Only regenerate palettes the user actually touched in guided mode, so
      // untouched appearances save exactly what the editor displayed.
      const colorsForSave = !isAdvanced
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;
      if (editingTheme && mergeTarget) {
        // Renamed onto another installed theme: this theme's palettes fold
        // into it and the edited entry retires, so both cards become one.
        // Colliding palettes cannot merge — neither side should be silently
        // overwritten.
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(`“${mergeTarget.label}” already has a ${collision} palette. Pick another name.`);
          return;
        }
        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
        retiredTheme = editingTheme;
        try {
          removeCustomTheme(editingTheme.id);
        } catch (cause) {
          // The merge already persisted. Leaving it while the edited theme
          // survives would collide on every retry, so the target goes back to
          // its pre-merge palettes before the failure surfaces.
          try {
            updateCustomTheme(mergeTarget);
          } catch {
            // Storage is failing wholesale; the rethrow below reports it.
          }
          throw cause;
        }
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(isAdvanced ? {} : { managed: true }),
          }),
          ...(editingTheme.collection ? { collection: editingTheme.collection } : {}),
        });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(
            `“${mergeTarget.label}” already has light and dark palettes. Pick another name.`,
          );
          return;
        }
        // The new palette joins the existing theme as its other mode; its
        // stored palettes are untouched. The guided (managed) flag only
        // survives when every palette in the theme came from the guided
        // editor.
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(isAdvanced ? {} : { managed: true }),
          }),
        );
      }
      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          // Roll the install back so a retry can run it again instead of
          // failing on the already-taken theme id.
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        } else if (mergeTarget && mergedAppearance !== null) {
          // Put the pre-merge definitions back for the same reason.
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        }
        setError("Theme saved, but it could not be made active. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? "Could not save the theme."
            : "Could not create the theme.",
      );
    }
  };

  const renderNameField = () => (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Theme name</span>
      <Input
        autoFocus
        onChange={(event) => {
          setName(event.currentTarget.value);
          // Most save failures are name collisions; retyping is the fix, so
          // the stale message goes with the old name.
          setError(null);
        }}
        placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
        value={name}
      />
    </label>
  );

  const renderAppearanceButton = (appearance: ThemeAppearance) => {
    const isActive = activeAppearance === appearance;
    const lockReason = appearanceLockReason(appearance);
    // A locked mode stays hoverable so the tooltip can say why it is off;
    // a real disabled attribute would swallow the pointer events.
    const button = (
      <Button
        aria-disabled={lockReason !== null}
        aria-pressed={isActive}
        className={lockReason !== null ? "opacity-50" : undefined}
        style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
        variant={isActive ? "secondary" : "outline"}
        onClick={() => {
          if (lockReason === null) setActiveAppearance(appearance);
        }}
      >
        {appearance === "light" ? "Light" : "Dark"}
      </Button>
    );
    if (lockReason === null) return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup>{lockReason}</TooltipPopup>
      </Tooltip>
    );
  };

  const renderAppearanceButtons = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Appearance</span>
      <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
        {renderAppearanceButton("light")}
        {renderAppearanceButton("dark")}
      </div>
    </div>
  );

  const renderColorsHeader = () => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
      <div>
        <h3 className="text-sm font-medium">Colors</h3>
        {isAdvanced ? null : (
          <p className="text-xs text-muted-foreground">Two colors, rest derived</p>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-3">
        {isAdvanced ? (
          <Input
            aria-label="Filter colors"
            className="min-w-0 flex-1"
            onChange={(event) => setRoleQuery(event.currentTarget.value)}
            placeholder="Filter colors"
            size="sm"
            value={roleQuery}
          />
        ) : null}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 pt-0.5 text-sm font-medium">
          <span>Advanced</span>
          <Switch
            aria-label="Use advanced theme colors"
            checked={isAdvanced}
            onCheckedChange={(checked) => handleAdvancedChange(Boolean(checked))}
          />
        </label>
      </div>
    </div>
  );

  const renderRoleFields = (
    families: ReadonlyArray<ThemeEditorColorFamily>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {families.map((family) => (
        <ThemeColorField
          key={family.id}
          label={family.label}
          onChange={updateColor}
          onSelect={selectThemeRole}
          onToggleSelected={toggleThemeRole}
          role={family.role}
          selected={selectedRole === family.role}
          value={colorsByAppearance[activeAppearance][family.role]}
        />
      ))}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      families: group.families.filter(
        (family) =>
          !query ||
          [family.label, ...family.roles.map((role) => getThemeRoleLabel(role))]
            .join(" ")
            .toLowerCase()
            .includes(query),
      ),
    })).filter((group) => group.families.length > 0);
    return isAdvanced ? (
      <div className="space-y-5">
        {groups.map((group) => (
          <section className="space-y-2" key={group.id}>
            <h4 className="text-sm font-medium text-foreground">{group.title}</h4>
            {renderRoleFields(group.families, "grid gap-1")}
          </section>
        ))}
        {groups.length === 0 ? <p className="text-xs text-muted-foreground">No matches.</p> : null}
      </div>
    ) : (
      <div className="grid gap-1">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={updateColor}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            label={role === "canvas" ? "Background" : "Accent"}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
    );
  };

  const clampPosition = (x: number, y: number, widthOverride?: number) => {
    const panel = panelRef.current;
    const margin = 8;
    // The caller passes a width when it has just shrunk the panel: the DOM
    // still reports the old one until React commits.
    const width = widthOverride ?? panel?.offsetWidth ?? 0;
    return {
      x: Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - width - margin)),
      // Keep at least the header on screen even when dragged far down.
      y: Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - 48)),
    };
  };

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Buttons in the header keep their own behavior.
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    setPosition(clampPosition(event.clientX - offset.dx, event.clientY - offset.dy));
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // The grip drags the bottom-right corner, so the top-left must hold
    // still; the default parking spot is anchored bottom-right and would
    // slide, so it converts to an explicit position first.
    if (position === null) setPosition(clampPosition(rect.x, rect.y));
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const margin = 8;
    const MIN_WIDTH = 280;
    const MIN_HEIGHT = 220;
    // Grow only into the space right of and below the panel's own corner,
    // otherwise a panel parked away from the top-left pushes its far edges
    // (and this grip) off screen.
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - margin - start.left);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - margin - start.top);
    setSize({
      width: Math.min(Math.max(start.width + event.clientX - start.pointerX, MIN_WIDTH), maxWidth),
      height: Math.min(
        Math.max(start.height + event.clientY - start.pointerY, MIN_HEIGHT),
        maxHeight,
      ),
    });
  };

  const endResize = () => {
    resizeStartRef.current = null;
  };

  return (
    <div
      aria-label={isEditing ? "Edit theme" : "Create theme"}
      className={cn(
        "dialog-glass fixed z-[110] flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border text-popover-foreground",
        position === null && "bottom-4 right-4",
        isMinimized && "max-h-none",
      )}
      data-theme-editor-panel
      ref={panelRef}
      role="dialog"
      style={{
        ...(position ? { left: position.x, top: position.y } : {}),
        ...(size ? { width: size.width } : {}),
        // A chosen height only applies expanded; minimized keeps hugging the
        // header. The viewport stays the ceiling either way.
        ...(size && !isMinimized ? { height: size.height, maxHeight: "calc(100dvh - 1rem)" } : {}),
      }}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1 border-b border-border/70 px-3 py-2 active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={endDrag}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">
            {isEditing ? "Edit theme" : "Create theme"}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {isInspecting
                ? "Select an element · Esc to cancel"
                : selectedRole
                  ? `${isAdvanced ? (getThemeEditorColorFamily(selectedRole)?.label ?? getThemeRoleLabel(selectedRole)) : getThemeRoleLabel(selectedRole)} · ${usageCount ?? 0} ${usageCount === 1 ? "use" : "uses"}`
                  : "Select a color below"}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={isInspecting ? "Cancel inspecting app colors" : "Inspect app colors"}
                aria-pressed={isInspecting}
                size="xs"
                variant={isInspecting ? "secondary" : "ghost"}
                onClick={() => {
                  if (isInspecting) {
                    clearInspectorSelection();
                    return;
                  }
                  setIsInspecting(true);
                }}
              >
                <MousePointer2Icon />
                {isInspecting ? "Cancel" : "Inspect"}
              </Button>
            }
          />
          <TooltipPopup data-theme-editor-panel="">
            {isInspecting ? "Cancel and clear the selection" : "Pick a color from the app"}
          </TooltipPopup>
        </Tooltip>
        <Button
          aria-label={isMinimized ? "Expand the theme editor" : "Minimize the theme editor"}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          aria-label="Close the theme editor"
          size="icon-xs"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pl-3 pr-1.5">
            {renderNameField()}
            {/* Inline and above the color list: the panel scrolls, and an
                error parked below every role would go unseen. */}
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {renderAppearanceButtons()}
            <div className="space-y-3">
              {renderColorsHeader()}
              {renderColorFields()}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  `Merge into “${mergeTarget.label}”`
                ) : (
                  "Save changes"
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {`Add ${activeAppearance} palette`}
                </>
              ) : (
                <>
                  <PlusIcon />
                  Create theme
                </>
              )}
            </Button>
          </div>
          <div
            aria-hidden
            className="absolute bottom-0 right-0 z-10 flex size-5 cursor-se-resize touch-none select-none items-end justify-end p-1 text-muted-foreground/70"
            onPointerCancel={endResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
          >
            <svg
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
              viewBox="0 0 8 8"
            >
              <path d="M7 1 1 7M7 4.5 4.5 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
