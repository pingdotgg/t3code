import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoonIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { cn } from "../../lib/utils";
import {
  getThemeDefinition,
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

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

function collectionVariantLabels(themes: ReadonlyArray<ThemeDefinition>): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()),
  );
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;

  return themes.map((theme, index) => {
    const shortLabel = words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim();
    return shortLabel || theme.label;
  });
}

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

function ThemeVariantTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
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
  variantNavigation,
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
  variantNavigation?: {
    collectionLabel: string;
    options: ReadonlyArray<{
      themeIndex: number;
      label: string;
      activeModes: ReadonlyArray<ThemeMode>;
      preview: ThemeCardDefinition["previews"][number];
    }>;
    onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
  };
}) {
  // A one-appearance theme can only take its own side of the mix, so the card
  // tooltip promises exactly what clicking it does.
  const cardModes = theme.previews.map((preview) => preview.mode);
  const [radialModeOpen, setRadialModeOpen] = useState<ThemeAppearance | null>(null);
  const radialModeGroups = (["light", "dark"] as const).map((mode) => {
    const options =
      variantNavigation?.options.flatMap((option) => {
        const preview = option.preview;
        return preview.mode === mode ? [{ option, preview }] : [];
      }) ?? [];
    return {
      mode,
      options,
      selected: options.find(({ option }) => option.activeModes.includes(mode)) ?? options[0],
    };
  });
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
            <div className="relative">
              {variantNavigation ? (
                <div
                  aria-label="Light and dark theme variants"
                  className="relative h-20"
                  role="group"
                  onBlurCapture={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (
                      !(nextTarget instanceof Node) ||
                      !event.currentTarget.contains(nextTarget)
                    ) {
                      setRadialModeOpen(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRadialModeOpen(null);
                  }}
                  onMouseLeave={() => setRadialModeOpen(null)}
                >
                  {radialModeGroups.map(({ mode, options, selected }) => {
                    if (!selected) return null;
                    const rootOffsetX = mode === "light" ? -52 : 52;
                    const isOpen = radialModeOpen === mode;
                    const isActive = selected.option.activeModes.includes(mode);
                    const modeLabel = mode === "light" ? "Light" : "Dark";
                    return (
                      <div className="contents" key={mode}>
                        <ThemeVariantTooltip label={`${modeLabel}: ${selected.option.label}`}>
                          <button
                            aria-label={
                              options.length > 1
                                ? `Choose ${mode} variant, ${options.length} options, currently ${selected.option.label}`
                                : `Use ${mode} variant, currently ${selected.option.label}`
                            }
                            aria-pressed={isActive}
                            className="absolute left-1/2 top-2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            style={{
                              transform: `translateX(calc(-50% + ${rootOffsetX}px))`,
                            }}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              variantNavigation.onSelectAndUse(selected.option.themeIndex, mode);
                            }}
                            onFocus={() => setRadialModeOpen(mode)}
                            onMouseEnter={() => setRadialModeOpen(mode)}
                          >
                            <ThemePreviewCircle
                              colors={selected.preview.colors}
                              mode={selected.preview.mode}
                            />
                            {isActive ? (
                              <span
                                aria-hidden
                                className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-ring"
                              />
                            ) : null}
                            {isActive ? (
                              <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm">
                                {mode === "light" ? (
                                  <SunIcon className="size-2.5" />
                                ) : (
                                  <MoonIcon className="size-2.5" />
                                )}
                              </span>
                            ) : null}
                          </button>
                        </ThemeVariantTooltip>
                        <span
                          className="pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-[11px] font-medium text-foreground"
                          style={{ marginLeft: rootOffsetX }}
                        >
                          <span className="truncate">{selected.option.label}</span>
                          {options.length > 1 ? (
                            <span className="shrink-0 rounded-full bg-muted px-1 text-[9px] text-muted-foreground">
                              +{options.length - 1}
                            </span>
                          ) : null}
                        </span>
                        {options.length > 1
                          ? options.map(({ option, preview }, optionIndex) => {
                              const progress = optionIndex / (options.length - 1) - 0.5;
                              const childOffsetX = rootOffsetX + progress * 68;
                              const childOffsetY = Math.abs(progress) * 10;
                              const optionIsActive = option.activeModes.includes(mode);
                              return (
                                <ThemeVariantTooltip
                                  key={option.label}
                                  label={`Use ${option.label} for ${mode} mode`}
                                >
                                  <button
                                    aria-label={`Use ${option.label} for ${mode} mode${optionIsActive ? ", currently active" : ""}`}
                                    aria-pressed={optionIsActive}
                                    className={cn(
                                      "absolute left-1/2 top-1 z-30 flex size-7 items-center justify-center rounded-full bg-background shadow-sm outline-none transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                                      optionIsActive ? "ring-2 ring-ring" : "ring-1 ring-border/70",
                                    )}
                                    style={{
                                      opacity: isOpen ? 1 : 0,
                                      pointerEvents: isOpen ? "auto" : "none",
                                      transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                                      transitionDelay: isOpen ? `${optionIndex * 35}ms` : "0ms",
                                    }}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      variantNavigation.onSelectAndUse(option.themeIndex, mode);
                                    }}
                                    onFocus={() => setRadialModeOpen(mode)}
                                    onMouseEnter={() => setRadialModeOpen(mode)}
                                  >
                                    <span className="pointer-events-none scale-[0.43]">
                                      <ThemePreviewCircle
                                        colors={preview.colors}
                                        mode={preview.mode}
                                      />
                                    </span>
                                  </button>
                                </ThemeVariantTooltip>
                              );
                            })
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ThemePreviewCircles
                  label={theme.label}
                  activeModes={activeModes}
                  onSelectMode={onUseMode}
                  previews={theme.previews}
                />
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Use ${variantNavigation ? `${variantNavigation.collectionLabel}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUse();
                    }}
                  >
                    {variantNavigation?.collectionLabel ?? theme.label}
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
                            aria-label={
                              variantNavigation
                                ? `Remove themes from ${variantNavigation.collectionLabel}`
                                : `Remove ${theme.label}`
                            }
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
                      <TooltipPopup>
                        {variantNavigation ? "Remove themes" : "Remove theme"}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {variantNavigation
          ? "Use the first variants for light and dark"
          : cardModes.length > 1
            ? "Use for both light and dark"
            : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}

function CustomThemeCollectionCard({
  themes,
  activeModesFor,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeModesFor: (themeId: string) => ReadonlyArray<ThemeMode>;
  onUse: (theme: ThemeDefinition) => void;
  onUseMode: (theme: ThemeDefinition, mode: ThemeMode) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(() => {
    const activeIndex = themes.findIndex((theme) => activeModesFor(theme.id).length > 0);
    return activeIndex < 0 ? 0 : activeIndex;
  });
  const safeIndex = Math.min(variantIndex, themes.length - 1);
  const theme = themes[safeIndex];

  useEffect(() => {
    if (variantIndex !== safeIndex) setVariantIndex(safeIndex);
  }, [safeIndex, variantIndex]);

  if (!theme) return null;
  const collectionLabel = theme.collection?.label ?? theme.label;
  const variantLabels = collectionVariantLabels(themes);
  const defaultLightTheme = themes.find((candidate) => getThemeModes(candidate).includes("light"));
  const defaultDarkTheme = themes.find((candidate) => getThemeModes(candidate).includes("dark"));
  const selectCollectionDefaults = () => {
    if (themes.length === 1) {
      onUse(theme);
      return;
    }
    if (defaultLightTheme) onUseMode(defaultLightTheme, "light");
    if (defaultDarkTheme) onUseMode(defaultDarkTheme, "dark");
    setVariantIndex(0);
  };

  return (
    <ThemeLibraryCard
      activeModes={activeModesFor(theme.id)}
      isActive={false}
      onDownload={() => onDownload(theme)}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onRemove={() => onRemove(theme)}
      onUse={selectCollectionDefaults}
      onUseMode={(mode) => onUseMode(theme, mode)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            variantNavigation: {
              collectionLabel,
              options: themes.flatMap((variant, themeIndex) =>
                getThemeCardDefinition(variant).previews.map((preview) => ({
                  themeIndex,
                  label: variantLabels[themeIndex] ?? variant.label,
                  activeModes: activeModesFor(variant.id),
                  preview,
                })),
              ),
              onSelectAndUse: (themeIndex, mode) => {
                const selectedTheme = themes[themeIndex];
                if (!selectedTheme) return;
                setVariantIndex(themeIndex);
                onUseMode(selectedTheme, mode);
              },
            },
          }
        : {})}
    />
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
  const [themeRemovalTarget, setThemeRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  // Keep the target after closing so the dialog text remains populated during
  // its exit animation. The next trash action replaces it before reopening.
  const [isThemeRemovalOpen, setIsThemeRemovalOpen] = useState(false);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<ReadonlyArray<string>>([]);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = themeRemovalTarget?.theme;
  const removeDialogCollectionThemes = themeRemovalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel =
    removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;

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

  const handleRemoveTheme = useCallback(
    (customTheme: ThemeDefinition, collectionThemes: ReadonlyArray<ThemeDefinition>) => {
      setThemeRemovalTarget({ theme: customTheme, collectionThemes });
      setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
      setIsThemeRemovalOpen(true);
    },
    [],
  );

  const handleConfirmRemoveTheme = useCallback(() => {
    if (!themeRemovalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    const removesBase = removedIds.has(getThemeDefinition(theme)?.id ?? "");
    // Keep the themes installed if we cannot move the selection off one of
    // them; the dialog stays open so the user can retry or cancel.
    if (removesBase && !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) {
      return;
    }
    for (const appearance of ["light", "dark"] as const) {
      const half = themeHalves?.[appearance];
      if (half === undefined) continue;
      // Writing a base preference clears the whole mix, so halves that name
      // a surviving theme are written back; removed halves fall back to base.
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
  }, [
    appearanceMode,
    notifyThemeRemovalFailure,
    persistTheme,
    setThemeHalf,
    theme,
    themeHalves,
    themeIdsToRemove,
    themeRemovalTarget,
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
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Choose how T3 Code looks. Use a built-in theme or make your own.
      </p>
      <h3 className="px-3 text-sm font-medium tracking-[-0.005em] text-foreground sm:px-4">
        Color scheme
      </h3>
      {renderModeTiles()}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Themes</h3>
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
          // Re-apply after collection updates. The update may remove the
          // selected variant, in which case the theme hook falls back safely.
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
                        className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:not-checked:bg-input/32 forced-colors:appearance-auto"
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
