import type { ClientSettings, LookTheme, SavedLook } from "@t3tools/contracts/settings";
import {
  ClipboardCopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  EllipsisIcon,
  FileUpIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";

import {
  assignLook,
  deleteLook,
  exportLook,
  importLook,
  lookProjectKeys,
  nextLookName,
  resolveProjectLook,
  restoreLook,
  setLookProjects,
} from "../../customizationLooks";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import {
  getActiveLookProjectKey,
  getClientSettings,
  persistClientSettingsUpdate,
  useActiveLookProjectKey,
  useClientSettings,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { randomUUID } from "../../lib/utils";
import { deriveLogicalProjectKey } from "../../logicalProject";
import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  ThemePreviewCircle,
} from "../settings/ThemePreviewCircles";
import { MAINTAINER_THEMES } from "../settings/ThemeSettings";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SelectButton } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  pickCustomizeSettings,
  readThemeStorageSnapshot,
  THEME_STORAGE_KEYS,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";

import { LookNameInput } from "./LookNameInput";

const DEFAULT_VALUE = "default";
const MAX_LOOK_FILE_BYTES = 1024 * 1024;

/** Undo history belongs to one editing target; switching looks starts fresh. */
function resetHistory() {
  const store = useCustomizeInterfaceStore.getState();
  if (store.active) {
    store.close();
    store.open();
  }
}

function toastError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    }),
  );
}

/** Default's theme lives in plain storage; a look's theme is its snapshot. */
function readDefaultTheme(): LookTheme {
  return Object.fromEntries(
    THEME_STORAGE_KEYS.map((key) => [key, window.localStorage.getItem(key)]),
  ) as LookTheme;
}

function LookSwatch({ theme }: { theme: LookTheme }) {
  const { resolvedTheme } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const storedMode = theme["t3code:theme-appearance-mode"];
  const mode = storedMode === "light" || storedMode === "dark" ? storedMode : resolvedTheme;
  let themeId = theme["t3code:theme"];
  try {
    const halves: unknown = JSON.parse(theme["t3code:theme-halves:v1"] ?? "null");
    const half = halves && typeof halves === "object" ? Reflect.get(halves, mode) : undefined;
    if (typeof half === "string") themeId = half;
  } catch {
    // A malformed mix falls back to the single theme.
  }
  const definition = [...customThemes, ...environmentThemes, ...MAINTAINER_THEMES].find(
    (candidate) => candidate.id === themeId,
  );
  const card = definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0];
  const colors = card ? (previewColorsOf(card, mode) ?? card.previews[0]?.colors) : undefined;
  if (!colors) return null;
  return <ThemePreviewCircle colors={colors} mode={mode} className="size-3.5 shrink-0 border" />;
}

type LogicalProject = {
  key: string;
  project: ReturnType<typeof useProjects>[number];
};

function useLogicalProjects(): LogicalProject[] {
  const projects = useProjects();
  const byKey = new Map<string, LogicalProject>();
  for (const project of projects) {
    const key = deriveLogicalProjectKey(project);
    if (!byKey.has(key)) byKey.set(key, { key, project });
  }
  return [...byKey.values()].sort((a, b) => a.project.title.localeCompare(b.project.title));
}

function projectSummary(titles: readonly string[]) {
  if (titles.length === 0) return "No projects";
  if (titles.length <= 2) return titles.join(", ");
  return `${titles.slice(0, 2).join(", ")} +${titles.length - 2}`;
}

