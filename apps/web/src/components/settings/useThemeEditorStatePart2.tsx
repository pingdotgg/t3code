import type { ThemeEditorStateProps } from "./useThemeEditorState";
import { useThemeEditorStatePart1 } from "./useThemeEditorStatePart1";

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
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Switch } from "../ui/switch";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import { THEME_EDITOR_ROLE_GROUPS } from "./ThemeEditorPanelParts";
export function useThemeEditorStatePart2(props: ThemeEditorStateProps, params: {
  s1: ReturnType<typeof useThemeEditorStatePart1>,
  }) {
  const { s1 } = params;
  const { editingTheme, onSaved, onOpenChange } = props;
  const { name, setError, isAdvanced, simpleColorsDirtyByAppearance, colorsByAppearance, mergeTarget, takenAppearances, activeAppearance, isEditing, size, setName, appearanceLockReason, setActiveAppearance, setRoleQuery, roleQuery, handleAdvancedChange, updateColor, cancelColorEdit, startColorEdit, selectThemeRole, toggleThemeRole, selectedRole } = s1;
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
            onEditCancel={cancelColorEdit}
            onEditStart={startColorEdit}
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
              onEditCancel={cancelColorEdit}
              onEditStart={startColorEdit}
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

  return { handleSubmit, renderNameField, renderAppearanceButton, renderAppearanceButtons, renderColorsHeader, renderRoleFields, renderColorFields };
}
