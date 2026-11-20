import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { FileUpIcon, FileXIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import type { ChangeEvent, DragEvent, UIEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import {
  getCustomThemes,
  installCustomTheme,
  removeCustomTheme,
  renameTheme,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import {
  humanizeThemeName,
  pairVsCodeThemes,
  parseThemeImport,
  resolveThemeLabelCollisions,
} from "../../vscodeThemeImport";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ThemeSearchSection } from "./ThemeSearchSection";
import { msg, T, useGT } from "gt-react";
import { m } from "../../i18n/messages";

/**
 * The guard runs on the size before the bytes are ever read: a large file
 * would otherwise be pulled into memory, highlighted, and rendered, which
 * locks the UI for as long as that takes.
 */
const MAX_THEME_FILE_BYTES = 256 * 1024;

/** Highlighting rebuilds markup per keystroke; fall back to plain text for oversized pastes. */
const MAX_HIGHLIGHTED_JSON_LENGTH = 20_000;

function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return m(
    msg(
      "That file is {size}. Theme files are only a few KB, so this one was not read (limit {limit}).",
      { size: formatBytes(bytes), limit: formatBytes(MAX_THEME_FILE_BYTES) },
    ),
  );
}

function isThemeIdTaken(themeId: string): boolean {
  return getCustomThemes().some((existing) => existing.id === themeId);
}

function escapeJsonHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function highlightJson(value: string): string {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escapeJsonHtml(value.slice(cursor, index));

    let tokenClass = "text-[var(--app-theme-secondary-foreground,var(--color-amber-600))]";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "text-[var(--app-theme-accent,var(--color-blue-600))]"
        : "text-[var(--app-theme-message-action,var(--color-emerald-600))]";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "text-[var(--app-theme-accent-surface-foreground,var(--color-violet-600))]";
    }
    highlighted += `<span class="${tokenClass}">${escapeJsonHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeJsonHtml(value.slice(cursor));
}

function ThemeJsonEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const gt = useGT();
  const highlightRef = useRef<HTMLPreElement>(null);
  const isPlainText = value.length > MAX_HIGHLIGHTED_JSON_LENGTH;
  const highlightedJson = value.length > MAX_HIGHLIGHTED_JSON_LENGTH ? "" : highlightJson(value);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="relative overflow-hidden rounded-control border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-3 focus-within:ring-inset focus-within:ring-ring/24">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-caption leading-5 text-foreground"
        >
          <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </pre>
      )}
      <textarea
        aria-label={gt("Theme JSON")}
        className={cn(
          "relative z-10 block min-h-16 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-caption leading-5 caret-foreground outline-none placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
          isPlainText ? "text-foreground" : "text-transparent",
        )}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          // oxlint-disable-next-line t3code/no-untranslated-copy -- example theme JSON
          '{ "name": "Aurora", "type": "dark",\n  "colors": { "editor.background": "#0b0e14", … } }'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

type ImportableThemeFile = { name: string; size: number; text: () => Promise<string> };

/** A file waiting in the list until Add theme installs it. */
type StagedThemeFile = Readonly<{
  fileName: string;
  text: string | null;
  theme: ThemeDefinition | null;
  error: string | null;
}>;

// Background, sidebar, accent, then a status hue so two themes sharing an
// accent still read apart in the row.
const SWATCH_ROLES = ["canvas", "sidebar", "accent", "warning"] as const;

function parseThemeText(text: string): ThemeDefinition {
  return parseThemeImport(text);
}

async function stageThemeFile(file: ImportableThemeFile): Promise<StagedThemeFile> {
  const oversized = describeOversizedThemeFile(file.size);
  if (oversized) return { fileName: file.name, text: null, theme: null, error: oversized };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return {
      fileName: file.name,
      text: null,
      theme: null,
      error: m(msg("Could not read that file. Paste the JSON below instead.")),
    };
  }
  try {
    return { fileName: file.name, text, theme: parseThemeText(text), error: null };
  } catch {
    return {
      fileName: file.name,
      text,
      theme: null,
      error: m(msg("That theme file is invalid.")),
    };
  }
}

const isInstalledTheme = (theme: ThemeDefinition) => isThemeIdTaken(theme.id);

function versionedCopy(theme: ThemeDefinition, preferredName?: string | null): ThemeDefinition {
  // renameTheme leaves the collection behind: updating a collection replaces every theme in it.
  if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
    const candidate = renameTheme(theme, preferredName.slice(0, 48));
    if (!isThemeIdTaken(candidate.id)) return candidate;
  }
  for (let copy = 1; copy < 100; copy += 1) {
    const candidate = renameTheme(
      theme,
      `${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`,
    );
    if (!isThemeIdTaken(candidate.id)) return candidate;
  }
  throw new Error(m(msg('Too many copies of "{label}".', { label: theme.label })));
}

function StagedThemeRow({ file, onRemove }: { file: StagedThemeFile; onRemove: () => void }) {
  const gt = useGT();
  const { theme } = file;
  const removeButton = (
    <Button
      aria-label={gt("Remove {name}", { name: file.fileName })}
      onClick={onRemove}
      size="icon-xs"
      variant="ghost-muted"
    >
      <XIcon />
    </Button>
  );
  if (!theme) {
    return (
      <li className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex h-6 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-error-foreground">
          <FileXIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-label text-muted-foreground">{file.fileName}</p>
          <p className="text-error-foreground text-meta">{file.error}</p>
        </div>
        {removeButton}
      </li>
    );
  }
  const installed = isInstalledTheme(theme);
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="flex h-6 w-10 shrink-0 overflow-hidden rounded-md border border-border">
        {SWATCH_ROLES.map((role) => (
          <span className="flex-1" key={role} style={{ backgroundColor: theme.colors[role] }} />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">{theme.label}</p>
        <p className="truncate text-muted-foreground text-meta">{file.fileName}</p>
      </div>
      <Badge size="lg" variant={installed ? "unavailable" : "secondary"}>
        {installed ? gt("Already installed") : gt("Theme file")}
      </Badge>
      {removeButton}
    </li>
  );
}

interface ThemeImportCallbacks {
  onImported: (theme: ThemeDefinition) => boolean;
  onImportedMany: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}

export function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
  onImportedMany,
}: ThemeImportCallbacks & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Each opening is a fresh session: its body remounts with clean state, and
  // closing aborts every read, search, and install the session started.
  const [session, setSession] = useState(() => ({
    open,
    id: 0,
    controller: new AbortController(),
  }));
  if (session.open !== open) {
    setSession(
      open ? { open, id: session.id + 1, controller: new AbortController() } : { ...session, open },
    );
  }
  const close = () => {
    session.controller.abort();
    onOpenChange(false);
  };
  // Leaving the page ends the session as closing does. The abort waits a microtask
  // so StrictMode's replayed cleanup, undone by its replayed setup, keeps it alive.
  const { controller } = session;
  const mountedController = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unmounting must abort in-flight Open VSX installs
  useEffect(() => {
    mountedController.current = controller;
    return () => {
      mountedController.current = null;
      queueMicrotask(() => {
        if (mountedController.current !== controller) controller.abort();
      });
    };
  }, [controller]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogPopup className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            <T>Add a theme</T>
          </DialogTitle>
          <DialogDescription>
            <T>T3 Code or VS Code color themes.</T>
          </DialogDescription>
        </DialogHeader>
        <ThemeImportBody
          key={session.id}
          session={session.controller}
          onClose={close}
          onImported={onImported}
          onImportedMany={onImportedMany}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ThemeImportBody({
  session,
  onClose,
  onImported,
  onImportedMany,
}: ThemeImportCallbacks & {
  session: AbortController;
  onClose: () => void;
}) {
  const gt = useGT();
  const { signal } = session;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchSession, setSearchSession] = useState<AbortController | null>(null);
  const [staged, setStaged] = useState<ReadonlyArray<StagedThemeFile>>([]);
  const [json, setJson] = useState("");
  // The staged file whose text fills the JSON field; edits there replace it.
  const [jsonSource, setJsonSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  // A newer read supersedes an older one still in flight.
  const importRequestRef = useRef(0);
  const isCurrentRequest = (requestId: number) =>
    requestId === importRequestRef.current && !signal.aborted;

  const openSearch = () => {
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), {
      once: true,
      signal: controller.signal,
    });
    setSearchSession(controller);
  };

  const closeSearch = () => {
    searchSession?.abort();
    setSearchSession(null);
  };

  // Files are read and checked as they arrive, then wait in the list so the
  // whole batch installs together. A lone file also fills the JSON field for
  // review, as long as nothing was pasted there.
  const readThemeFiles = async (files: ReadonlyArray<ImportableThemeFile>) => {
    if (signal.aborted || files.length === 0) return;
    const requestId = ++importRequestRef.current;
    setIsReading(true);
    await Promise.all(files.map(stageThemeFile))
      .then((read) => {
        if (!isCurrentRequest(requestId)) return;
        const names = new Set(read.map((file) => file.fileName));
        const next = [...staged.filter((file) => !names.has(file.fileName)), ...read];
        setStaged(next);
        setError(null);
        const lone = next.length === 1 ? next[0] : undefined;
        if (lone?.text != null && (!json.trim() || jsonSource !== null)) {
          setJson(lone.text);
          setJsonSource(lone.fileName);
        }
      })
      .finally(() => {
        if (isCurrentRequest(requestId)) setIsReading(false);
      });
  };

  const openFilePicker = () => {
    const bridge = window.desktopBridge;
    if (bridge) {
      void bridge.pickThemeFiles().then((picked) => {
        if (signal.aborted || !picked || picked.length === 0) return;
        void readThemeFiles(
          picked.map((file) => ({
            name: file.name,
            size: file.size,
            text: () => Promise.resolve(file.text),
          })),
        );
      });
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    void readThemeFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    void readThemeFiles([...event.dataTransfer.files]);
  };

  // What Add theme would install: every valid staged file, with the JSON
  // field standing in for the file it was filled from (or added on its own
  // when pasted), and VS Code light/dark families paired into one theme.
  const pending = (() => {
    const entries: Array<{ theme: ThemeDefinition; sourceName?: string | undefined }> = [];
    for (const file of staged) {
      if (file.fileName === jsonSource || !file.theme) continue;
      entries.push({ theme: file.theme, sourceName: file.fileName });
    }
    let jsonError: string | null = null;
    if (json.trim()) {
      const oversized = describeOversizedThemeFile(json.length);
      if (oversized) jsonError = oversized;
      else {
        try {
          entries.push({ theme: parseThemeText(json), sourceName: jsonSource ?? undefined });
        } catch (cause) {
          jsonError = cause instanceof Error ? cause.message : gt("That theme file is invalid.");
        }
      }
    }
    const themes = pairVsCodeThemes(resolveThemeLabelCollisions(entries));
    return {
      themes,
      jsonError,
      newCount: themes.filter((theme) => !isInstalledTheme(theme)).length,
    };
  })();

  const resolveConflicts = (mode: "update" | "copy") => {
    if (!conflicts) return;
    const resolved: ThemeDefinition[] = [];
    const failures: string[] = [];
    const fileName = staged.length === 1 ? staged[0]!.fileName : null;
    const preferredName =
      conflicts.length === 1 && fileName
        ? humanizeThemeName(fileName.replace(/\.[^.]+$/, ""))
        : null;
    for (const theme of conflicts) {
      try {
        const existingTheme =
          mode === "update"
            ? getCustomThemes().find((candidate) => candidate.id === theme.id)
            : undefined;
        const themeToUpdate = existingTheme?.collection
          ? { ...theme, collection: existingTheme.collection }
          : theme;
        resolved.push(
          mode === "update"
            ? updateCustomTheme(themeToUpdate)
            : installCustomTheme(versionedCopy(theme, preferredName)),
        );
      } catch (cause) {
        failures.push(
          `${theme.label}: ${cause instanceof Error ? (thrownErrorMessage(cause, m) ?? cause.message) : gt("failed", { $context: "theme import result" })}`,
        );
      }
    }
    if (resolved.length > 0) onImportedMany(resolved, { updated: mode === "update" });
    setConflicts(null);
    if (failures.length > 0) setError([error, ...failures].filter(Boolean).join("; "));
    else if (!error) onClose();
  };

  const handleSubmit = () => {
    if (pending.jsonError) {
      setError(pending.jsonError);
      return;
    }
    const fresh = pending.themes.filter((theme) => !isInstalledTheme(theme));
    const conflicting = pending.themes.filter(isInstalledTheme);
    setError(null);

    const failures = staged
      .filter((file) => file.fileName !== jsonSource && file.error !== null)
      .map((file) => `${file.fileName}: ${file.error}`);

    // A single theme is selected right away; batches install quietly.
    if (fresh.length === 1 && conflicting.length === 0 && failures.length === 0) {
      try {
        const installedTheme = installCustomTheme(fresh[0]!);
        if (!onImported(installedTheme)) {
          try {
            removeCustomTheme(installedTheme.id);
          } catch {}
          setError(gt("Theme added, but it could not be selected. Try again."));
          return;
        }
        onClose();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? (thrownErrorMessage(cause, m) ?? cause.message)
            : gt("That theme file is invalid."),
        );
      }
      return;
    }

    const installed: ThemeDefinition[] = [];
    for (const theme of fresh) {
      try {
        installed.push(installCustomTheme(theme));
      } catch (cause) {
        failures.push(
          `${theme.label}: ${cause instanceof Error ? (thrownErrorMessage(cause, m) ?? cause.message) : gt("could not install")}`,
        );
      }
    }
    if (installed.length > 0) onImportedMany(installed, { updated: false });
    setError(failures.length > 0 ? failures.join("; ") : null);
    if (conflicting.length > 0) setConflicts(conflicting);
    else if (installed.length > 0 && failures.length === 0) onClose();
  };

  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setIsDropTarget(false);
    },
    onDrop: handleDrop,
  };

  const removeStaged = (fileName: string) => {
    setStaged((current) => current.filter((file) => file.fileName !== fileName));
    if (jsonSource === fileName) {
      setJson("");
      setJsonSource(null);
    }
    setError(null);
  };

  // What Add theme will do, counted: new installs, already installed (they go
  // to update-or-copy), and files that will be skipped.
  const installedCount = pending.themes.length - pending.newCount;
  const invalidCount = staged.filter((file) => !file.theme).length;
  const footerNote = [
    pending.newCount > 0
      ? gt("{count, plural, one {{count} new theme} other {{count} new themes}}", {
          count: pending.newCount,
        })
      : null,
    installedCount > 0
      ? gt("{count} already installed", {
          count: installedCount,
          $context: "theme files that are already installed",
        })
      : null,
    invalidCount > 0
      ? gt("{count} invalid", { count: invalidCount, $context: "theme files that failed to parse" })
      : null,
  ].filter((note) => note !== null);

  return (
    <>
      <DialogPanel>
        {searchSession !== null ? (
          <ThemeSearchSection
            onInstalled={(themes, context) => {
              onImportedMany(themes, context);
              onClose();
            }}
            signal={searchSession.signal}
          />
        ) : conflicts ? (
          <div className="rounded-control border border-border/70 bg-muted/20 p-3">
            <p className="text-label">
              <T>Already installed</T>
            </p>
            <p className="mt-1 text-meta text-muted-foreground">
              {conflicts.map((theme) => theme.label).join(", ")}
            </p>
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex flex-col items-center gap-2 rounded-control border px-4 py-5.5 text-center transition-colors",
                isDropTarget ? "border-ring bg-accent/20" : "border-border bg-muted/20",
              )}
              {...dropHandlers}
            >
              <FileUpIcon className="size-5 text-muted-foreground" />
              <p className="text-label">{gt("Drop T3 Code or VS Code .json files")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button disabled={isReading} size="sm" variant="secondary" onClick={openFilePicker}>
                  {isReading ? gt("Reading…") : gt("Choose files")}
                </Button>
                <Button size="sm" variant="ghost" onClick={openSearch}>
                  <SearchIcon />
                  <T>Search community themes</T>
                </Button>
              </div>
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                className="sr-only"
                onChange={handleFileChange}
                multiple
                type="file"
              />
            </div>
            {staged.length > 0 ? (
              <ul className="divide-y divide-border/50 rounded-control border border-border/60">
                {staged.map((file) => (
                  <StagedThemeRow
                    file={file}
                    key={file.fileName}
                    onRemove={() => removeStaged(file.fileName)}
                  />
                ))}
              </ul>
            ) : null}
            <div className="space-y-1.5">
              <label className="text-meta text-muted-foreground" htmlFor="theme-json-editor">
                <T>Theme JSON</T>
              </label>
              <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
            </div>
          </>
        )}

        {error ? (
          <Alert aria-live="polite" variant="error">
            {error}
          </Alert>
        ) : null}
      </DialogPanel>
      <DialogFooter className="items-center">
        {searchSession !== null ? (
          <Button variant="ghost" onClick={closeSearch}>
            <T>Back</T>
          </Button>
        ) : conflicts ? (
          <>
            <Button variant="ghost" onClick={() => setConflicts(null)}>
              <T>Back</T>
            </Button>
            <Button variant="secondary" onClick={() => resolveConflicts("copy")}>
              <T>Keep both</T>
            </Button>
            <Button onClick={() => resolveConflicts("update")}>
              <T>Update existing</T>
            </Button>
          </>
        ) : (
          <>
            {footerNote.length > 0 ? (
              <span className="grid gap-1 text-meta text-muted-foreground sm:mr-auto">
                {footerNote.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </span>
            ) : null}
            <Button variant="ghost" onClick={() => onClose()}>
              <T>Cancel</T>
            </Button>
            <Button
              disabled={isReading || (pending.themes.length === 0 && !pending.jsonError)}
              onClick={handleSubmit}
            >
              <PlusIcon />
              <T>Add theme</T>
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
