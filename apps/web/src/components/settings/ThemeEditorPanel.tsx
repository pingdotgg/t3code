import { MousePointer2Icon, PaintbrushIcon, PlusIcon, XIcon } from "lucide-react";
import { ChevronDown, ChevronUp } from "lucide";
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
import { THEME_EDITOR_ROLE_GROUPS } from "./ThemeEditorPanelParts";
import {
  clampPanelPosition,
  getManagedEditorColors,
  getThemeEditorColorFamily,
  getThemeEditorColorsByAppearance,
  getThemeEditorDefaults,
  isThemeEditorColor,
  PANEL_MARGIN,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  readWindowViewport,
  retireMergedTheme,
  THEME_EDITOR_COLOR_FAMILIES,
  THEME_EDITOR_SIMPLE_ROLES,
  type ThemeEditorColorFamily,
  type ThemeEditorColorsByAppearance,
} from "./themeEditorModel";

export type { ThemeEditorColorFamily } from "./themeEditorModel";
import { useThemeEditorState } from "./useThemeEditorState";

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
  const {
    activeAppearance,
    appearanceLockReason,
    appliedMergeKey,
    cancelColorEdit,
    clearInspectorSelection,
    colorEditSnapshotRef,
    colorsByAppearance,
    dragOffsetRef,
    editableAppearances,
    error,
    handleAdvancedChange,
    handleSubmit,
    isAdvanced,
    isEditing,
    isInspecting,
    isMinimized,
    mergeKey,
    mergeTarget,
    name,
    nameTargetId,
    normalizedName,
    panelRef,
    position,
    renderAppearanceButton,
    renderAppearanceButtons,
    renderColorFields,
    renderColorsHeader,
    renderNameField,
    renderRoleFields,
    resizeStartRef,
    roleQuery,
    seededOpen,
    selectThemeRole,
    selectedHighlightRoles,
    selectedHighlightRolesKey,
    selectedRole,
    setActiveAppearance,
    setAppliedMergeKey,
    setColorsByAppearance,
    setError,
    setIsAdvanced,
    setIsInspecting,
    setIsMinimized,
    setName,
    setPosition,
    setRoleQuery,
    setSeededOpen,
    setSelectedRole,
    setShouldRegenerateGuidedColors,
    setSimpleColorsDirtyByAppearance,
    setSize,
    setUsageCount,
    shouldRegenerateGuidedColors,
    simpleColorsDirtyByAppearance,
    size,
    startColorEdit,
    takenAppearances,
    toggleThemeRole,
    updateColor,
    usageCount,
  } = useThemeEditorState({
    open,
    onOpenChange,
    onSaved,
    editingTheme,
    initialAppearance,
    seedTheme,
    seedName,
    restoreTheme,
  });

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
