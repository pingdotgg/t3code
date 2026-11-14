import type { ThemeEditorStateProps } from "./useThemeEditorState";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import {
  getManagedEditorColors,
  getThemeEditorColorFamily,
  getThemeEditorColorsByAppearance,
  getThemeEditorDefaults,
  isThemeEditorColor,
  retireMergedTheme,
  THEME_EDITOR_SIMPLE_ROLES,
  type ThemeEditorColorFamily,
  type ThemeEditorColorsByAppearance,
} from "./themeEditorModel";
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
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
export function useThemeEditorStatePart1(props: ThemeEditorStateProps) {
  const { editingTheme, initialAppearance, open, seedTheme, seedName, restoreTheme } = props;
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

  return { isEditing, name, setName, activeAppearance, setActiveAppearance, isAdvanced, setIsAdvanced, colorsByAppearance, setColorsByAppearance, simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance, shouldRegenerateGuidedColors, setShouldRegenerateGuidedColors, error, setError, isMinimized, setIsMinimized, roleQuery, setRoleQuery, isInspecting, setIsInspecting, selectedRole, setSelectedRole, usageCount, setUsageCount, position, setPosition, size, setSize, panelRef, colorEditSnapshotRef, dragOffsetRef, resizeStartRef, seededOpen, setSeededOpen, nameTargetId, normalizedName, mergeTarget, takenAppearances, editableAppearances, appearanceLockReason, mergeKey, appliedMergeKey, setAppliedMergeKey, updateColor, startColorEdit, cancelColorEdit, selectThemeRole, toggleThemeRole, clearInspectorSelection, selectedHighlightRoles, selectedHighlightRolesKey, handleAdvancedChange };
}
