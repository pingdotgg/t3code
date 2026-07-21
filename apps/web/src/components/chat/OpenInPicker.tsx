import {
  EditorId,
  EnvironmentId,
  OpenWithEntry as OpenWithEntrySchema,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type OpenWithDirectoryMode,
  type OpenWithEntry,
  type OpenWithEntryKind,
  type OpenWithEntryPresentation,
  type OpenWithEntryRef,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  AppWindowIcon,
  ChevronDownIcon,
  Code2Icon,
  FolderClosedIcon,
  PlusIcon,
  SettingsIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";

import { readLegacyPreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import {
  mergeOpenWithOptions,
  nextOpenWithEntryId,
  refForOpenWithOption,
  resolveEffectiveOpenWith,
  type OpenWithOption,
} from "../../openWith";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Group, GroupSeparator } from "../ui/group";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform, randomUUID } from "~/lib/utils";

type BuiltinPresentation = {
  readonly label: string;
  readonly Icon: Icon;
  readonly value: EditorId;
  readonly kind: "brand" | "generic";
};

const BUILTIN_PRESENTATIONS: readonly BuiltinPresentation[] = [
  { label: "Cursor", Icon: CursorIcon, value: "cursor", kind: "brand" },
  { label: "Trae", Icon: TraeIcon, value: "trae", kind: "brand" },
  { label: "Kiro", Icon: KiroIcon, value: "kiro", kind: "brand" },
  { label: "VS Code", Icon: VisualStudioCode, value: "vscode", kind: "brand" },
  {
    label: "VS Code Insiders",
    Icon: VisualStudioCodeInsiders,
    value: "vscode-insiders",
    kind: "brand",
  },
  { label: "VSCodium", Icon: VSCodium, value: "vscodium", kind: "brand" },
  { label: "Zed", Icon: Zed, value: "zed", kind: "brand" },
  { label: "Antigravity", Icon: AntigravityIcon, value: "antigravity", kind: "brand" },
  { label: "IntelliJ IDEA", Icon: IntelliJIdeaIcon, value: "idea", kind: "brand" },
  { label: "Aqua", Icon: AquaIcon, value: "aqua", kind: "brand" },
  { label: "CLion", Icon: CLionIcon, value: "clion", kind: "brand" },
  { label: "DataGrip", Icon: DataGripIcon, value: "datagrip", kind: "brand" },
  { label: "DataSpell", Icon: DataSpellIcon, value: "dataspell", kind: "brand" },
  { label: "GoLand", Icon: GoLandIcon, value: "goland", kind: "brand" },
  { label: "PhpStorm", Icon: PhpStormIcon, value: "phpstorm", kind: "brand" },
  { label: "PyCharm", Icon: PyCharmIcon, value: "pycharm", kind: "brand" },
  { label: "Rider", Icon: RiderIcon, value: "rider", kind: "brand" },
  { label: "RubyMine", Icon: RubyMineIcon, value: "rubymine", kind: "brand" },
  { label: "RustRover", Icon: RustRoverIcon, value: "rustrover", kind: "brand" },
  { label: "WebStorm", Icon: WebStormIcon, value: "webstorm", kind: "brand" },
  { label: "File Manager", Icon: FolderClosedIcon, value: "file-manager", kind: "generic" },
];

const DESKTOP_PRIMARY_ENVIRONMENT_ID = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

const builtinPresentationById = new Map(BUILTIN_PRESENTATIONS.map((entry) => [entry.value, entry]));
const decodeOpenWithEntry = Schema.decodeUnknownSync(OpenWithEntrySchema);

type ArgumentRow = { readonly id: string; readonly value: string };
const makeArgumentRow = (value = ""): ArgumentRow => ({ id: randomUUID(), value });

const OPEN_WITH_KIND_LABELS: Record<OpenWithEntryKind, string> = {
  editor: "Editor",
  terminal: "Terminal",
  "file-manager": "File manager",
  other: "Other",
};

const DIRECTORY_MODE_LABELS: Record<OpenWithDirectoryMode, string> = {
  "open-target": "Open target",
  "working-directory": "Working directory",
  "custom-arguments": "Custom arguments",
};

function categoryIcon(kind: OpenWithEntryKind): Icon {
  if (kind === "editor") return Code2Icon;
  if (kind === "terminal") return SquareTerminalIcon;
  if (kind === "file-manager") return FolderClosedIcon;
  return AppWindowIcon;
}

function CustomIcon({
  entry,
  presentation,
  className,
}: {
  entry: OpenWithEntry;
  presentation: OpenWithEntryPresentation | null;
  className?: string;
}) {
  if (presentation?.iconDataUrl) {
    return <img alt="" src={presentation.iconDataUrl} className={cn("rounded-sm", className)} />;
  }
  const FallbackIcon = categoryIcon(entry.kind);
  return <FallbackIcon aria-hidden="true" className={cn("text-muted-foreground", className)} />;
}

