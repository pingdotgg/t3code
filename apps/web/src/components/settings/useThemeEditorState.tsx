
import { useThemeEditorStatePart1 } from "./useThemeEditorStatePart1";
import { useThemeEditorStatePart2 } from "./useThemeEditorStatePart2";

import { type ThemeAppearance, type ThemeDefinition } from "../../themePalette";

export interface ThemeEditorStateProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  readonly editingTheme: ThemeDefinition | null;
  readonly initialAppearance: ThemeAppearance;
  readonly seedTheme?: ThemeDefinition | null | undefined;
  readonly seedName?: string | undefined;
  readonly restoreTheme: () => void;
}

/** Theme editor form state: seeded colours, live edits, validation and save. */
export function useThemeEditorState(props: ThemeEditorStateProps) {
  const {
    open,
    onOpenChange,
    onSaved,
    editingTheme,
    initialAppearance,
    seedTheme,
    seedName,
    restoreTheme,
  } = props;

const s1 = useThemeEditorStatePart1(props);
const { isEditing, name, setName, activeAppearance, setActiveAppearance, isAdvanced, setIsAdvanced, colorsByAppearance, setColorsByAppearance, simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance, shouldRegenerateGuidedColors, setShouldRegenerateGuidedColors, error, setError, isMinimized, setIsMinimized, roleQuery, setRoleQuery, isInspecting, setIsInspecting, selectedRole, setSelectedRole, usageCount, setUsageCount, position, setPosition, size, setSize, panelRef, colorEditSnapshotRef, dragOffsetRef, resizeStartRef, seededOpen, setSeededOpen, nameTargetId, normalizedName, mergeTarget, takenAppearances, editableAppearances, appearanceLockReason, mergeKey, appliedMergeKey, setAppliedMergeKey, updateColor, startColorEdit, cancelColorEdit, selectThemeRole, toggleThemeRole, clearInspectorSelection, selectedHighlightRoles, selectedHighlightRolesKey, handleAdvancedChange } = s1;

const s2 = useThemeEditorStatePart2(props, { s1 });
const { handleSubmit, renderNameField, renderAppearanceButton, renderAppearanceButtons, renderColorsHeader, renderRoleFields, renderColorFields } = s2;

  // Geometry is stored as the user left it and fitted to the current viewport here, so a
  // window that shrinks and grows back returns the panel to where it was.

  return {
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
  };
}
