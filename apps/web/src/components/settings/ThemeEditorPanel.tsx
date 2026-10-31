import {
  CrosshairIcon,
  PaintbrushIcon,
  PaletteIcon,
  PipetteIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import {
  useEffect,
  useLayoutEffect,
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
import { useViewportSize } from "../../hooks/useViewportSize";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getThemeRoleLabel,
  ThemeColorField,
  ThemeColorHexInput,
  ThemeColorPopover,
} from "./ThemeColorPicker";
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

// The strip under the two guided picks previews the palette they derive.
const THEME_EDITOR_DERIVED_STRIP_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "surface",
  "surfaceRaised",
  "input",
  "border",
  "mutedForeground",
  "text",
  "accent",
  "warning",
  "error",
];

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
    id: "sidebar",
    title: "Sidebar",
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
    ],
  },
  {
    id: "brand-content",
    title: "Brand & content",
    families: [
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
    id: "search",
    title: "Search",
    families: [
      {
        id: "search-matches",
        label: "Search matches",
        role: "searchMatchBackground",
        roles: ["searchMatchBackground", "searchMatchForeground"],
      },
      {
        id: "current-match",
        label: "Current match",
        role: "searchMatchActiveBackground",
        roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"],
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
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

const PANEL_MARGIN = 8;
const PANEL_MIN_WIDTH = 280;
const PANEL_MIN_HEIGHT = 220;

/** Keeps the panel horizontally inside the viewport. Vertically only its header must stay
 * visible, so users can park the panel low to see the app behind it. */
function clampPanelPosition(
  viewport: { readonly width: number; readonly height: number },
  x: number,
  y: number,
  width: number,
) {
  const maxX = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, viewport.height - 48);
  return {
    x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
    y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
  };
}

const readWindowViewport = () => ({ width: window.innerWidth, height: window.innerHeight });

// Kept out of the component: the compiler cannot lower a throw inside try/catch.
function retireMergedTheme(retired: ThemeDefinition, mergeTarget: ThemeDefinition) {
  try {
    removeCustomTheme(retired.id);
  } catch (cause) {
    // Restore the pre-merge target on retirement failure; leaving the persisted merge would collide on retry.
    try {
      updateCustomTheme(mergeTarget);
    } catch {}
    throw cause;
  }
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
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  seedTheme?: ThemeDefinition | null;
  seedName?: string | undefined;
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
  const [shouldRegenerateGuidedColors, setShouldRegenerateGuidedColors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  // The rendered width is CSS-sized unless the user resized the panel, so the position
  // remembers the width measured at the last drag or resize.
  const [position, setPosition] = useState<{ x: number; y: number; width: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const colorEditSnapshotRef = useRef<{
    colorsByAppearance: ThemeEditorColorsByAppearance;
    simpleColorsDirtyByAppearance: Record<ThemeAppearance, boolean>;
    shouldRegenerateGuidedColors: boolean;
  } | null>(null);
  // Read while rendering, before the name field's autofocus moves focus in: what opened the
  // editor (Create theme, Edit). Closing hands focus back to it while it is still on the page.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Return focus before unmount removes the focused editor control.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    return () => {
      if (opener?.isConnected && panel?.contains(document.activeElement)) opener.focus();
    };
  }, [opener]);
  const dragOffsetRef = useRef<{ dx: number; dy: number; width: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // Seed during render so the first open frame cannot preview the previous session's colors.
  const [seededOpen, setSeededOpen] = useState(false);
  if (seededOpen !== open) {
    setSeededOpen(open);
    if (open) {
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
      // Open unmanaged themes in advanced mode to preserve imported or hand-tuned colors.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setShouldRegenerateGuidedColors(sourceTheme !== null && sourceTheme.managed !== true);
      setColorsByAppearance(nextColors);
      setSelectedRole(null);
      setUsageCount(null);
      setIsInspecting(false);
      setError(null);
    }
  }

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

  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return `“${editingTheme?.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return `“${mergeTarget?.label}” already has a ${appearance} palette.`;
    }
    return null;
  };

  const mergeKey =
    isEditing || mergeTarget === null ? null : `${mergeTarget.id}:${takenAppearances.join(",")}`;
  const [appliedMergeKey, setAppliedMergeKey] = useState<string | null>(null);
  if (appliedMergeKey !== mergeKey) {
    setAppliedMergeKey(mergeKey);
    if (
      mergeKey !== null &&
      takenAppearances.length === 1 &&
      takenAppearances.includes(activeAppearance)
    ) {
      setActiveAppearance(takenAppearances[0] === "light" ? "dark" : "light");
    }
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the edited colors to the document as a live theme preview while the editor is open
  useEffect(() => {
    if (!open) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the document theme when the editor closes or unmounts
  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = (role: ThemeColorRole, value: string) => {
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
    if (isAdvanced) setShouldRegenerateGuidedColors(true);
  };

  // A color edit also rewrites derived roles, so cancelling restores the whole snapshot rather than
  // replaying the previous value through updateColor.
  const startColorEdit = () => {
    colorEditSnapshotRef.current = {
      colorsByAppearance,
      simpleColorsDirtyByAppearance,
      shouldRegenerateGuidedColors,
    };
  };

  const cancelColorEdit = () => {
    const snapshot = colorEditSnapshotRef.current;
    colorEditSnapshotRef.current = null;
    if (!snapshot) return;
    setColorsByAppearance(snapshot.colorsByAppearance);
    setSimpleColorsDirtyByAppearance(snapshot.simpleColorsDirtyByAppearance);
    setShouldRegenerateGuidedColors(snapshot.shouldRegenerateGuidedColors);
  };

  const selectThemeRole = (role: ThemeColorRole, reveal = false) => {
    const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
    setSelectedRole(visibleRole);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current?.querySelector(`[data-theme-color-role="${visibleRole}"]`)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "nearest",
      });
    });
  };

  const toggleThemeRole = (role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  };

  const clearInspectorSelection = () => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  };

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- highlights role usage in the DOM, refreshed by a MutationObserver and resize and scroll listeners
  useEffect(() => {
    clearThemeInspectorHighlights();
    if (!open || selectedRole === null || isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // Each refresh snapshots the whole tree twice; throttle streaming and virtualization mutations.
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
      if (spotlightFrame !== null) return;
      spotlightFrame = requestAnimationFrame(() => {
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
      setUsageCount(null);
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document pointer, click and key listeners that drive the inspect-mode hover overlay
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
      if (
        event.target instanceof Element &&
        event.target.closest("[data-theme-editor-panel][data-slot=popover-popup]")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      clearInspectorSelection();
    };
    const refreshHover = () => {
      if (!hoverInspection || hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
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

  const handleAdvancedChange = (checked: boolean) => {
    setIsAdvanced(checked);
    if (checked) return;
    if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
      setSelectedRole(null);
    }
    if (!shouldRegenerateGuidedColors) return;

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
    setShouldRegenerateGuidedColors(false);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name your theme first.");
      return;
    }

    try {
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
        retireMergedTheme(editingTheme, mergeTarget);
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
          try {
            removeCustomTheme(savedTheme.id);
          } catch {}
        } else if (mergeTarget && mergedAppearance !== null) {
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {}
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
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-dim-foreground">Theme name</span>
      <Input
        autoFocus
        size="sm"
        onChange={(event) => {
          setName(event.currentTarget.value);
          setError(null);
        }}
        placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
        value={name}
      />
    </label>
  );

  const renderAppearanceButton = (appearance: ThemeAppearance) => {
    const lockReason = appearanceLockReason(appearance);
    // Use aria-disabled so locked modes remain hoverable for explanatory tooltips.
    const button = (
      <Toggle aria-disabled={lockReason !== null} value={appearance}>
        {appearance === "light" ? "Light" : "Dark"}
      </Toggle>
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
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-dim-foreground">Appearance</span>
      <ToggleGroup
        aria-label="Theme appearance"
        variant="segmented"
        value={[activeAppearance]}
        onValueChange={(next) => {
          const appearance = next[0];
          if (
            (appearance === "light" || appearance === "dark") &&
            appearanceLockReason(appearance) === null
          ) {
            setActiveAppearance(appearance);
          }
        }}
      >
        {renderAppearanceButton("light")}
        {renderAppearanceButton("dark")}
      </ToggleGroup>
    </div>
  );

  const renderAdvancedSwitch = () => (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-body text-foreground">
      <span>Use advanced theme colors</span>
      <Switch
        aria-label="Use advanced theme colors"
        checked={isAdvanced}
        onCheckedChange={(checked) => handleAdvancedChange(Boolean(checked))}
      />
    </label>
  );

  const activeColors = colorsByAppearance[activeAppearance];

  // A half-typed or mistyped value blocks saving until it is fixed. The active
  // palette is reported first since that is the one on screen.
  const invalidColor = (
    [activeAppearance, activeAppearance === "light" ? "dark" : "light"] as const
  ).flatMap((appearance) =>
    THEME_COLOR_ROLES.filter(
      (role) => !isThemeEditorColor(colorsByAppearance[appearance][role]),
    ).map((role) => ({ appearance, role })),
  )[0];

  const renderSimpleColors = () => (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-xs text-dim-foreground">
        <span className="font-medium">Colors</span>
        <span>Two colors, rest derived</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => {
          const label = role === "canvas" ? "Background" : "Accent";
          const value = activeColors[role];
          const swatchValue = isThemeColor(value) ? value : "#000000";
          return (
            <div
              className={cn(
                "surface-well flex min-w-0 flex-col gap-2 rounded-lg p-2.5",
                selectedRole === role && "ring-1 ring-ring",
              )}
              data-theme-color-role={role}
              key={role}
            >
              <ThemeColorPopover
                onEditCancel={cancelColorEdit}
                onEditStart={startColorEdit}
                label={label}
                onChange={(nextValue) => updateColor(role, nextValue)}
                value={swatchValue}
                trigger={
                  <button
                    aria-label={`Choose ${label} color`}
                    className="group flex h-11 w-full cursor-pointer outline-none"
                    onFocus={() => selectThemeRole(role)}
                    onPointerDown={() => selectThemeRole(role)}
                    type="button"
                  >
                    <span
                      className={cn(
                        "size-full rounded-item border group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring",
                        isThemeColor(value)
                          ? "border-foreground/12"
                          : "border-dashed border-destructive/70",
                      )}
                      style={isThemeColor(value) ? { backgroundColor: swatchValue } : undefined}
                    />
                  </button>
                }
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <button
                  aria-label={`${selectedRole === role ? "Hide" : "Show"} ${label} usage`}
                  aria-pressed={selectedRole === role}
                  className="group cursor-pointer self-start text-left outline-none"
                  onClick={() => toggleThemeRole(role)}
                  type="button"
                >
                  <span className="rounded-sm text-meta text-foreground group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring">
                    {label}
                  </span>
                </button>
                <ThemeColorHexInput
                  label={label}
                  onChange={(nextValue) => updateColor(role, nextValue)}
                  onFocus={() => selectThemeRole(role)}
                  value={value}
                />
              </div>
            </div>
          );
        })}
      </div>
      {/* What the two picks derive: the guided engine fills every other role. */}
      <div aria-hidden className="flex h-3.5 gap-0.5 overflow-hidden rounded-kbd">
        {THEME_EDITOR_DERIVED_STRIP_ROLES.map((role) => (
          <span className="flex-1" key={role} style={{ backgroundColor: activeColors[role] }} />
        ))}
      </div>
    </div>
  );

  const renderAdvancedColors = () => {
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
    return (
      <>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Filter colors"
            onChange={(event) => setRoleQuery(event.currentTarget.value)}
            placeholder="Filter colors"
            type="search"
            value={roleQuery}
          />
        </InputGroup>
        {groups.map((group) => (
          <section className="flex flex-col gap-0.5" key={group.id}>
            <h4 className="pb-0.5 text-caption text-dim-foreground">{group.title}</h4>
            {group.families.map((family) => (
              <ThemeColorField
                key={family.id}
                label={family.label}
                onChange={updateColor}
                onEditCancel={cancelColorEdit}
                onEditStart={startColorEdit}
                onSelect={selectThemeRole}
                onToggleSelected={toggleThemeRole}
                role={family.role}
                selected={selectedRole === family.role}
                value={activeColors[family.role]}
              />
            ))}
          </section>
        ))}
        {groups.length === 0 ? <p className="text-xs text-muted-foreground">No matches.</p> : null}
      </>
    );
  };

  // Geometry is stored as the user left it and fitted to the current viewport here, so a
  // window that shrinks and grows back returns the panel to where it was.
  const viewport = useViewportSize();
  const shownSize = size && {
    width: Math.max(PANEL_MIN_WIDTH, Math.min(size.width, viewport.width - PANEL_MARGIN * 2)),
    height: Math.max(PANEL_MIN_HEIGHT, Math.min(size.height, viewport.height - PANEL_MARGIN * 2)),
  };
  const shownPosition =
    position &&
    clampPanelPosition(viewport, position.x, position.y, shownSize?.width ?? position.width);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = {
      dx: event.clientX - rect.x,
      dy: event.clientY - rect.y,
      width: rect.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    const next = clampPanelPosition(
      readWindowViewport(),
      event.clientX - offset.dx,
      event.clientY - offset.dy,
      offset.width,
    );
    setPosition({ ...next, width: offset.width });
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // Resize from where the panel is drawn, so a position clamped after the window shrank, or bottom-right
    // parking, can't make the top-left corner slide.
    const next = clampPanelPosition(readWindowViewport(), rect.x, rect.y, rect.width);
    setPosition({ ...next, width: rect.width });
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
    const maxWidth = Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MARGIN - start.left);
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_MARGIN - start.top);
    setSize({
      width: Math.min(
        Math.max(start.width + event.clientX - start.pointerX, PANEL_MIN_WIDTH),
        maxWidth,
      ),
      height: Math.min(
        Math.max(start.height + event.clientY - start.pointerY, PANEL_MIN_HEIGHT),
        maxHeight,
      ),
    });
  };

  const endResize = () => {
    resizeStartRef.current = null;
  };

  const selectedLabel = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.label ?? getThemeRoleLabel(selectedRole))
      : getThemeRoleLabel(selectedRole)
    : null;
  const pillText = isInspecting
    ? "Select an element · Esc to cancel"
    : selectedLabel
      ? `${selectedLabel} · ${usageCount ?? 0} ${usageCount === 1 ? "use" : "uses"}`
      : null;

  return (
    <>
      {pillText ? (
        <div
          aria-live="polite"
          className="surface-popover pointer-events-none fixed left-1/2 top-3.5 z-[110] flex h-7.5 -translate-x-1/2 items-center gap-2 rounded-full border px-3 text-xs text-foreground"
          data-theme-editor-panel
        >
          <CrosshairIcon aria-hidden className="size-3.5" />
          {pillText}
        </div>
      ) : null}
      <div
        aria-label={isEditing ? "Edit theme" : "Create theme"}
        className={cn(
          "surface-popover fixed z-[110] flex max-h-[min(42rem,calc(100dvh-4.5rem))] w-[min(21.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border text-popover-foreground",
          position === null && "right-5 top-13",
          isMinimized && "max-h-none",
        )}
        data-docked={position === null ? "" : undefined}
        data-theme-editor-panel
        ref={panelRef}
        role="dialog"
        onKeyDown={(event) => {
          // Escape a popover or the inspector consumed, or one from a portaled popup, stays theirs.
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (!(event.target instanceof Node && event.currentTarget.contains(event.target))) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
        style={{
          ...(shownPosition ? { left: shownPosition.x, top: shownPosition.y } : {}),
          ...(shownSize ? { width: shownSize.width } : {}),
          ...(shownSize && !isMinimized
            ? { height: shownSize.height, maxHeight: "calc(100dvh - 1rem)" }
            : {}),
        }}
      >
        <div
          className={cn(
            // pe-2: the ghost icon buttons hang 8px so the close glyph ends on the content line.
            "flex cursor-grab touch-none select-none items-center gap-2 ps-4 pe-2 pt-4 active:cursor-grabbing",
            isMinimized && "pb-3.5",
          )}
          onPointerCancel={endDrag}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={endDrag}
        >
          <PaletteIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-label text-foreground">
            {isEditing ? "Edit theme" : "Create theme"}
          </h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={isInspecting ? "Cancel inspecting app colors" : "Inspect app colors"}
                  aria-pressed={isInspecting}
                  size="icon-xs"
                  variant={isInspecting ? "secondary" : "ghost"}
                  onClick={() => {
                    if (isInspecting) {
                      clearInspectorSelection();
                      return;
                    }
                    setIsInspecting(true);
                  }}
                >
                  <PipetteIcon />
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
            <MorphIcon icon={isMinimized ? Maximize2 : Minimize2} />
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
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-1",
                isAdvanced ? "gap-3" : "gap-4",
              )}
            >
              {renderNameField()}
              {error ? (
                <p aria-live="polite" className="text-body text-destructive">
                  {error}
                </p>
              ) : invalidColor ? (
                <p aria-live="polite" className="text-body text-destructive">
                  {`“${invalidColor.role === "canvas" && !isAdvanced ? "Background" : getThemeRoleLabel(invalidColor.role)}” isn’t a valid color${invalidColor.appearance === activeAppearance ? "" : ` in the ${invalidColor.appearance} palette`}. Use a hex like #1A1B26.`}
                </p>
              ) : null}
              {renderAppearanceButtons()}
              {isAdvanced ? renderAdvancedColors() : renderSimpleColors()}
              {renderAdvancedSwitch()}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-3.5">
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!name.trim() || invalidColor !== undefined}
                size="sm"
                onClick={handleSubmit}
              >
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
                    <PaintbrushIcon />
                    Create theme
                  </>
                )}
              </Button>
            </div>
            <div
              aria-hidden
              className="absolute bottom-0 right-0 z-10 flex size-5 cursor-se-resize touch-none select-none items-end justify-end p-1 text-dim-foreground"
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
    </>
  );
}
