import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { DownloadIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import {
  diffDeviceSettings,
  mergeDeviceSettings,
  parseDeviceSettingsFile,
  pickDeviceSettings,
  serializeDeviceSettingsFile,
  type DeviceAppearance,
  type DeviceSettingChange,
  type DeviceSettingsFileImport,
} from "../../deviceSettingsFile";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsUpdate,
} from "../../hooks/useSettings";
import {
  readAppearanceModePreference,
  readThemeHalvesRaw,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { isKnownThemePreference } from "../../themePalette";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { toastManager } from "../ui/toast";
import { downloadJsonFile } from "./ThemeSettings";

const DEVICE_SETTINGS_FILE_NAME = "t3code-device-settings.json";

/** Embedded custom themes make the file larger than one theme file, but never by megabytes. */
const MAX_DEVICE_SETTINGS_FILE_BYTES = 1024 * 1024;

interface ImportPreview {
  readonly fileName: string;
  readonly imported: DeviceSettingsFileImport;
  readonly changes: ReadonlyArray<DeviceSettingChange>;
}

function formatSettingValue(value: unknown): string {
  return value === undefined ? "default" : JSON.stringify(value);
}

/**
 * Reads the stored values, not the resolved ones: a half that names a theme an environment has not
 * sent yet still counts, so neither export nor import drops it.
 */
function readDeviceAppearance(advancedTypography: boolean): DeviceAppearance {
  let theme = "system";
  try {
    theme = readThemePreference();
  } catch {}
  const halves = readThemeHalvesRaw();
  return {
    theme,
    appearanceMode: readAppearanceModePreference(theme),
    themeHalves: { light: halves.light ?? null, dark: halves.dark ?? null },
    advancedTypography,
  };
}

function useAdvancedTypography() {
  return useLocalStorage(TYPOGRAPHY_ADVANCED_STORAGE_KEY, false, Schema.Boolean);
}

function notifySettingsUnavailable() {
  toastManager.add({
    type: "error",
    title: "Couldn’t read device settings",
    description: "Try again.",
  });
}

export function ExportDeviceSettingsButton() {
  const [advancedTypography] = useAdvancedTypography();

  const exportSettings = async () => {
    const hydrated = await settlePromise(ensureClientSettingsHydrated);
    if (hydrated._tag === "Failure") {
      notifySettingsUnavailable();
      return;
    }
    downloadJsonFile(
      DEVICE_SETTINGS_FILE_NAME,
      serializeDeviceSettingsFile({
        settings: getClientSettings(),
        appearance: readDeviceAppearance(advancedTypography),
      }),
    );
  };

  return (
    <Button size="xs" variant="ghost" onClick={() => void exportSettings()}>
      <DownloadIcon className="mx-1 size-3.5" />
      Export
    </Button>
  );
}

export function ImportDeviceSettingsButton({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <UploadIcon className="mx-1 size-3.5" />
        Import
      </Button>
      <DeviceSettingsImportDialog open={open} onOpenChange={setOpen} onImported={onImported} />
    </>
  );
}

export function DeviceSettingsImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const readRequestRef = useRef(0);
  const theme = useTheme();
  const [advancedTypography, setAdvancedTypography] = useAdvancedTypography();

  const [renderedOpen, setRenderedOpen] = useState(open);
  if (renderedOpen !== open) {
    setRenderedOpen(open);
    setIsDropTarget(false);
    if (open) {
      setPreview(null);
      setError(null);
      setIsReading(false);
    }
  }
  // Opening or closing drops any read still in flight.
  useEffect(() => {
    if (!open) return;
    readRequestRef.current += 1;
    return () => {
      readRequestRef.current += 1;
    };
  }, [open]);

  const readFile = async (file: File) => {
    // Every new file drops a read still in flight, including one this file replaces with an error.
    const requestId = ++readRequestRef.current;
    if (file.size > MAX_DEVICE_SETTINGS_FILE_BYTES) {
      setIsReading(false);
      setError("That file is larger than 1 MB, so it is not a device settings file.");
      return;
    }
    setIsReading(true);
    const [text, hydrated] = await Promise.all([
      settlePromise(() => file.text()),
      settlePromise(ensureClientSettingsHydrated),
    ]);
    if (requestId !== readRequestRef.current) return;
    setIsReading(false);
    if (text._tag === "Failure") {
      setError("Could not read that file.");
      return;
    }
    if (hydrated._tag === "Failure") {
      setError("Could not read the current device settings. Try again.");
      return;
    }
    try {
      const imported = parseDeviceSettingsFile(JSON.parse(text.value), isKnownThemePreference);
      const current = {
        settings: pickDeviceSettings(getClientSettings()),
        appearance: readDeviceAppearance(advancedTypography),
      };
      setPreview({
        fileName: file.name,
        imported,
        changes: diffDeviceSettings(current, mergeDeviceSettings(current, imported)),
      });
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "That file is not valid JSON."
          : cause instanceof Error
            ? cause.message
            : "That file is not a device settings file.",
      );
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void readFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropTarget(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };

  // setTheme clears the light and dark pair, so after a theme change both halves are rewritten.
  const writeAppearance = (from: DeviceAppearance, to: DeviceAppearance): boolean => {
    const themeChanged = from.theme !== to.theme;
    if (themeChanged && !theme.setTheme(to.theme)) return false;
    if (from.appearanceMode !== to.appearanceMode && !theme.setAppearanceMode(to.appearanceMode)) {
      return false;
    }
    for (const half of ["light", "dark"] as const) {
      const before = themeChanged ? null : from.themeHalves[half];
      if (before !== to.themeHalves[half] && !theme.setThemeHalf(half, to.themeHalves[half])) {
        return false;
      }
    }
    if (from.advancedTypography !== to.advancedTypography) {
      setAdvancedTypography(to.advancedTypography);
    }
    return true;
  };

  const applyImport = async (accepted: ImportPreview) => {
    // Merged again onto the current values, so anything the file leaves out that changed while
    // the preview was open keeps its new value.
    const previous = readDeviceAppearance(advancedTypography);
    const next = mergeDeviceSettings(
      { settings: pickDeviceSettings(getClientSettings()), appearance: previous },
      accepted.imported,
    ).appearance;
    const fail = () => {
      writeAppearance(next, previous);
      setError("The settings could not be saved. Nothing was changed. Try again.");
    };
    if (!writeAppearance(previous, next)) {
      fail();
      return;
    }
    const saved = await settlePromise(() =>
      persistClientSettingsUpdate((current) => ({ ...current, ...accepted.imported.settings })),
    );
    if (saved._tag === "Failure") {
      fail();
      return;
    }
    onImported();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import device settings</DialogTitle>
          <DialogDescription>
            Settings the file leaves out, or that fail their check, keep their current value.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {preview === null ? (
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
                isDropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
              )}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropTarget(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
              }}
              onDrop={handleDrop}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">Settings file</p>
                <p className="truncate text-xs text-muted-foreground">
                  Drop a {DEVICE_SETTINGS_FILE_NAME} file
                </p>
              </div>
              <Button
                disabled={isReading}
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon />
                {isReading ? "Reading…" : "Choose file"}
              </Button>
              <input
                ref={fileInputRef}
                accept=".json,application/json"
                aria-label="Device settings file"
                className="sr-only"
                onChange={handleFileChange}
                type="file"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="truncate text-xs text-muted-foreground">{preview.fileName}</p>
              {preview.changes.length === 0 ? (
                <p className="text-sm">This file matches the current device settings.</p>
              ) : (
                <ul
                  aria-label="Changes"
                  className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs"
                >
                  {preview.changes.map((change) => (
                    <li key={change.key}>
                      {change.key}: {formatSettingValue(change.from)} →{" "}
                      {formatSettingValue(change.to)}
                    </li>
                  ))}
                </ul>
              )}
              {preview.imported.warnings.length > 0 ? (
                <Alert variant="warning" controlAlignment="first-line">
                  <TriangleAlertIcon />
                  <AlertTitle>Warnings</AlertTitle>
                  <AlertDescription>
                    <ul aria-label="Warnings" className="space-y-1 text-xs">
                      {preview.imported.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {preview === null ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void applyImport(preview)}>Apply settings</Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