function OptionIcon({
  option,
  className = "size-4",
}: {
  option: OpenWithOption;
  className?: string;
}) {
  if (option.type === "custom") {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex shrink-0 items-center justify-center", className)}
      >
        <CustomIcon
          entry={option.entry}
          presentation={option.presentation}
          className="size-full object-contain"
        />
      </span>
    );
  }
  const presentation = builtinPresentationById.get(option.id);
  if (!presentation) return null;
  const BuiltinIcon = presentation.Icon;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      <BuiltinIcon
        className={cn(
          "size-full",
          presentation.kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground",
        )}
      />
    </span>
  );
}

function optionLabel(option: OpenWithOption, platform: string): string {
  if (option.type === "custom") return option.entry.name;
  if (option.id === "file-manager") {
    return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
  }
  return builtinPresentationById.get(option.id)?.label ?? option.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The application could not be opened.";
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  compact = false,
  enableShortcut = true,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: readonly EditorId[];
  openInCwd: string | null;
  compact?: boolean;
  enableShortcut?: boolean;
}) {
  const formId = useId();
  const settings = useClientSettings();
  const updateClientSettings = useUpdateClientSettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const canManageCustom =
    !compact &&
    environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    Boolean(window.desktopBridge);
  const [presentations, setPresentations] = useState<readonly OpenWithEntryPresentation[]>([]);
  const [optimisticIcons, setOptimisticIcons] = useState<Record<string, string | null>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OpenWithEntryKind>("other");
  const [directoryMode, setDirectoryMode] = useState<OpenWithDirectoryMode>("open-target");
  const [invocationType, setInvocationType] = useState<"mac-application" | "command">(
    isMacPlatform(navigator.platform) ? "mac-application" : "command",
  );
  const [applicationPath, setApplicationPath] = useState("");
  const [executable, setExecutable] = useState("");
  const [argumentRows, setArgumentRows] = useState<ArgumentRow[]>([]);
  const [formIcon, setFormIcon] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManageCustom) {
      setPresentations([]);
      return;
    }
    let active = true;
    void ensureLocalApi()
      .shell.resolveOpenWithPresentations()
      .then((next) => {
        if (active) setPresentations(next);
      })
      .catch(() => {
        if (active) setPresentations([]);
      });
    return () => {
      active = false;
    };
  }, [canManageCustom, settings.openWithEntries]);

  const resolvedPresentations = useMemo(() => {
    const byId = new Map(presentations.map((entry) => [entry.entryId, entry]));
    return settings.openWithEntries.map((entry) => {
      const resolved = byId.get(entry.id);
      const optimisticIcon = optimisticIcons[entry.id];
      return (
        resolved ?? {
          entryId: entry.id,
          available: true,
          iconDataUrl: optimisticIcon ?? null,
        }
      );
    });
  }, [optimisticIcons, presentations, settings.openWithEntries]);

  const options = useMemo(
    () =>
      mergeOpenWithOptions({
        availableEditors,
        customEntries: settings.openWithEntries,
        presentations: resolvedPresentations,
        includeCustomEntries: canManageCustom,
      }),
    [availableEditors, canManageCustom, resolvedPresentations, settings.openWithEntries],
  );
  const legacyPreferredEditor = readLegacyPreferredEditor();
  const preferredOption = useMemo(
    () =>
      resolveEffectiveOpenWith({
        options,
        preferred: settings.preferredOpenWith,
        legacyPreferredEditor,
      }),
    [legacyPreferredEditor, options, settings.preferredOpenWith],
  );
  const preferredRef = preferredOption ? refForOpenWithOption(preferredOption) : null;
  const shortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  const persistPreference = useCallback(
    (reference: OpenWithEntryRef) => updateClientSettings({ preferredOpenWith: reference }),
    [updateClientSettings],
  );

  const dispatch = useCallback(
    async (option: OpenWithOption, persist = true) => {
      if (!openInCwd) return;
      const reference = refForOpenWithOption(option);
      if (persist) persistPreference(reference);
      if (option.type === "custom") {
        if (option.presentation?.available === false) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `${option.entry.name} is unavailable`,
              description:
                option.presentation.unavailableReason ?? "Edit the application to repair it.",
            }),
          );
          return;
        }
        try {
          await ensureLocalApi().shell.openWith({
            environmentId: DESKTOP_PRIMARY_ENVIRONMENT_ID,
            entryId: option.entry.id,
            directory: openInCwd,
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Unable to open ${option.entry.name}`,
              description: errorMessage(error),
            }),
          );
        }
        return;
      }
      const result = await openInEditorMutation({
        environmentId,
        input: { cwd: openInCwd, editor: option.id },
      });
      if (result._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Unable to open ${optionLabel(option, navigator.platform)}`,
            description: "The selected application could not be launched.",
          }),
        );
      }
    },
    [environmentId, openInCwd, openInEditorMutation, persistPreference],
  );

  useEffect(() => {
    if (!enableShortcut) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings) || !preferredOption || !openInCwd) {
        return;
      }
      event.preventDefault();
      void dispatch(preferredOption, false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dispatch, enableShortcut, keybindings, openInCwd, preferredOption]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setName("");
    setKind("other");
    setDirectoryMode("open-target");
    setInvocationType(isMacPlatform(navigator.platform) ? "mac-application" : "command");
    setApplicationPath("");
    setExecutable("");
    setArgumentRows([]);
    setFormIcon(null);
    setValidationError(null);
  }, []);

  const openAddDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (entry: OpenWithEntry, presentation: OpenWithEntryPresentation | null) => {
    setEditingId(entry.id);
    setName(entry.name);
    setKind(entry.kind);
    setDirectoryMode(entry.directoryMode);
    setInvocationType(entry.invocation.type);
    setApplicationPath(
      entry.invocation.type === "mac-application" ? entry.invocation.applicationPath : "",
    );
    setExecutable(entry.invocation.type === "command" ? entry.invocation.executable : "");
    setArgumentRows(entry.arguments.map((argument) => makeArgumentRow(argument)));
    setFormIcon(presentation?.iconDataUrl ?? optimisticIcons[entry.id] ?? null);
    setValidationError(null);
    setDialogOpen(true);
  };

  const chooseApplication = async () => {
    try {
      const selection = await ensureLocalApi().dialogs.pickOpenWithApplication();
      if (!selection) return;
      setApplicationPath(selection.applicationPath);
      setName((current) => current.trim() || selection.suggestedName);
      setFormIcon(selection.iconDataUrl);
      setValidationError(null);
    } catch (error) {
      setValidationError(errorMessage(error));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidationError("Name is required.");
      return;
    }
    if (invocationType === "mac-application" && !applicationPath) {
      setValidationError("Choose an application first.");
      return;
    }
    if (invocationType === "command" && !executable.trim()) {
      setValidationError("Executable is required.");
      return;
    }
    if (
      directoryMode === "custom-arguments" &&
      !argumentRows.some((argument) => argument.value.includes("{directory}"))
    ) {
      setValidationError("Custom arguments must include at least one {directory} placeholder.");
      return;
    }

    try {
      const id =
        editingId ??
        nextOpenWithEntryId(
          trimmedName,
          settings.openWithEntries.map((entry) => entry.id),
        );
      const nextEntry = decodeOpenWithEntry({
        id,
        name: trimmedName,
        kind,
        invocation:
          invocationType === "mac-application"
            ? { type: "mac-application", applicationPath }
            : { type: "command", executable: executable.trim() },
        directoryMode,
        arguments: argumentRows.map((argument) => argument.value),
      });
      const entries = editingId
        ? settings.openWithEntries.map((entry) => (entry.id === editingId ? nextEntry : entry))
        : [...settings.openWithEntries, nextEntry];
      updateClientSettings({
        openWithEntries: entries,
        ...(editingId === null ? { preferredOpenWith: { type: "custom", id: nextEntry.id } } : {}),
      });
      if (formIcon !== null) {
        setOptimisticIcons((current) => ({ ...current, [nextEntry.id]: formIcon }));
      }
      setDialogOpen(false);
    } catch (error) {
      setValidationError(errorMessage(error));
    }
  };

  const deleteEntry = () => {
    if (!editingId) return;
    const deletingPreferred =
      settings.preferredOpenWith?.type === "custom" && settings.preferredOpenWith.id === editingId;
    updateClientSettings({
      openWithEntries: settings.openWithEntries.filter((entry) => entry.id !== editingId),
      ...(deletingPreferred ? { preferredOpenWith: null } : {}),
    });
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
  };

  return (
    <>
      <Group aria-label="Open with application">
        <Button
          aria-label={compact ? "Open file in preferred editor" : "Open in preferred application"}
          size="xs"
          variant="outline"
          disabled={!preferredOption || !openInCwd}
          onClick={() => preferredOption && void dispatch(preferredOption)}
        >
          {preferredOption && <OptionIcon option={preferredOption} className="size-3.5" />}
          <span
            className={
              compact
                ? "sr-only"
                : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5"
            }
          >
            Open
          </span>
        </Button>
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
        <Menu highlightItemOnHover={false}>
          <MenuTrigger
            render={
              <Button
                aria-label={compact ? "Choose editor" : "Choose application"}
                size="icon-xs"
                variant="outline"
              />
            }
          >
            <ChevronDownIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
            {options.map((option) => {
              const reference = refForOpenWithOption(option);
              const isEffective =
                preferredRef?.type === reference.type && preferredRef.id === reference.id;
              const unavailable =
                option.type === "custom" && option.presentation?.available === false;
              return (
                <MenuItem
                  key={`${reference.type}:${reference.id}`}
                  className="group data-highlighted:bg-transparent hover:bg-accent data-highlighted:hover:bg-accent"
                  onClick={() => void dispatch(option)}
                >
                  <OptionIcon option={option} />
                  <span className={cn("truncate", unavailable && "text-muted-foreground")}>
                    {optionLabel(option, navigator.platform)}
                  </span>
                  {unavailable && <TriangleAlertIcon className="ml-auto size-3.5 text-warning" />}
                  {option.type === "custom" ? (
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {isEffective && shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${option.entry.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(option.entry, option.presentation);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  ) : (
                    isEffective && shortcutLabel && <MenuShortcut>{shortcutLabel}</MenuShortcut>
                  )}
                </MenuItem>
              );
            })}
            {canManageCustom && (
              <>
                {options.length > 0 && <MenuSeparator />}
                <MenuItem onClick={openAddDialog}>
                  <PlusIcon className="size-4" />
                  Add application
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      </Group>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onOpenChangeComplete={(open) => {
          if (!open) resetForm();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Application" : "Add Application"}</DialogTitle>
            <DialogDescription>
              Applications are stored on this desktop and open the active worktree directory.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={formId} className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <div className="flex items-center gap-2">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                    {formIcon ? (
                      <img alt="" src={formIcon} className="size-6 rounded-sm" />
                    ) : (
                      (() => {
                        const CategoryIcon = categoryIcon(kind);
                        return <CategoryIcon className="size-4.5 text-muted-foreground" />;
                      })()
                    )}
                  </div>
                  <Input
                    id={`${formId}-name`}
                    autoFocus
                    value={name}
                    placeholder="Terminal"
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => setKind(value as OpenWithEntryKind)}
                  >
                    <SelectTrigger>
                      <SelectValue>{OPEN_WITH_KIND_LABELS[kind]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.entries(OPEN_WITH_KIND_LABELS) as [OpenWithEntryKind, string][]).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Session directory behavior</Label>
                  <Select
                    value={directoryMode}
                    onValueChange={(value) => setDirectoryMode(value as OpenWithDirectoryMode)}
                  >
                    <SelectTrigger>
                      <SelectValue>{DIRECTORY_MODE_LABELS[directoryMode]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {(
                        Object.entries(DIRECTORY_MODE_LABELS) as [OpenWithDirectoryMode, string][]
                      ).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              {invocationType === "mac-application" ? (
                <div className="space-y-2">
                  <Label>Application</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={applicationPath} placeholder="Choose a .app bundle" />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void chooseApplication()}
                    >
                      Choose Application
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setInvocationType("command")}
                  >
                    Configure command manually
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor={`${formId}-executable`}>Executable</Label>
                  <Input
                    id={`${formId}-executable`}
                    value={executable}
                    placeholder={isWindowsPlatform(navigator.platform) ? "code.cmd" : "code"}
                    onChange={(event) => setExecutable(event.target.value)}
                  />
                  {isMacPlatform(navigator.platform) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setInvocationType("mac-application")}
                    >
                      Choose a macOS application
                    </Button>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Arguments</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setArgumentRows((current) => [...current, makeArgumentRow()])}
                  >
                    <PlusIcon className="size-3.5" /> Add argument
                  </Button>
                </div>
                {argumentRows.map((argument, index) => (
                  <div key={argument.id} className="flex gap-2">
                    <Input
                      aria-label={`Argument ${index + 1}`}
                      value={argument.value}
                      onChange={(event) =>
                        setArgumentRows((current) =>
                          current.map((row) =>
                            row.id === argument.id ? { ...row, value: event.target.value } : row,
                          ),
                        )
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove argument ${index + 1}`}
                      onClick={() =>
                        setArgumentRows((current) =>
                          current.filter((row) => row.id !== argument.id),
                        )
                      }
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                ))}
                {directoryMode === "custom-arguments" && (
                  <p className="text-xs text-muted-foreground">
                    Include <code>{"{directory}"}</code> in at least one argument. Each row is
                    passed as one argument without shell parsing.
                  </p>
                )}
              </div>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter>
            {editingId && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button form={formId} type="submit">
              {editingId ? "Save changes" : "Save application"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete application "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This local application preference will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={deleteEntry}>
              Delete application
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
