import { translate } from "@t3tools/i18n";
import {
  isModifierPairShortcut,
  type DesktopCaptureConfigApplied,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import { useMemo, useState } from "react";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { shortcutToKeybindingInput } from "./KeybindingsSettings.logic";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const DEFAULT_SHORTCUT = parseKeybindingShortcut("Ctrl+Shift+2")!;

/** Wizard-owned config review; config contents never leave the desktop bridge. */
export function CaptureShortcutConfig({
  state,
  disabled = false,
  onBusyChange,
  onSaved,
  onComplete,
}: {
  state: DesktopSnapShotState;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved?: () => Promise<unknown>;
  onComplete?: () => Promise<void>;
}) {
  const bridge = getDesktopSnapShotBridge();
  const { resolvedTheme } = useTheme();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [preview, setPreview] = useState<DesktopCaptureConfigPreview | null>(null);
  const [result, setResult] = useState<DesktopCaptureConfigApplied | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [working, setWorking] = useState<"reading" | "writing" | null>(null);
  const [keys, setKeys] = useState<string | null>(null);
  const [customFile, setCustomFile] = useState(false);
  const busy = disabled || working !== null;
  const supported = Boolean(bridge?.previewSnapShotConfig && bridge.applySnapShotConfig);
  const changed = preview !== null && preview.before !== preview.after;
  const niri = state.linuxBackend === "niri";
  const desktop = niri ? "Niri" : "Hyprland";
  const shortcutKeys = (keys ?? preview?.shortcut)?.trim();
  const recorder = useSnapShotShortcutRecorder({
    shortcut: shortcutKeys
      ? (parseKeybindingShortcut(shortcutKeys.replace(/super/gi, "meta")) ?? DEFAULT_SHORTCUT)
      : DEFAULT_SHORTCUT,
    disabled: busy,
    allowModifierPairs: false,
    onStart: () => setError(null),
    onError: (message) => setError({ message }),
    onRecord: (shortcut) => {
      if (isModifierPairShortcut(shortcut)) return;
      setKeys(
        shortcutToKeybindingInput({
          ...shortcut,
          ctrlKey: shortcut.ctrlKey || shortcut.modKey,
          modKey: false,
        }),
      );
      setPreview(null);
      setError(null);
    },
  });
  const actionBusy = busy || recorder.recording;
  const diff = useMemo(
    () =>
      preview && changed
        ? parseDiffFromFile(
            { name: preview.path, contents: preview.before },
            { name: preview.path, contents: preview.after },
          )
        : null,
    [preview, changed],
  );
  const begin = (phase: "reading" | "writing") => {
    setWorking(phase);
    onBusyChange?.(true);
    setError(null);
  };
  const end = () => {
    setWorking(null);
    onBusyChange?.(false);
  };
  const read = async (chooseFile = customFile, operation: "install" | "remove" = "install") => {
    if (actionBusy || !bridge?.previewSnapShotConfig) return;
    begin("reading");
    setPreview(null);
    setResult(null);
    setCustomFile(chooseFile);
    try {
      setPreview(
        await bridge.previewSnapShotConfig({
          operation,
          chooseFile,
          ...(keys?.trim() ? { shortcut: keys.trim() } : {}),
        }),
      );
    } catch (cause) {
      setError({
        message: "Couldn't prepare the changes. Check Advanced for help.",
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
    } finally {
      end();
    }
  };
  const apply = async () => {
    if (actionBusy || !preview || !bridge?.applySnapShotConfig) return;
    begin("writing");
    try {
      const applied = await bridge.applySnapShotConfig(preview.id);
      setResult(applied);
      await onSaved?.();
      if (!applied.warning && preview.operation === "install" && onComplete) {
        toastManager.add({
          type: "success",
          title: translate("common:uiShortcutSaved", "Shortcut saved"),
          description: translate(
            "common:uiCaptureShortcutFromAnotherAppToast",
            "Use {{shortcut}} from another app.",
            { shortcut: preview.shortcut },
          ),
        });
        await onComplete();
      }
    } catch (cause) {
      setError({
        message: translate(
          "common:uiShortcutSaveFailed",
          "Couldn't save your shortcut. Review the changes and try again.",
        ),
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
      setPreview(null);
    } finally {
      end();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {!result ? (
        <div className="flex items-center justify-between gap-3">
          <span>{translate("settings:shortcut", "Shortcut")}</span>
          {recorder.input}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate("common:uiCaptureShortcutPrompt", "Press your shortcut. Esc cancels.")}
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning
            ? translate(
                "common:uiCaptureShortcutSavedWarning",
                "Saved, but the shortcut needs attention. Check Advanced for help.",
              )
            : preview?.operation === "remove"
              ? translate("common:uiCaptureShortcutRemoved", "Shortcut removed.")
              : translate(
                  "common:uiCaptureShortcutFromAnotherApp",
                  "Use {{shortcut}} from another app to capture a window.",
                  { shortcut: preview?.shortcut ?? "" },
                )}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed
              ? preview.operation === "remove"
                ? translate(
                    "common:uiReviewShortcutRemoval",
                    "Review the change below to remove your shortcut.",
                  )
                : translate(
                    "common:uiReviewShortcutSave",
                    "Review the change below, then save your shortcut.",
                  )
              : preview.operation === "remove"
                ? translate(
                    "common:uiNoCaptureShortcutToRemove",
                    "There's no capture shortcut to remove.",
                  )
                : translate(
                    "common:uiCaptureShortcutAlreadySetUp",
                    "This shortcut is already set up.",
                  )}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label={translate("common:uiShortcutChanges", "Shortcut changes")}
            >
              <FileDiff
                fileDiff={diff}
                options={{
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                  overflow: "wrap",
                }}
              />
            </div>
          ) : null}
          {changed ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                "common:uiOnlyShortcutChangesSaved",
                "Only these changes will be saved. We'll keep a backup.",
              )}
            </p>
          ) : null}
          <div className="flex gap-2">
            {changed || preview.operation === "install" ? (
              <Button
                disabled={
                  actionBusy ||
                  (preview.operation === "install" && state.shortcutActionRegistered === false)
                }
                aria-busy={working === "writing"}
                onClick={() => void apply()}
              >
                {working === "writing"
                  ? translate("common:uiSaving", "Saving…")
                  : changed
                    ? preview.operation === "install"
                      ? translate("common:uiSaveShortcut", "Save shortcut")
                      : translate("common:uiRemoveShortcut", "Remove shortcut")
                    : translate("common:uiDone", "Done")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              {translate("chatView:cancel", "Cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {translate(
              "common:uiAllowReadDesktopShortcutSettings",
              "Allow T3 Code to read your desktop settings. You'll review any changes here before saving.",
            )}
          </p>
          <Button
            disabled={actionBusy || !supported}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading"
              ? translate("common:uiPreparingChanges", "Preparing changes…")
              : translate("common:uiReviewChanges", "Review changes")}
          </Button>
          {!supported ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                "common:uiUpdateAppToFinishShortcut",
                "Update T3 Code to finish setting up your shortcut.",
              )}
            </p>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      ) : null}
      {state.shortcutActionRegistered === false && state.shortcutMessage ? (
        <p role="status" className="text-muted-foreground">
          {state.shortcutPending
            ? translate("common:uiConnectingToDesktop", "Connecting to your desktop…")
            : translate(
                "common:uiRestartT3ForShortcut",
                "Restart T3 Code to finish connecting your shortcut.",
              )}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {translate("settings:advancedSection", "Advanced")}
        </summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {translate("settings:troubleshooting", "Troubleshooting")}
              </p>
              <p className="break-words">{error?.detail ?? result?.warning}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {translate("settings:settingsFile", "Settings file")}
            </p>
            <p className="break-all font-mono">
              {preview?.path ??
                state.shortcutConfigPath ??
                (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf")}
            </p>
            {niri ? (
              <p>
                {translate(
                  "settings:includedFilesNote",
                  "T3 Code also reads any files included by this file.",
                )}
              </p>
            ) : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">
                {translate(
                  "common:uiShortcutLinkedPath",
                  "Linked to {{path}}. The link will be kept.",
                  { path: preview.resolvedPath },
                )}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || !supported}
              onClick={() => void read(true)}
            >
              {translate("common:uiChooseDifferentFile", "Choose a different file…")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !supported}
              onClick={() => void read(customFile, "remove")}
            >
              {translate("common:uiOpenShortcutRemoval", "Remove shortcut…")}
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !supported}
                onClick={() => void read()}
              >
                {translate("settings:reviewChanges", "Review changes")}
              </Button>
            ) : null}
          </div>
          <p>
            {translate(
              "common:uiUseDesktopShortcutSettings",
              "Use your desktop's shortcut settings file.",
            )}{" "}
            {niri
              ? translate(
                  "common:uiNiriOrOmarchyShortcutHelpNiri",
                  "A custom --config or NIRI_CONFIG can change its location.",
                )
              : translate(
                  "common:uiNiriOrOmarchyShortcutHelpOmarchy",
                  "On Omarchy, use your own bindings file, not its defaults.",
                )}
          </p>
          {result?.backupPath ? (
            <p className="break-all">
              {translate("common:uiBackupPath", "Backup: {{path}}", { path: result.backupPath })}
            </p>
          ) : null}
          <p className="font-medium text-foreground">
            {translate("settings:manualSetup", "Manual setup")}
          </p>
          <p>
            {niri
              ? translate(
                  "common:uiNiriShortcutInstructions",
                  "Paste this inside binds { … } in your Niri config, then save.",
                )
              : translate(
                  "common:uiHyprlandShortcutInstructions",
                  "Add this binding to your Hyprland config, then save.",
                )}{" "}
            {translate("settings:changeKeysIfNeeded", "Change the keys if needed.")}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3">
            {state.shortcutBinding}
          </pre>
          <Button
            size="sm"
            variant="outline"
            disabled={actionBusy || !state.shortcutBinding}
            onClick={() => {
              if (state.shortcutBinding) copyToClipboard(state.shortcutBinding);
            }}
          >
            {isCopied
              ? translate("common:mobileCopied", "Copied")
              : translate("common:uiCopyShortcut", "Copy shortcut")}
          </Button>
          <p>
            {translate(
              "settings:turnCaptureOffHint",
              "Turn capture off in T3 Code to stop it. Remove the shortcut from {{desktop}} to free up the keys.",
              { desktop },
            )}
          </p>
          {state.shortcutActionRegistered === false ? (
            <p role="status">{state.shortcutMessage}</p>
          ) : null}
          {onComplete ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || state.shortcutActionRegistered === false}
              onClick={() => void onComplete()}
            >
              {translate("common:uiShortcutAddedConfirmation", "I've added the shortcut")}
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
