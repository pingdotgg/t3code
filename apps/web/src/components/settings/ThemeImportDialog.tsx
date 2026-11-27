import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { DownloadIcon, PlusIcon } from "lucide-react";
import type { ChangeEvent, DragEvent, UIEvent } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
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
  numberedThemeName,
  pairVsCodeThemes,
  parseThemeImport,
  resolveThemeLabelCollisions,
} from "../../vscodeThemeImport";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
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
  const highlightedJson = isPlainText ? "" : highlightJson(value);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-3 focus-within:ring-inset focus-within:ring-ring/24">
      {isPlainText ? null : (
        <pre
          ref={highlightRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground"
        >
          <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </pre>
      )}
      <textarea
        aria-label={gt("Theme JSON")}
        className={cn(
          "relative z-10 block min-h-44 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-xs leading-5 caret-foreground outline-none placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
          isPlainText ? "text-foreground" : "text-transparent",
        )}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          // oxlint-disable-next-line t3code/no-untranslated-copy -- example theme JSON
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

type ImportableThemeFile = { name: string; size: number; text: () => Promise<string> };

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
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            <T>Add a theme</T>
          </DialogTitle>
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
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ThemeDefinition> | null>(null);
  // A new file selection supersedes a pending import even if the selection is rejected.
  const importRequestRef = useRef(0);
  const isCurrentRequest = (requestId: number) =>
    requestId === importRequestRef.current && !signal.aborted;

  const readThemeFile = async (file: ImportableThemeFile) => {
    const requestId = ++importRequestRef.current;
    const oversized = describeOversizedThemeFile(file.size);
    if (oversized) {
      setIsReading(false);
      setError(oversized);
      return;
    }

    setIsReading(true);
    const fileText = await settlePromise(() => file.text());
    if (!isCurrentRequest(requestId)) return;
    setIsReading(false);
    if (fileText._tag === "Failure") {
      setError(gt("Could not read that file. Paste the JSON below instead."));
      return;
    }
    setJson(fileText.value);
    setFileName(file.name);
    setError(null);
  };

  const readThemeBatch = (files: ReadonlyArray<ImportableThemeFile>) => {
    const requestId = ++importRequestRef.current;
    setIsReading(true);
    return installThemeBatch(files, requestId).finally(() => {
      if (isCurrentRequest(requestId)) setIsReading(false);
    });
  };

  const installThemeBatch = async (
    files: ReadonlyArray<ImportableThemeFile>,
    requestId: number,
  ) => {
    const failures: string[] = [];
    const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
    for (const file of files) {
      const oversized = describeOversizedThemeFile(file.size);
      if (oversized) {
        failures.push(`${file.name}: ${oversized}`);
        continue;
      }
      try {
        parsed.push({
          sourceName: file.name,
          theme: parseThemeImport(await file.text()),
        });
      } catch (cause) {
        failures.push(
          `${file.name}: ${cause instanceof Error ? (thrownErrorMessage(cause, m) ?? cause.message) : gt("not a theme file")}`,
        );
      }
    }
    if (!isCurrentRequest(requestId)) return;
    const installed: ThemeDefinition[] = [];
    const conflicting: ThemeDefinition[] = [];
    for (const theme of pairVsCodeThemes(resolveThemeLabelCollisions(parsed))) {
      if (isThemeIdTaken(theme.id)) {
        conflicting.push(theme);
        continue;
      }
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
    if (conflicting.length > 0) {
      setConflicts(conflicting);
    } else if (installed.length > 0 && failures.length === 0) {
      onClose();
    }
  };

  const readThemeFiles = (files: ReadonlyArray<ImportableThemeFile>) => {
    if (files.length === 0) return;
    if (files.length === 1) void readThemeFile(files[0]!);
    else void readThemeBatch(files);
  };

  const openFilePicker = () => {
    const bridge = window.desktopBridge;
    if (bridge) {
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
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    readThemeFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    readThemeFiles([...event.dataTransfer.files]);
  };

  const versionedCopy = (
    theme: ThemeDefinition,
    preferredName?: string | null,
  ): ThemeDefinition => {
    // renameTheme leaves the collection behind: updating a collection replaces every theme in it.
    if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
      const candidate = renameTheme(theme, preferredName.slice(0, 48));
      if (!isThemeIdTaken(candidate.id)) return candidate;
    }
    for (let copy = 1; copy < 100; copy += 1) {
      const candidate = renameTheme(theme, numberedThemeName(theme.label, ` (${copy})`));
      if (!isThemeIdTaken(candidate.id)) return candidate;
    }
    throw new Error(m(msg('Too many copies of "{label}".', { label: theme.label })));
  };

  const resolveConflicts = (mode: "update" | "copy") => {
    if (!conflicts) return;
    const resolved: ThemeDefinition[] = [];
    const failures: string[] = [];
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
    const oversized = describeOversizedThemeFile(json.length);
    if (oversized) {
      setError(oversized);
      return;
    }
    try {
      const theme = parseThemeImport(json);
      if (isThemeIdTaken(theme.id)) {
        setError(null);
        setConflicts([theme]);
        return;
      }
      const installedTheme = installCustomTheme(theme);
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
  };

  return (
    <DialogPanel>
      <ThemeSearchSection
        onInstalled={(themes, context) => {
          onImportedMany(themes, context);
          onClose();
        }}
        signal={signal}
      />

      <div className="flex items-center gap-3" aria-hidden>
        <div className="h-px flex-1 bg-border" />
        <span className="text-muted-foreground text-2xs uppercase tracking-wider">
          <T>or import a file</T>
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

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
        const chooseButton = (label = gt("Choose files")) => (
          <Button disabled={isReading} size="sm" variant="outline" onClick={openFilePicker}>
            <DownloadIcon />
            {isReading ? gt("Reading…") : label}
          </Button>
        );
        const editorSection = () => (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="theme-json-editor">
                <T>Theme JSON</T>
              </label>
            </div>
            <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
          </div>
        );
        if (conflicts) {
          return (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  <T>Already installed</T>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {conflicts.map((theme) => theme.label).join(", ")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => resolveConflicts("update")}>
                  <T>Update existing</T>
                </Button>
                <Button size="sm" variant="outline" onClick={() => resolveConflicts("copy")}>
                  <T>Keep both</T>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConflicts(null)}>
                  <T>Back</T>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onClose()}>
                  <T>Cancel</T>
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
                <p className="text-sm font-medium">
                  <T>Theme file</T>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {fileName ?? gt("Drop T3 Code or VS Code .json files")}
                </p>
              </div>
              {chooseButton()}
              {fileInput}
            </div>
            {editorSection()}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => onClose()}>
                <T>Cancel</T>
              </Button>
              <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
                <PlusIcon />
                <T>Add theme</T>
              </Button>
            </div>
          </div>
        );
      })()}

      {error ? (
        <Alert aria-live="polite" variant="error">
          {error}
        </Alert>
      ) : null}
    </DialogPanel>
  );
}
