import {
  resolveThemeSource,
  themeSourceForEditing,
  themeSourceFromColors,
  setThemeSourceRole,
} from "@t3tools/shared/themeResolution";
import type { ThemeSource } from "@t3tools/shared/themePalettes";
import { MousePointer2Icon, PaintbrushIcon, PlusIcon, XIcon } from "lucide-react";
import { ChevronDown, ChevronUp } from "lucide";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
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
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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
        roles: ["terminalBackground", "terminalForeground", "terminalSelection"],
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

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

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

function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
}

function guidedThemeSource(colors: ThemeColors): ThemeSource {
  return { version: 2, seed: { canvas: colors.canvas, accent: colors.accent } };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
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
  const [sourcesByAppearance, setSourcesByAppearance] = useState<
    Record<ThemeAppearance, ThemeSource>
  >(() => ({
    light: guidedThemeSource(getThemeEditorDefaults("light")),
    dark: guidedThemeSource(getThemeEditorDefaults("dark")),
  }));
  const colorsByAppearance = {
    light: resolveThemeSource(sourcesByAppearance.light, "light"),
    dark: resolveThemeSource(sourcesByAppearance.dark, "dark"),
  };
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
    sourcesByAppearance: Record<ThemeAppearance, ThemeSource>;
  } | null>(null);
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
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Open unmanaged themes in advanced mode to preserve imported or hand-tuned colors.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      const sourceFor = (appearance: ThemeAppearance) =>
        sourceTheme
          ? themeSourceForEditing(sourceTheme, appearance)
          : guidedThemeSource(getThemeEditorDefaults(appearance));
      setSourcesByAppearance({ light: sourceFor("light"), dark: sourceFor("dark") });
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
    if (!isThemeEditorColor(value)) return;
    setSourcesByAppearance((current) => {
      const source = current[activeAppearance];
      if (isAdvanced) {
        return { ...current, [activeAppearance]: setThemeSourceRole(source, role, value) };
      }
      // Guided edits move a seed; the seeded role then inherits it instead of a stale value.
      const colors = resolveThemeSource(source, activeAppearance);
      const seeded = {
        ...source,
        seed: {
          canvas: source.seed?.canvas ?? colors.canvas,
          accent: source.seed?.accent ?? colors.accent,
          [role]: value,
        },
      };
      return { ...current, [activeAppearance]: setThemeSourceRole(seeded, role, null) };
    });
  };

  const startColorEdit = () => {
    colorEditSnapshotRef.current = { sourcesByAppearance };
  };

  const cancelColorEdit = () => {
    const snapshot = colorEditSnapshotRef.current;
    colorEditSnapshotRef.current = null;
    if (snapshot) setSourcesByAppearance(snapshot.sourcesByAppearance);
  };

  const selectThemeRole = (role: ThemeColorRole, reveal = false) => {
    setSelectedRole(role);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(role)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;

    requestAnimationFrame(() => {
      panelRef.current?.querySelector(`[data-theme-color-role="${role}"]`)?.scrollIntoView({
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
      event.preventDefault();
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
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name your theme first.");
      return;
    }

    try {
      const colorsForSave = colorsByAppearance;
      const sourcesForSave = {
        ...Object.fromEntries(
          mergeTarget
            ? getThemeModes(mergeTarget).map((mode) => [
                mode,
                mergeTarget.sources?.[mode] ??
                  themeSourceFromColors(getThemeColorsForMode(mergeTarget, mode)!),
              ])
            : [],
        ),
        ...Object.fromEntries(
          (editingTheme ? getThemeModes(editingTheme) : [activeAppearance]).map((mode) => [
            mode,
            sourcesByAppearance[mode],
          ]),
        ),
      };

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
            version: 2,
            sources: sourcesForSave,
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
            version: 2,
            sources: sourcesForSave,
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
            version: 2,
            sources: sourcesForSave,
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
            version: 2,
            sources: sourcesForSave,
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
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Theme name</span>
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
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Appearance</span>
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
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              setSourcesByAppearance((current) => ({
                ...current,
                [activeAppearance]: {
                  version: 2,
                  ...(current[activeAppearance].seed
                    ? { seed: current[activeAppearance].seed }
                    : {}),
                },
              }))
            }
          >
            Reset {activeAppearance}
          </Button>
        ) : null}
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

  const resetRole = (role: ThemeColorRole) =>
    setSourcesByAppearance((current) => ({
      ...current,
      [activeAppearance]: setThemeSourceRole(current[activeAppearance], role, null),
    }));
  const source = sourcesByAppearance[activeAppearance];
  const roleIsExplicit = (role: ThemeColorRole) =>
    source.overrides?.[role] !== undefined || source.palette?.[role] !== undefined;

  const renderRoleFields = (
    families: ReadonlyArray<ThemeEditorColorFamily>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {families.map((family) => {
        const query = roleQuery.trim().toLowerCase();
        const exactRole = query
          ? family.roles.find(
              (role) =>
                role.toLowerCase() === query || getThemeRoleLabel(role).toLowerCase() === query,
            )
          : undefined;
        const role =
          exactRole ??
          (selectedRole && family.roles.includes(selectedRole) ? selectedRole : family.role);
        const pinnedRoles = family.roles.filter(
          (sibling) => sibling !== family.role && roleIsExplicit(sibling),
        );
        return (
          <ThemeColorField
            key={family.id}
            label={role === family.role ? family.label : getThemeRoleLabel(role)}
            explicit={roleIsExplicit(role)}
            pinnedRoles={pinnedRoles}
            onResetFamily={() =>
              setSourcesByAppearance((current) => ({
                ...current,
                [activeAppearance]: pinnedRoles.reduce(
                  (source, sibling) => setThemeSourceRole(source, sibling, null),
                  current[activeAppearance],
                ),
              }))
            }
            onReset={() => resetRole(role)}
            resetSource={
              role === family.role
                ? source.seed
                  ? "guided colors"
                  : "T3 Chat defaults"
                : family.label
            }
            onChange={updateColor}
            onEditCancel={cancelColorEdit}
            onEditStart={startColorEdit}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        );
      })}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      families: group.families.filter(
        (family) =>
          !query ||
          [family.label, ...family.roles, ...family.roles.map((role) => getThemeRoleLabel(role))]
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
            onEditCancel={cancelColorEdit}
            onEditStart={startColorEdit}
            onSelect={selectThemeRole}
            onToggleSelected={toggleThemeRole}
            role={role}
            label={role === "canvas" ? "Background" : "Accent"}
            explicit={roleIsExplicit(role)}
            onReset={() => resetRole(role)}
            resetSource={source.seed ? "guided colors" : "T3 Chat defaults"}
            selected={selectedRole === role}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
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
        ...(shownPosition ? { left: shownPosition.x, top: shownPosition.y } : {}),
        ...(shownSize ? { width: shownSize.width } : {}),
        ...(shownSize && !isMinimized
          ? { height: shownSize.height, maxHeight: "calc(100dvh - 1rem)" }
          : {}),
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
          <MorphIcon icon={isMinimized ? ChevronUp : ChevronDown} />
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
                  <PaintbrushIcon />
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
