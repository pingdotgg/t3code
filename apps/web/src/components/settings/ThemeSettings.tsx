import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  MoonIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import {
  APPEARANCE_CHOICES,
  readThemeHalvesRaw,
  type AppearanceChoice,
} from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  getStockThemeColors,
  getThemeDefinition,
  isReservedThemeId,
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { searchableSetting } from "./settingsSearch";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
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
  // Delay revocation so browsers can open the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Exports any library theme as an importable file. Built-in ids are reserved,
 * so their files take a "-copy" id and import next to the original.
 */
function downloadLibraryTheme(theme: ThemeDefinition): void {
  const exportedTheme = isReservedThemeId(theme.id) ? { ...theme, id: `${theme.id}-copy` } : theme;
  downloadThemeFile(`${exportedTheme.id}.json`, serializeThemeFile(exportedTheme));
}

// The standard palette has no stored definition; this is the one its file carries.
function standardThemeDefinition(label: string): ThemeDefinition {
  return {
    id: "t3-code",
    label,
    appearance: "light",
    colors: getStockThemeColors("light"),
    variants: { dark: getStockThemeColors("dark") },
  };
}

const APPEARANCE_CHOICE_ARIA_LABELS: Readonly<Record<AppearanceChoice, string>> = {
  system: "Follow the system appearance",
  light: "Use light mode",
  "black-chrome": "Use light mode with a black window and sidebar",
  dark: "Use dark mode",
};

function ThemeVariantTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Secondary card actions for themes the user owns, behind one ellipsis button. */
function ThemeCardMoreMenu({
  label,
  removeLabel,
  onDuplicate,
  onDownload,
  onRemove,
}: {
  label: string;
  removeLabel: string;
  onDuplicate: (() => void) | undefined;
  onDownload: (() => void) | undefined;
  onRemove: (() => void) | undefined;
}) {
  if (!onDuplicate && !onDownload && !onRemove) return null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={`More actions for ${label}`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            />
          }
        >
          <EllipsisIcon />
        </TooltipTrigger>
        <TooltipPopup>More actions</TooltipPopup>
      </Tooltip>
      {/* The popup is portaled but React still bubbles its clicks to the card. */}
      <MenuPopup align="end" onClick={(event) => event.stopPropagation()}>
        {onDuplicate ? (
          <MenuItem onClick={onDuplicate}>
            <CopyIcon />
            Duplicate theme
          </MenuItem>
        ) : null}
        {onDownload ? (
          <MenuItem onClick={onDownload}>
            <DownloadIcon />
            Export theme file
          </MenuItem>
        ) : null}
        {onRemove ? (
          <MenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon />
            {removeLabel}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
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
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="cursor-pointer overflow-hidden rounded-card border border-transparent surface-card-settings-rim transition-colors hover:surface-ghost-hover"
            data-theme-library-card={theme.id}
            onClick={onUse}
            style={
              isActive
                ? {
                    background: "var(--settings-effective-fill)",
                    boxShadow: "inset 0 0 0 1px var(--settings-active-rim)",
                  }
                : undefined
            }
          >
            <div className="relative bg-settings-preview-fill">
              {variantNavigation ? (
                <div
                  aria-label="Light and dark theme variants"
                  className="relative h-24"
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
                            className="absolute left-1/2 top-2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-5 focus-visible:outline-foreground/60"
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
                                className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-inset ring-settings-active-rim"
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
                          className="pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-2xs font-medium text-foreground"
                          style={{ marginLeft: rootOffsetX }}
                        >
                          <span className="truncate">{selected.option.label}</span>
                          {options.length > 1 ? (
                            <span className="shrink-0 rounded-full bg-muted px-1 text-3xs text-muted-foreground">
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
                                      "absolute left-1/2 top-1 z-30 flex size-7 items-center justify-center rounded-full bg-background shadow-sm outline-none transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                      optionIsActive
                                        ? "ring-2 ring-inset ring-settings-active-rim"
                                        : "ring-1 ring-border/70",
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
            <div className="flex items-center gap-1 py-2 ps-2.5 pe-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Use ${variantNavigation ? `${variantNavigation.collectionLabel}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
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
                // The footer keeps the design's 10px name inset and 6px action inset.
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate && !onEdit ? (
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
                  {/* Owned themes have four actions; only edit stays inline so the name
                      keeps room in the three-per-row grid. */}
                  {onEdit ? (
                    <ThemeCardMoreMenu
                      label={variantNavigation?.collectionLabel ?? theme.label}
                      removeLabel={variantNavigation ? "Remove themes" : "Remove theme"}
                      onDuplicate={onDuplicate}
                      onDownload={onDownload}
                      onRemove={onRemove}
                    />
                  ) : null}
                  {onDownload && !onEdit ? (
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
                            <DownloadIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Export theme file</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onRemove && !onEdit ? (
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
                            variant="ghost-destructive"
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

  if (variantIndex !== safeIndex) setVariantIndex(safeIndex);

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
  appearanceChoice,
  setAppearanceChoice,
  customThemes,
  initialAppearance,
  refreshTheme,
  isImportOpen,
  onImportOpenChange,
  themeHalves,
  setThemeHalf,
  restoreAction,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  appearanceChoice: AppearanceChoice;
  setAppearanceChoice: (choice: AppearanceChoice) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
  isImportOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
  themeHalves: ThemeHalves | null;
  setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
  /** Rendered at the end of the "Appearance mode" title row. */
  restoreAction?: ReactNode;
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

  const setMode = (choice: AppearanceChoice) => {
    if (!setAppearanceChoice(choice)) notifyThemeSaveFailure();
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

  const renderModeTiles = () => (
    <div
      aria-label="Appearance mode"
      className="grid w-full grid-cols-1 gap-3 min-[420px]:grid-cols-3"
      role="group"
    >
      {APPEARANCE_CHOICES.filter(({ choice }) => choice !== "black-chrome").map(
        ({ choice: mode, label }) => {
          const isActive =
            appearanceChoice === mode || (mode === "light" && appearanceChoice === "black-chrome");
          return (
            <div className="relative" key={mode}>
              <button
                aria-label={APPEARANCE_CHOICE_ARIA_LABELS[mode]}
                aria-pressed={isActive}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-stretch gap-1.75 rounded-card border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  isActive
                    ? "border-transparent bg-settings-effective-fill"
                    : "border-transparent surface-card-settings-rim hover:surface-ghost-hover",
                )}
                style={
                  isActive ? { boxShadow: "inset 0 0 0 1px var(--settings-active-rim)" } : undefined
                }
                onClick={() => setMode(mode)}
                type="button"
              >
                <ThemeWireframe
                  mode={
                    mode === "light" && appearanceChoice === "black-chrome" ? "black-chrome" : mode
                  }
                />
                <span
                  className={cn(
                    "flex items-center justify-center text-meta",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </button>
              {mode === "light" ? (
                <div className="absolute bottom-1.5 right-1.5">
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          aria-label="Light mode options"
                        />
                      }
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setMode("light")}>Light chrome</MenuItem>
                      <MenuItem
                        aria-label={APPEARANCE_CHOICE_ARIA_LABELS["black-chrome"]}
                        onClick={() => setMode("black-chrome")}
                      >
                        Black chrome
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              ) : null}
            </div>
          );
        },
      )}
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
      {/* Three cards per row in the settings column (pen eWIa5). */}
      <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3">
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
            onDownload={() => downloadLibraryTheme(standardThemeDefinition(standardTheme.label))}
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
              onDownload={() => downloadLibraryTheme(maintainerTheme)}
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
              onDownload={() => downloadLibraryTheme(environmentTheme)}
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
            onDownload={downloadLibraryTheme}
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
    // Appearance headings carry 24px actions, 10px above the cards (pen eWIa5).
    <div className="space-y-7">
      <div className="space-y-2.5">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-3">
          <h3 className="text-meta text-dim-foreground">
            {searchableSetting("color-scheme").title}
          </h3>
          {/* The ghost button hangs by its 8px inline inset so its text ends on the card edge. */}
          <div className="-me-2 flex">{restoreAction}</div>
        </div>
        {renderModeTiles()}
      </div>
      <div className="space-y-2.5">
        <div className="flex min-h-6.5 flex-wrap items-center justify-between gap-3">
          <h3 className="text-meta text-dim-foreground">{searchableSetting("theme").title}</h3>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="xs" variant="secondary" onClick={() => onImportOpenChange(true)}>
              <UploadIcon />
              Import
            </Button>
            <Button
              size="xs"
              variant="secondary"
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
          </div>
        </div>
        {renderPairGrid()}
      </div>
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
                    className="relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-transparent surface-card-settings-rim p-3 data-checked:border-ring data-checked:surface-selected hover:surface-ghost-hover"
                    data-checked={checked ? "" : undefined}
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
                      <CheckIcon
                        className={cn(
                          "pointer-events-none col-start-1 row-start-1 size-3.5 shrink-0 self-center justify-self-center stroke-primary-foreground sm:size-3",
                          checked ? "opacity-100" : "opacity-0",
                        )}
                      />
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
            <AlertDialogClose render={<Button variant="secondary" />}>Cancel</AlertDialogClose>
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
