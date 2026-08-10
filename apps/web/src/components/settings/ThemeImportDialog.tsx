import { DownloadIcon, PlusIcon } from "lucide-react";
import type { ChangeEvent, DragEvent, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  getCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  THEME_FILE_VERSION,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../themePalette";
import {
  humanizeThemeName,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "../../vscodeThemeImport";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/**
 * A full theme export is a few KB, so anything past this is not a theme file.
 * The guard runs on the size before the bytes are ever read: a large file
 * would otherwise be pulled into memory, highlighted, and rendered, which
 * locks the UI for as long as that takes.
 */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

/** Highlighting rebuilds the whole markup on every keystroke, so oversized
 *  pastes fall back to plain text instead of freezing the editor. */
const MAX_HIGHLIGHTED_JSON_LENGTH = 20_000;

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Returns the error to show for a file too large to be a theme, else null. */
export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null;
  return `That file is ${formatByteSize(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatByteSize(MAX_THEME_FILE_BYTES)}).`;
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

    let tokenClass = "theme-json-number";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "theme-json-key"
        : "theme-json-string";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "theme-json-constant";
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
  const highlightRef = useRef<HTMLPreElement>(null);
  const isPlainText = value.length > MAX_HIGHLIGHTED_JSON_LENGTH;
  const highlightedJson = useMemo(
    () => (value.length > MAX_HIGHLIGHTED_JSON_LENGTH ? "" : highlightJson(value)),
    [value],
  );

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground"
        >
          <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </pre>
      )}
      <textarea
        aria-label="Theme JSON"
        className={cn(
          "relative z-10 block min-h-72 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-[12px] leading-5 caret-foreground outline-none placeholder:text-muted-foreground selection:bg-accent/30",
          isPlainText ? "text-foreground" : "text-transparent selection:text-transparent",
        )}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

/** What the import pipeline needs from a file; DOM File satisfies it. */
type ImportableThemeFile = { name: string; size: number; text: () => Promise<string> };