function useLooks() {
  const settings = useClientSettings();
  const projectKey = useActiveLookProjectKey();
  const projects = useLogicalProjects();
  const active = resolveProjectLook(settings, projectKey);
  // Without a project (Settings, home) the picker chooses which look to manage.
  const [managedId, setManagedId] = useState<string | null>(null);
  const selected = projectKey
    ? active
    : (settings.savedLooks.find((look) => look.id === managedId) ?? null);

  const update = async (
    title: string,
    change: (current: ClientSettings) => ClientSettings,
  ): Promise<boolean> => {
    try {
      await persistClientSettingsUpdate(change);
      return true;
    } catch (error) {
      toastError(title, error);
      return false;
    }
  };

  const chooseLook = async (lookId: string | null) => {
    if (!projectKey) {
      setManagedId(lookId);
      return;
    }
    if (await update("Could not change the look", (c) => assignLook(c, [projectKey], lookId))) {
      resetHistory();
    }
  };

  const addLook = async (look: SavedLook, assignHere: boolean) => {
    const ok = await update("Could not save the look", (current) => {
      const next = { ...current, savedLooks: [...current.savedLooks, look] };
      return assignHere && projectKey ? assignLook(next, [projectKey], look.id) : next;
    });
    if (!ok) return false;
    if (!projectKey) setManagedId(look.id);
    if (assignHere) resetHistory();
    return true;
  };

  const offerUseHere = (look: SavedLook, title: string) => {
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title,
        ...(projectKey
          ? {
              actionProps: { children: "Use for this project", onClick: () => chooseLook(look.id) },
            }
          : {}),
      }),
    );
  };

  return {
    settings,
    projectKey,
    projects,
    active,
    selected,
    projectTitle: projects.find((entry) => entry.key === projectKey)?.project.title ?? null,
    chooseLook,
    saveCurrentAsNew: async () => {
      const look: SavedLook = {
        id: randomUUID(),
        name: nextLookName(getClientSettings().savedLooks),
        settings: pickCustomizeSettings(getClientSettings()),
        theme: readThemeStorageSnapshot(),
      };
      return (await addLook(look, true)) ? look : null;
    },
    rename: (look: SavedLook, name: string) =>
      update("Could not rename the look", (current) => ({
        ...current,
        savedLooks: current.savedLooks.map((entry) =>
          entry.id === look.id ? { ...entry, name } : entry,
        ),
      })),
    duplicate: async (look: SavedLook) => {
      const copy = { ...look, id: randomUUID(), name: `${look.name} copy` };
      if (await addLook(copy, false)) offerUseHere(copy, `Duplicated as “${copy.name}”`);
    },
    saveChanges: async (look: SavedLook) => {
      const snapshot = {
        settings: pickCustomizeSettings(getClientSettings()),
        theme: readThemeStorageSnapshot(),
      };
      const ok = await update("Could not save the look", (current) => ({
        ...current,
        savedLooks: current.savedLooks.map((entry) =>
          entry.id === look.id ? { ...entry, ...snapshot } : entry,
        ),
      }));
      if (ok)
        toastManager.add({ type: "success", title: `Saved current settings to “${look.name}”` });
    },
    copyJson: async (look: SavedLook) => {
      try {
        await navigator.clipboard.writeText(exportLook(look));
        toastManager.add({ type: "success", title: "Look JSON copied" });
      } catch (error) {
        toastError("Could not copy the look", error);
      }
    },
    download: (look: SavedLook) => {
      const url = URL.createObjectURL(new Blob([exportLook(look)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${look.name.replace(/[^\w.-]+/g, "-").toLowerCase() || "t3"}.look.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    /** Throws on invalid JSON so the import form can show the error inline. */
    importJson: async (source: string) => {
      const look = importLook(source, randomUUID());
      if (await addLook(look, false)) offerUseHere(look, `Imported “${look.name}”`);
    },
    remove: async (look: SavedLook) => {
      const before = getClientSettings();
      const index = before.savedLooks.findIndex((entry) => entry.id === look.id);
      const keys = lookProjectKeys(before, look.id);
      if (!(await update("Could not delete the look", (current) => deleteLook(current, look.id)))) {
        return;
      }
      if (managedId === look.id) setManagedId(null);
      resetHistory();
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Deleted “${look.name}”`,
          ...(keys.length > 0
            ? {
                description: `${keys.length === 1 ? "Its project" : `Its ${keys.length} projects`} now use${keys.length === 1 ? "s" : ""} Default.`,
              }
            : {}),
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(toastId);
              void update("Could not restore the look", (current) =>
                restoreLook(current, look, index, keys),
              ).then((ok) => {
                if (!ok) return;
                if (!getActiveLookProjectKey()) setManagedId(look.id);
                resetHistory();
              });
            },
          },
        }),
      );
    },
    setProjects: async (look: SavedLook | null, keys: readonly string[]) => {
      const ok = await update("Could not change the looks", (current) =>
        look ? setLookProjects(current, look.id, keys) : assignLook(current, keys, null),
      );
      if (ok) resetHistory();
      return ok;
    },
  };
}

type Looks = ReturnType<typeof useLooks>;

function LookPicker({
  looks,
  renaming,
  onRenameDone,
  onCreated,
}: {
  looks: Looks;
  renaming: boolean;
  onRenameDone: () => void;
  onCreated: () => void;
}) {
  const { settings, selected, projectKey } = looks;
  if (renaming && selected) {
    return (
      <LookNameInput
        key={selected.id}
        look={selected}
        onRename={(name) => void looks.rename(selected, name)}
        onDone={onRenameDone}
      />
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<SelectButton size="sm" className="min-w-0 flex-1" aria-label="Look" />}>
        <span className="flex min-w-0 items-center gap-2">
          <LookSwatch theme={selected?.theme ?? readDefaultTheme()} />
          <span className="truncate">{selected?.name ?? "Default"}</span>
        </span>
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>{projectKey ? "Look for this project" : "Manage look"}</MenuGroupLabel>
          <MenuRadioGroup
            value={selected?.id ?? DEFAULT_VALUE}
            onValueChange={(value: string) =>
              void looks.chooseLook(value === DEFAULT_VALUE ? null : value)
            }
          >
            <MenuRadioItem value={DEFAULT_VALUE} closeOnClick>
              <span className="flex items-center gap-2">
                <LookSwatch theme={readDefaultTheme()} />
                <span className="flex-1 truncate">Default</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            {settings.savedLooks.map((look) => {
              const count = lookProjectKeys(settings, look.id).length;
              return (
                <MenuRadioItem key={look.id} value={look.id} closeOnClick>
                  <span className="flex items-center gap-2">
                    <LookSwatch theme={look.theme} />
                    <span className="min-w-0 flex-1 truncate">{look.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {count === 0 ? "" : count === 1 ? "1 project" : `${count} projects`}
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void looks.saveCurrentAsNew().then((look) => {
              if (!look) return;
              onCreated();
            })
          }
        >
          <PlusIcon />
          Save current as new look…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ImportLookPopover({
  looks,
  open,
  onOpenChange,
  anchor,
}: {
  looks: Looks;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submit = async (source: string | File) => {
    if (inFlight.current) return;
    if (typeof source !== "string" && source.size > MAX_LOOK_FILE_BYTES) {
      setError("That file is too large. Choose a look file no larger than 1 MiB.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      let text: string;
      if (typeof source === "string") text = source;
      else {
        try {
          text = await source.text();
        } catch {
          setError("Couldn’t read that file.");
          return;
        }
        setJson(text);
      }
      await looks.importJson(text);
      setJson("");
      setError(null);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "That isn’t valid JSON."
          : "That isn’t a T3 Code look. Use Copy look JSON or Download look to export one.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        align="end"
        width="md"
        initialFocus={textareaRef}
        finalFocus={anchor}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(json);
          }}
        >
          <div className="space-y-1.5">
            <PopoverTitle>Import a look</PopoverTitle>
            <p className="text-xs text-muted-foreground">
              Paste look JSON or choose a file. Importing doesn’t change any project.
            </p>
          </div>
          <Textarea
            ref={textareaRef}
            size="sm"
            aria-label="Look JSON"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            rows={4}
            placeholder='{ "version": 1, "name": … }'
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setError(null);
            }}
          />
          <p
            id={`${id}-error`}
            role="alert"
            className="min-h-4 text-xs text-destructive-foreground empty:hidden"
          >
            {error}
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void submit(file);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="me-auto"
              disabled={pending}
              onClick={() => fileRef.current?.click()}
            >
              <FileUpIcon />
              Choose file…
            </Button>
            <Button size="sm" type="submit" disabled={pending || !json.trim()}>
              Import
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LookActionsMenu({
  looks,
  onRename,
  onImport,
  triggerRef,
}: {
  looks: Looks;
  onRename: () => void;
  onImport: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { selected, active } = looks;
  // Rename and Import move focus elsewhere, so the menu must not pull it back.
  const keepFocus = useRef(false);
  return (
    <Menu>
      <MenuTrigger
        ref={triggerRef}
        render={<Button size="icon-sm" variant="ghost" aria-label="Look actions" />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup
        align="end"
        finalFocus={() => {
          const restore = !keepFocus.current;
          keepFocus.current = false;
          return restore;
        }}
      >
        {selected ? (
          <>
            <MenuItem
              onClick={() => {
                keepFocus.current = true;
                onRename();
              }}
            >
              <PencilIcon />
              Rename
            </MenuItem>
            <MenuItem onClick={() => void looks.duplicate(selected)}>
              <CopyPlusIcon />
              Duplicate
            </MenuItem>
            {selected.id === active?.id ? null : (
              <MenuItem onClick={() => void looks.saveChanges(selected)}>
                <SaveIcon />
                Save current settings to look
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem onClick={() => void looks.copyJson(selected)}>
              <ClipboardCopyIcon />
              Copy look JSON
            </MenuItem>
            <MenuItem onClick={() => looks.download(selected)}>
              <DownloadIcon />
              Download look
            </MenuItem>
          </>
        ) : null}
        <MenuItem
          onClick={() => {
            keepFocus.current = true;
            onImport();
          }}
        >
          <UploadIcon />
          Import look…
        </MenuItem>
        {selected ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void looks.remove(selected)}>
              <Trash2Icon />
              Delete look
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function AppliesTo({ looks, className }: { looks: Looks; className?: string }) {
  const { settings, selected, projects } = looks;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<readonly string[]>([]);
  if (!selected) {
    return (
      <span className={`truncate text-right text-xs text-muted-foreground ${className ?? ""}`}>
        Projects without a look
      </span>
    );
  }
  const assigned = lookProjectKeys(settings, selected.id);
  const titles = projects
    .filter((entry) => assigned.includes(entry.key))
    .map((entry) => entry.project.title);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? projects.filter((entry) => entry.project.title.toLowerCase().includes(needle))
    : projects;
  const unchanged =
    checked.length === assigned.length && checked.every((key) => assigned.includes(key));
  const finish = (keys: readonly string[], look: SavedLook | null) =>
    void looks.setProjects(look, keys).then((ok) => {
      if (ok) setOpen(false);
    });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setChecked(lookProjectKeys(getClientSettings(), selected.id));
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        render={<SelectButton size="sm" className={className} aria-label="Applies to" />}
      >
        <span className={titles.length === 0 ? "text-muted-foreground" : undefined}>
          {projectSummary(titles)}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" width="sm" padding="none">
        <div className="border-b p-2">
          <Input
            size="sm"
            type="search"
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div role="group" aria-label={`Projects using ${selected.name}`} className="p-1">
          <div className="max-h-60 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {projects.length === 0 ? "No projects yet" : "No matching projects"}
              </p>
            ) : (
              visible.map(({ key, project }) => {
                const current = resolveProjectLook(settings, key);
                return (
                  <label
                    key={key}
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-accent/60"
                  >
                    <Checkbox
                      checked={checked.includes(key)}
                      onCheckedChange={(value) =>
                        setChecked((keys) =>
                          value ? [...keys, key] : keys.filter((entry) => entry !== key),
                        )
                      }
                    />
                    <ProjectFavicon project={project} className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{project.title}</span>
                    <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                      {current?.name ?? "Default"}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t p-2">
          <span className="me-auto ps-1 text-xs text-muted-foreground tabular-nums">
            {checked.length} selected
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={checked.length === 0}
            onClick={() => finish(checked, null)}
          >
            Use Default
          </Button>
          <Button size="xs" disabled={unchanged} onClick={() => finish(checked, selected)}>
            Apply
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function LookControls({ looks }: { looks: Looks }) {
  const [renaming, setRenaming] = useState(false);
  const [importing, setImporting] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex w-44 items-center gap-1">
      <LookPicker
        looks={looks}
        renaming={renaming}
        onRenameDone={() => setRenaming(false)}
        onCreated={() => setRenaming(true)}
      />
      <LookActionsMenu
        looks={looks}
        triggerRef={moreRef}
        onRename={() => setRenaming(true)}
        onImport={() => setImporting(true)}
      />
      <ImportLookPopover
        looks={looks}
        open={importing}
        onOpenChange={setImporting}
        anchor={moreRef}
      />
    </div>
  );
}

function PopoverRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 px-4">
      <div className="min-w-0 flex-1 truncate text-sm">{label}</div>
      {children}
    </div>
  );
}

/**
 * Saved looks: which one this project uses, where else it applies, and the
 * rarer actions behind one menu. Settings shows the same controls as rows.
 */
export function LooksSection({ variant = "popover" }: { variant?: "popover" | "settings" }) {
  const looks = useLooks();
  const { active, projectKey, projectTitle, settings } = looks;
  const sharedWith = active ? lookProjectKeys(settings, active.id).length : 0;
  const hint =
    active && projectKey
      ? `Edits update “${active.name}” for ${sharedWith === 1 ? "this project" : sharedWith === 2 ? "both projects using it" : `all ${sharedWith} projects using it`}.`
      : null;

  if (variant === "settings") {
    return (
      <SettingsSection title="Looks">
        <SettingsRow
          title="Look"
          description="Save the layout, theme, and text settings under a name, then use it for any project."
          control={<LookControls looks={looks} />}
        />
        <SettingsRow
          title="Applies to"
          description={
            looks.selected
              ? "Projects using this look. Assignments stay on this device."
              : "Projects without a look use Default."
          }
          control={<AppliesTo looks={looks} className="w-44" />}
        />
      </SettingsSection>
    );
  }

  return (
    <section aria-label="Looks" className="border-b border-border/70 py-1.5">
      <PopoverRow
        label={
          <>
            Look
            {projectTitle ? <span className="text-muted-foreground"> · {projectTitle}</span> : null}
          </>
        }
      >
        <LookControls looks={looks} />
      </PopoverRow>
      <PopoverRow label="Applies to">
        <AppliesTo looks={looks} className="w-44" />
      </PopoverRow>
      {hint ? <p className="px-4 pt-0.5 pb-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </section>
  );
}
