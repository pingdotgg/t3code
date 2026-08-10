import {
  CopyIcon,
  DownloadIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  getThemeDefinition,
  getThemeModes,
  removeCustomTheme,
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
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give the
  // browser time to open the stream first.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ThemeLibraryCard({
  theme,
  isActive,
  onUse,
  onUseMode,
  activeModes,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  // A one-appearance theme can only take its own side of the mix, so the card
  // tooltip promises exactly what clicking it does.
  const cardModes = theme.previews.map((preview) => preview.mode);
  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
              isActive && "bg-accent/30",
            )}
            data-theme-library-card={theme.id}
            onClick={onUse}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
          >
            <ThemePreviewCircles
              label={theme.label}
              activeModes={activeModes}
              onSelectMode={onUseMode}
              previews={theme.previews}
            />
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Use ${theme.label} theme${isActive ? ", currently active" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUse();
                    }}
                  >
                    {theme.label}
                  </button>
                </div>
              </div>
              {onEdit || onDuplicate || onDownload || onRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Duplicate ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDuplicate();
                            }}
                          >
                            <CopyIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Duplicate theme</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onEdit ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Edit ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEdit();
                            }}
                          >
                            <PenLineIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Edit theme</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onDownload ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Export ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDownload();
                            }}
                          >
                            <UploadIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Export theme file</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onRemove ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Remove ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemove();
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Remove theme</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {cardModes.length > 1 ? "Use for both light and dark" : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}

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
  const [themeToRemove, setThemeToRemove] = useState<ThemeDefinition | null>(null);
  // Keep the last removal target so the dialog title stays populated while the
  // close animation plays after confirming.
  const lastThemeToRemoveRef = useRef<ThemeDefinition | null>(null);
  useEffect(() => {
    if (themeToRemove) lastThemeToRemoveRef.current = themeToRemove;
  }, [themeToRemove]);
  const removeDialogTheme = themeToRemove ?? lastThemeToRemoveRef.current;

  const notifyThemeSaveFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t save theme selection",
        description: "Try again.",
      }),
    );
  }, []);

  const notifyThemeRemovalFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t remove theme",
        description: "Try again.",
      }),
    );
  }, []);

  const persistTheme = useCallback(
    (nextTheme: string) => {
      const didSave = setTheme(nextTheme);
      if (!didSave) notifyThemeSaveFailure();
      return didSave;
    },
    [notifyThemeSaveFailure, setTheme],
  );

  const handleRemoveTheme = useCallback((customTheme: ThemeDefinition) => {
    setThemeToRemove(customTheme);
  }, []);

  const handleConfirmRemoveTheme = useCallback(() => {
    if (!themeToRemove) return;
    const removesBase = getThemeDefinition(theme)?.id === themeToRemove.id;
    // Keep the theme installed if we cannot move the selection off it; the
    // dialog stays open so the user can retry or cancel.
    if (removesBase && !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) {
      return;
    }
    for (const appearance of ["light", "dark"] as const) {
      const half = themeHalves?.[appearance];
      if (half === undefined) continue;
      // Writing a base preference clears the whole mix, so halves that name a
      // surviving theme are written back; halves on the removed theme fall
      // back to the base.
      const next = half === themeToRemove.id ? null : removesBase ? half : undefined;
      if (next !== undefined && !setThemeHalf(appearance, next)) {
        notifyThemeRemovalFailure();
        return;
      }
    }
    try {
      removeCustomTheme(themeToRemove.id);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setThemeToRemove(null);
  }, [
    appearanceMode,
    notifyThemeRemovalFailure,
    persistTheme,
    setThemeHalf,
    theme,
    themeHalves,
    themeToRemove,
  ]);

  // ----- Automatic-mode mixing -------------------------------------------
  // The pair model: one theme owns light, one owns dark, and the global
  // appearance mode (light / dark / auto) decides which is showing.
  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;

  const assignHalf = useCallback(
    (appearance: ThemeAppearance, cardId: string | null) => {
      const otherAppearance = appearance === "light" ? "dark" : "light";
      // Picking the default over a themed base cannot be stored as a half:
      // the base would still own that appearance. Convert the base into an
      // explicit half on the other side so this side falls back to default.
      if (cardId === null && baseCardId !== null) {
        const otherOwner = themeHalves?.[otherAppearance] ?? baseCardId;
        if (!persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) return;
        if (!setThemeHalf(otherAppearance, otherOwner)) {
          // Best-effort rollback: restore the whole-theme selection rather
          // than leaving the user with no theme at all.
          setTheme(theme);
          notifyThemeSaveFailure();
        }
        return;
      }
      if (!setThemeHalf(appearance, cardId)) {
        notifyThemeSaveFailure();
      }
    },
    [
      appearanceMode,
      baseCardId,
      notifyThemeSaveFailure,
      persistTheme,
      setTheme,
      setThemeHalf,
      theme,
      themeHalves,
    ],
  );

  // "Create theme" starts from whatever is on screen for the appearance being
  // edited, so tuning the theme you already use never means rebuilding it.
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

  // ----- Wireframe tiles on top, two-ball cards below --------------------
  const handlePairPick = (cardId: string | null) => (mode: ThemeMode) => {
    if (mode === "system") return;
    assignHalf(mode, cardId);
  };

  // Rings always show the effective owner of each appearance: an unpicked
  // half belongs to the default card (a null owner), so a fresh install
  // shows T3 Code selected instead of nothing.
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
    <div
      aria-label="Appearance mode"
      className="mx-auto grid w-full max-w-[56rem] grid-cols-3 gap-3 px-3 sm:px-4"
      role="group"
    >
      {(["system", "light", "dark"] as const).map((mode) => {
        const isActive = appearanceMode === mode;
        return (
          <button
            aria-label={mode === "system" ? "Follow the system appearance" : `Use ${mode} mode`}
            aria-pressed={isActive}
            className={cn(
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-transparent bg-accent/30"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={mode}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
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

  const renderPairGrid = () => (
    // One shared provider so every tooltip in the grid hands off instantly to
    // the next hovered trigger instead of stacking on top of it. The card
    // tooltip briefly showing while crossing between a card's two circles is
    // accepted — scoping the group tighter makes the handoffs feel sluggish.
    <TooltipProvider>
      <div
        className="mx-auto grid w-full max-w-[56rem] gap-2 px-3 sm:px-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))" }}
      >
        {STANDARD_THEME_CARDS.map((standardTheme) => (
          <ThemeLibraryCard
            activeModes={pickedModesFor(null)}
            isActive={false}
            key={standardTheme.id}
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
        {customThemes.map((customTheme) => {
          const card = getThemeCardDefinition(customTheme);
          return (
            <ThemeLibraryCard
              activeModes={pickedModesFor(customTheme.id)}
              isActive={false}
              key={customTheme.id}
              onDuplicate={() =>
                openThemeEditor({
                  editingThemeId: null,
                  seedThemeId: customTheme.id,
                  seedName: `${customTheme.label} copy`,
                  initialAppearance,
                })
              }
              onEdit={() =>
                openThemeEditor({
                  editingThemeId: customTheme.id,
                  seedThemeId: null,
                  seedName: null,
                  initialAppearance,
                })
              }
              onDownload={() =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
              }
              onRemove={() => handleRemoveTheme(customTheme)}
              onUse={() => {
                const modes = getThemeModes(customTheme);
                if (modes.length === 1) assignHalf(modes[0]!, customTheme.id);
                else persistTheme(customTheme.id);
              }}
              onUseMode={handlePairPick(customTheme.id)}
              theme={card}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );

  return (
    <div className="space-y-3">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Choose how T3 Code looks. Use a built-in theme or make your own.
      </p>
      <h3 className="px-3 text-sm font-medium tracking-[-0.005em] text-foreground sm:px-4">
        Color scheme
      </h3>
      {renderModeTiles()}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Themes</h3>
        <div className="flex flex-wrap items-center justify-end gap-3">
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
            <PlusIcon />
            Create theme
          </Button>
          <Button size="xs" variant="outline" onClick={() => onImportOpenChange(true)}>
            <DownloadIcon />
            Import theme
          </Button>
        </div>
      </div>
      {renderPairGrid()}
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          // An updated theme that is showing (as the base or either half)
          // needs its palette re-applied.
          if (
            updated &&
            importedThemes.some(
              (imported) =>
                getThemeDefinition(theme)?.id === imported.id ||
                themeHalves?.light === imported.id ||
                themeHalves?.dark === imported.id,
            )
          ) {
            refreshTheme();
          }
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
          // Same rule as clicking the card: a one-appearance theme takes its
          // side of the mix instead of becoming the base for both.
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
      <AlertDialog
        open={themeToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setThemeToRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removeDialogTheme?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              You can bring it back anytime by importing its JSON file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={handleConfirmRemoveTheme}>
              Remove theme
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
