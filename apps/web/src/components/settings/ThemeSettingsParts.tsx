import {
  CheckIcon,
  CopyIcon,
  MoonIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { readThemeHalvesRaw } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  getThemeDefinition,
  singleAppearanceOf,
  getThemeModes,
  removeCustomThemes,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
  type ThemeHalves,
  T3_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
} from "../../themePalette";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { searchableSetting } from "./settingsSearch";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircles,
  ThemePreviewCircle,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";
import { CustomThemeCollectionCard, MAINTAINER_THEMES, ThemeLibraryCard, downloadThemeFile } from "./ThemeSettings";

export function ThemeLibrary({
  theme,
  setTheme,
  appearanceMode,
  setAppearanceMode,
  customThemes,
  initialAppearance,
  refreshTheme,
  isImportOpen,
  onImportOpenChange,
  themeHalves,
  setThemeHalf,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
  isImportOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
  themeHalves: ThemeHalves | null;
  setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
}) {
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const environmentThemes = useEnvironmentThemeDefinitions();
  const [themeRemovalTarget, setThemeRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  const [isThemeRemovalOpen, setIsThemeRemovalOpen] = useState(false);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<ReadonlyArray<string>>([]);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = themeRemovalTarget?.theme;
  const removeDialogCollectionThemes = themeRemovalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel =
    removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;

  const notifyThemeSaveFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t save theme selection",
        description: "Try again.",
      }),
    );
  };

  const notifyThemeRemovalFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t remove theme",
        description: "Try again.",
      }),
    );
  };

  const persistTheme = (nextTheme: string) => {
    const didSave = setTheme(nextTheme);
    if (!didSave) notifyThemeSaveFailure();
    return didSave;
  };

  const handleRemoveTheme = (
    customTheme: ThemeDefinition,
    collectionThemes: ReadonlyArray<ThemeDefinition>,
  ) => {
    setThemeRemovalTarget({ theme: customTheme, collectionThemes });
    setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
    setIsThemeRemovalOpen(true);
  };

  const handleConfirmRemoveTheme = () => {
    if (!themeRemovalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    const removesBase = removedIds.has(getThemeDefinition(theme)?.id ?? "");
    // Read raw halves before persistTheme clears them; themeHalves omits published themes not yet streamed
    // in.
    const storedHalves = readThemeHalvesRaw();
    if (removesBase && !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) {
      return;
    }
    for (const appearance of ["light", "dark"] as const) {
      const half = storedHalves[appearance];
      if (half === undefined) continue;
      const next = half && removedIds.has(half) ? null : removesBase ? half : undefined;
      if (next !== undefined && !setThemeHalf(appearance, next)) {
        notifyThemeRemovalFailure();
        return;
      }
    }
    try {
      removeCustomThemes([...removedIds]);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setIsThemeRemovalOpen(false);
  };

  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;

  const assignHalf = (appearance: ThemeAppearance, cardId: string | null) => {
    const otherAppearance = appearance === "light" ? "dark" : "light";
    // To restore one default appearance, move the themed base to the opposite explicit half.
    if (cardId === null && baseCardId !== null) {
      // Read raw before persistTheme clears the mix; unstreamed published halves must not fall back to the
      // base.
      const otherOwner = readThemeHalvesRaw()[otherAppearance] ?? baseCardId;
      if (!persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) return;
      if (!setThemeHalf(otherAppearance, otherOwner)) {
        setTheme(theme);
        notifyThemeSaveFailure();
      }
      return;
    }
    if (!setThemeHalf(appearance, cardId)) {
      notifyThemeSaveFailure();
    }
  };

  const activeThemeForAppearance =
    getThemeDefinition((initialAppearance === "light" ? lightOwner : darkOwner) ?? "") ?? null;

  const cardDefById = (id: string | null): ThemeCardDefinition => {
    if (id === null) return STANDARD_THEME_CARDS[0]!;
    const definition = getThemeDefinition(id);
    return definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  };

  const pickColors = (id: string | null, appearance: ThemeAppearance) => {
    const card = cardDefById(id);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };

  const setMode = (mode: ThemeMode) => {
    if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
  };

  const handlePairPick = (cardId: string | null) => (mode: ThemeMode) => {
    if (mode === "system") return;
    assignHalf(mode, cardId);
  };

  const pickedModesFor = (cardId: string | null): ThemeMode[] => {
    const rings: ThemeMode[] = [];
    if (lightOwner === cardId) rings.push("light");
    if (darkOwner === cardId) rings.push("dark");
    return rings;
  };

  const wireframeColors = (appearance: ThemeAppearance) =>
    pickColors(appearance === "light" ? lightOwner : darkOwner, appearance);

  const renderWireframe = (mode: ThemeMode) => (
    <ThemeWireframe
      className="h-[8.75rem]"
      panes={
        mode === "system"
          ? [
              { clip: "left", colors: wireframeColors("light") },
              { clip: "right", colors: wireframeColors("dark") },
            ]
          : [{ colors: wireframeColors(mode === "dark" ? "dark" : "light") }]
      }
    />
  );

  const renderModeTiles = () => (
    <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
      {(["system", "light", "dark"] as const).map((mode) => {
        const isActive = appearanceMode === mode;
        return (
          <button
            aria-label={mode === "system" ? "Follow the system appearance" : `Use ${mode} mode`}
            aria-pressed={isActive}
            className={cn(
              // The accent ring marks the picked tile; focus is a neutral ring set inside it with a gap.
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-7 focus-visible:outline-foreground/60",
              isActive
                ? "border-transparent bg-accent/30 ring-2 ring-inset ring-ring"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={mode}
            onClick={() => setMode(mode)}
            type="button"
          >
            {renderWireframe(mode)}
            <span
              className={cn(
                "flex items-center justify-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}
            </span>
          </button>
        );
      })}
    </div>
  );

  const customThemeCollections = [
    ...customThemes
      .reduce((groups, customTheme) => {
        const groupId = customTheme.collection
          ? `collection:${customTheme.collection.id}`
          : `theme:${customTheme.id}`;
        const group = groups.get(groupId);
        if (group) group.push(customTheme);
        else groups.set(groupId, [customTheme]);
        return groups;
      }, new Map<string, ThemeDefinition[]>())
      .entries(),
  ];

  const renderPairGrid = () => (
    <TooltipProvider>
      <div
        className="grid w-full gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}
      >
        {STANDARD_THEME_CARDS.map((standardTheme) => (
          <ThemeLibraryCard
            activeModes={pickedModesFor(null)}
            isActive={false}
            key={standardTheme.id}
            onDuplicate={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: null,
                seedName: `${standardTheme.label} copy`,
                initialAppearance,
              })
            }
            onUse={() => persistTheme(appearanceMode === "system" ? "system" : appearanceMode)}
            onUseMode={handlePairPick(null)}
            theme={standardTheme}
          />
        ))}
        {MAINTAINER_THEMES.map((maintainerTheme) => {
          const card = getThemeCardDefinition(maintainerTheme);
          return (
            <ThemeLibraryCard
              activeModes={pickedModesFor(maintainerTheme.id)}
              isActive={false}
              key={maintainerTheme.id}
              onDuplicate={() =>
                openThemeEditor({
                  editingThemeId: null,
                  seedThemeId: maintainerTheme.id,
                  seedName: `${maintainerTheme.label} copy`,
                  initialAppearance,
                })
              }
              onUse={() => persistTheme(maintainerTheme.id)}
              onUseMode={handlePairPick(maintainerTheme.id)}
              theme={card}
            />
          );
        })}
        {environmentThemes
          .filter(
            // Saved themes win id resolution; show only their card to avoid duplicate keys.
            (environmentTheme) => !customThemes.some((theme) => theme.id === environmentTheme.id),
          )
          .map((environmentTheme) => (
            <ThemeLibraryCard
              activeModes={pickedModesFor(environmentTheme.id)}
              isActive={false}
              key={environmentTheme.id}
              onDuplicate={() =>
                openThemeEditor({
                  editingThemeId: null,
                  seedThemeId: environmentTheme.id,
                  seedName: `${environmentTheme.label} copy`,
                  initialAppearance,
                })
              }
              onUse={() => {
                const half = singleAppearanceOf(environmentTheme);
                if (half === null) persistTheme(environmentTheme.id);
                else assignHalf(half, environmentTheme.id);
              }}
              onUseMode={handlePairPick(environmentTheme.id)}
              theme={getThemeCardDefinition(environmentTheme)}
            />
          ))}
        {customThemeCollections.map(([collectionId, themes]) => (
          <CustomThemeCollectionCard
            activeModesFor={pickedModesFor}
            key={collectionId}
            onDownload={(customTheme) =>
              downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
            }
            onDuplicate={(customTheme) =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: customTheme.id,
                seedName: `${customTheme.label} copy`,
                initialAppearance,
              })
            }
            onEdit={(customTheme) =>
              openThemeEditor({
                editingThemeId: customTheme.id,
                seedThemeId: null,
                seedName: null,
                initialAppearance,
              })
            }
            onRemove={(customTheme) => handleRemoveTheme(customTheme, themes)}
            onUse={(customTheme) => {
              const modes = getThemeModes(customTheme);
              if (modes.length === 1) assignHalf(modes[0]!, customTheme.id);
              else persistTheme(customTheme.id);
            }}
            onUseMode={(customTheme, mode) => handlePairPick(customTheme.id)(mode)}
            themes={themes}
          />
        ))}
      </div>
    </TooltipProvider>
  );

  return (
    <div className="space-y-3">
      <h3 className="flex min-h-7 items-center px-3 text-base font-semibold text-foreground sm:px-4">
        {searchableSetting("color-scheme").title}
      </h3>
      {renderModeTiles()}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-5 sm:px-4">
        <h3 className="text-base font-semibold text-foreground">
          {searchableSetting("theme").title}
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: activeThemeForAppearance?.id ?? null,
                seedName: null,
                initialAppearance,
              })
            }
          >
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button size="xs" variant="outline" onClick={() => onImportOpenChange(true)}>
            <PlusIcon />
            Add theme
          </Button>
        </div>
      </div>
      {renderPairGrid()}
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          if (updated) refreshTheme();
          const verb = updated ? "updated" : "added";
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title:
                importedThemes.length === 1
                  ? `${importedThemes[0]!.label} ${verb}`
                  : `${importedThemes.length} themes ${verb}`,
              description: importedThemes.map((imported) => imported.label).join(", "),
            }),
          );
        }}
        onImported={(importedTheme) => {
          const modes = getThemeModes(importedTheme);
          if (modes.length === 1) {
            assignHalf(modes[0]!, importedTheme.id);
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `${importedTheme.label} added`,
                description: `It’s now your ${modes[0]!} theme.`,
              }),
            );
            return true;
          }
          if (!persistTheme(importedTheme.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} added`,
              description: "It’s now active.",
            }),
          );
          return true;
        }}
        onOpenChange={onImportOpenChange}
        open={isImportOpen}
      />
      <AlertDialog open={isThemeRemovalOpen} onOpenChange={setIsThemeRemovalOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {canRemoveCollection
                ? `Remove themes from “${removeDialogCollectionLabel}”?`
                : `Remove “${removeDialogTheme?.label}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {canRemoveCollection
                ? "Select the variants you want to remove. You can restore them by importing the extension again."
                : "You can bring it back anytime by importing its JSON file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {canRemoveCollection ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 sm:grid-cols-2">
              {removeDialogCollectionThemes.map((customTheme) => {
                const checked = themeIdsToRemoveSet.has(customTheme.id);
                const card = getThemeCardDefinition(customTheme);
                const checkboxId = `remove-theme-${customTheme.id}`;
                return (
                  <label
                    className="group relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 has-checked:border-ring has-checked:bg-accent/20 hover:bg-muted/40"
                    htmlFor={checkboxId}
                    key={customTheme.id}
                  >
                    <span className="absolute right-2 top-2 inline-grid size-5 grid-cols-1 sm:size-4">
                      <input
                        checked={checked}
                        className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring checked:focus-visible:inset-ring-3 checked:focus-visible:inset-ring-background dark:not-checked:bg-input/32 forced-colors:appearance-auto"
                        id={checkboxId}
                        name="themes-to-remove"
                        type="checkbox"
                        onChange={(event) => {
                          const shouldRemove = event.currentTarget.checked;
                          setThemeIdsToRemove((current) =>
                            shouldRemove
                              ? [...current, customTheme.id]
                              : current.filter((themeId) => themeId !== customTheme.id),
                          );
                        }}
                      />
                      <CheckIcon className="pointer-events-none col-start-1 row-start-1 size-3.5 shrink-0 self-center justify-self-center stroke-primary-foreground opacity-0 group-has-checked:opacity-100 sm:size-3" />
                    </span>
                    <span className="flex min-h-12 items-center justify-center gap-1">
                      {card.previews.map((preview) => (
                        <span
                          className="flex size-11 shrink-0 items-center justify-center"
                          key={preview.mode}
                        >
                          <span className="flex scale-75">
                            <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                          </span>
                        </span>
                      ))}
                    </span>
                    <p className="max-w-full truncate text-center text-base font-medium text-foreground sm:text-sm">
                      {customTheme.label}
                    </p>
                  </label>
                );
              })}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={themeIdsToRemove.length === 0}
              variant="destructive"
              onClick={handleConfirmRemoveTheme}
            >
              {canRemoveCollection
                ? `Remove selected${themeIdsToRemove.length > 0 ? ` (${themeIdsToRemove.length})` : ""}`
                : "Remove theme"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