export function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
  onImportedMany,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => boolean;
  /** Batch imports install without activating; the caller reports them. */
  onImportedMany: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // Imports whose id is already installed wait here for an update-or-copy
  // decision instead of failing.
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    // Reset on close too: a dialog dismissed mid-drag would otherwise reopen
    // still wearing the drop highlight.
    setIsDropTarget(false);
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
    setIsReading(false);
    setConflicts(null);
  }, [open]);

  const readThemeFile = useCallback(async (file: ImportableThemeFile) => {
    // Check the size first: reading a large file is what locks the UI, so it
    // never gets read at all.
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setError(oversized);
      return;
    }

    const requestId = ++importRequestRef.current;
    setIsReading(true);
    try {
      const fileText = await file.text();
      if (requestId !== importRequestRef.current) return;
      setJson(fileText);
      setFileName(file.name);
      setError(null);
    } catch {
      if (requestId !== importRequestRef.current) return;
      setError("Could not read that file. Paste the JSON below instead.");
    } finally {
      if (requestId === importRequestRef.current) setIsReading(false);
    }
  }, []);

  // Several files at once import as a batch: VS Code families pair their
  // light and dark variants, everything installs without activating, and the
  // single-file flow keeps filling the editor for review.
  const readThemeBatch = useCallback(
    async (files: ReadonlyArray<ImportableThemeFile>) => {
      const requestId = ++importRequestRef.current;
      setIsReading(true);
      const failures: string[] = [];
      const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
      try {
        for (const file of files) {
          const oversized = describeOversizedThemeFile(file.size);
          if (oversized) {
            failures.push(`${file.name}: too large`);
            continue;
          }
          try {
            const value: unknown = JSON.parse(await file.text());
            parsed.push({
              sourceName: file.name,
              theme: isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value),
            });
          } catch (cause) {
            failures.push(
              `${file.name}: ${cause instanceof Error ? cause.message : "not a theme file"}`,
            );
          }
        }
        if (requestId !== importRequestRef.current) return;
        const installed: ThemeDefinition[] = [];
        const conflicting: ThemeDefinition[] = [];
        for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
          if (getCustomThemes().some((existing) => existing.id === theme.id)) {
            conflicting.push(theme);
            continue;
          }
          try {
            installed.push(installCustomTheme(theme));
          } catch (cause) {
            failures.push(
              `${theme.label}: ${cause instanceof Error ? cause.message : "could not install"}`,
            );
          }
        }
        if (installed.length > 0) onImportedMany(installed, { updated: false });
        if (failures.length > 0) {
          setError(failures.join(" — "));
        } else if (conflicting.length > 0) {
          setConflicts(conflicting);
        } else if (installed.length > 0) {
          onOpenChange(false);
        }
      } finally {
        if (requestId === importRequestRef.current) setIsReading(false);
      }
    },
    [onImportedMany, onOpenChange],
  );

  const readThemeFiles = useCallback(
    (files: ReadonlyArray<ImportableThemeFile>) => {
      if (files.length === 0) return;
      if (files.length === 1) void readThemeFile(files[0]!);
      else void readThemeBatch(files);
    },
    [readThemeBatch, readThemeFile],
  );

  // On desktop the native picker opens in ~/.vscode/extensions (when it
  // exists) and reads the files in the main process; the browser input is
  // the fallback everywhere else.
  const openFilePicker = useCallback(() => {
    const bridge = window.desktopBridge;
    if (bridge?.pickThemeFiles) {
      void bridge.pickThemeFiles().then((picked) => {
        if (!picked || picked.length === 0) return;
        readThemeFiles(
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
  }, [readThemeFiles]);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = "";
      readThemeFiles(files);
    },
    [readThemeFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      readThemeFiles([...event.dataTransfer.files]);
    },
    [readThemeFiles],
  );

  /** Copy of an already-installed theme under the source file's name when
   *  that differs (Dracula Soft), else the next free "Name (1)". */
  const versionedCopy = (
    theme: ThemeDefinition,
    preferredName?: string | null,
  ): ThemeDefinition => {
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: preferredName.slice(0, 48),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (!getCustomThemes().some((existing) => existing.id === candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = parseThemeFile({
        version: THEME_FILE_VERSION,
        name: `${theme.label.slice(0, 48 - ` (${copy})`.length)} (${copy})`,
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
      if (getCustomThemes().some((existing) => existing.id === candidate.id)) continue;
      return candidate;
    }
    throw new Error(`Too many copies of "${theme.label}".`);
  };

  const resolveConflicts = useCallback(
    (mode: "update" | "copy") => {
      if (!conflicts) return;
      const resolved: ThemeDefinition[] = [];
      const failures: string[] = [];
      const preferredName =
        conflicts.length === 1 && fileName
          ? humanizeThemeName(fileName.replace(/\.[^.]+$/, ""))
          : null;
      for (const theme of conflicts) {
        try {
          resolved.push(
            mode === "update"
              ? updateCustomTheme(theme)
              : installCustomTheme(versionedCopy(theme, preferredName)),
          );
        } catch (cause) {
          failures.push(`${theme.label}: ${cause instanceof Error ? cause.message : "failed"}`);
        }
      }
      if (resolved.length > 0) onImportedMany(resolved, { updated: mode === "update" });
      setConflicts(null);
      if (failures.length > 0) setError(failures.join(" — "));
      else onOpenChange(false);
    },
    [conflicts, fileName, onImportedMany, onOpenChange],
  );

  const handleSubmit = useCallback(() => {
    // Pasted text bypasses the file guard, so the same limit applies here.
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      // VS Code themes are converted on the way in; anything else has to be
      // one of our own files.
      const theme = isVsCodeThemeFile(parsed)
        ? parseVsCodeThemeFile(parsed)
        : parseThemeFile(parsed);
      if (getCustomThemes().some((existing) => existing.id === theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      const installedTheme = installCustomTheme(theme);
      if (!onImported(installedTheme)) {
        // Roll the install back so a retry can run it again instead of
        // failing on the already-taken theme id.
        try {
          removeCustomTheme(installedTheme.id);
        } catch {
          // Storage is failing wholesale; the error below covers it.
        }
        setError("Theme added, but it could not be selected. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  }, [json, onImported, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {(() => {
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
                // Ignore moves between children of the drop zone.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              },
              onDrop: handleDrop,
            };
            const fileInput = (
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                className="sr-only"
                onChange={handleFileChange}
                multiple
                type="file"
              />
            );
            const chooseButton = (label = "Choose files") => (
              <Button disabled={isReading} size="sm" variant="outline" onClick={openFilePicker}>
                <DownloadIcon />
                {isReading ? "Reading…" : label}
              </Button>
            );
            const editorSection = () => (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <label className="text-sm font-medium" htmlFor="theme-json-editor">
                    Theme JSON
                  </label>
                </div>
                <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
              </div>
            );
            if (conflicts) {
              return (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                    <p className="text-sm font-medium">Already installed</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {conflicts.map((theme) => theme.label).join(", ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => resolveConflicts("update")}>
                      Update existing
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resolveConflicts("copy")}>
                      Keep both
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConflicts(null)}>
                      Back
                    </Button>
                  </div>
                </div>
              );
            }
            return (
              <div className="space-y-4">
                <div
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
                    isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
                  )}
                  {...dropHandlers}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Theme file</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {fileName ?? "Drop T3 Code or VS Code .json files"}
                    </p>
                  </div>
                  {chooseButton()}
                  {fileInput}
                </div>
                {editorSection()}
              </div>
            );
          })()}

          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
            <PlusIcon />
            Add theme
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
