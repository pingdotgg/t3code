import {
  isModifierPairShortcut,
  type DesktopCaptureConfigApplied,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { shortcutToKeybindingInput } from "./KeybindingsSettings.logic";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const DEFAULT_SHORTCUT = parseKeybindingShortcut("Ctrl+Shift+2")!;

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
  const { t } = useTranslation("settings");
  const resolvedTheme = useRenderedAppearance();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [preview, setPreview] = useState<DesktopCaptureConfigPreview | null>(null);
  const [result, setResult] = useState<DesktopCaptureConfigApplied | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [working, setWorking] = useState<"reading" | "writing" | null>(null);
  const [keys, setKeys] = useState<string | null>(null);
  const [customFile, setCustomFile] = useState(false);
  const busy = disabled || working !== null;
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
  const diff =
    preview && changed
      ? parseDiffFromFile(
          { name: preview.path, contents: preview.before },
          { name: preview.path, contents: preview.after },
        )
      : null;
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
    if (actionBusy || !bridge) return;
    begin("reading");
    setPreview(null);
    setResult(null);
    setCustomFile(chooseFile);
    const previewed = await settlePromise(() =>
      bridge.previewSnapShotConfig({
        operation,
        chooseFile,
        ...(keys?.trim() ? { shortcut: keys.trim() } : {}),
      }),
    );
    if (previewed._tag === "Success") {
      setPreview(previewed.value);
    } else {
      const cause = Cause.squash(previewed.cause);
      setError({
        message: t("captureShortcut.prepareFailed"),
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
    }
    end();
  };
  const apply = async () => {
    if (actionBusy || !preview || !bridge) return;
    begin("writing");
    const saved = await settlePromise(async () => {
      const applied = await bridge.applySnapShotConfig(preview.id);
      setResult(applied);
      await onSaved?.();
      if (!applied.warning && preview.operation === "install" && onComplete) {
        toastManager.add({
          type: "success",
          title: t("captureShortcut.savedTitle"),
          description: t("captureShortcut.savedDescription", { shortcut: preview.shortcut }),
        });
        await onComplete();
      }
    });
    if (saved._tag === "Failure") {
      const cause = Cause.squash(saved.cause);
      setError({
        message: t("captureShortcut.saveFailed"),
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
      setPreview(null);
    }
    end();
  };

  return (
    <div className="space-y-4 text-sm">
      {!result ? (
        <div className="flex items-center justify-between gap-3">
          <span>{t("captureShortcut.shortcut")}</span>
          {recorder.input}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("captureShortcut.recordingHint")}
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning
            ? t("captureShortcut.savedWithWarning")
            : preview?.operation === "remove"
              ? t("captureShortcut.removed")
              : t("captureShortcut.useShortcut", { shortcut: preview?.shortcut })}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed
              ? preview.operation === "remove"
                ? t("captureShortcut.reviewRemove")
                : t("captureShortcut.reviewSave")
              : preview.operation === "remove"
                ? t("captureShortcut.nothingToRemove")
                : t("captureShortcut.alreadySetUp")}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label={t("captureShortcut.changesAria")}
            >
              <FileDiff
                fileDiff={diff}
                options={{
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                  overflow: "wrap",
                  preferredHighlighter: PREFERRED_HIGHLIGHTER,
                }}
              />
            </div>
          ) : null}
          {changed ? (
            <p className="text-xs text-muted-foreground">{t("captureShortcut.onlyTheseChanges")}</p>
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
                  ? t("captureShortcut.saving")
                  : changed
                    ? preview.operation === "install"
                      ? t("captureShortcut.saveShortcut")
                      : t("captureShortcut.removeShortcut")
                    : t("common.done")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">{t("captureShortcut.allowReadHint")}</p>
          <Button
            disabled={actionBusy || !bridge}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading"
              ? t("captureShortcut.preparing")
              : t("captureShortcut.reviewChanges")}
          </Button>
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
            ? t("captureShortcut.connecting")
            : t("captureShortcut.restartToFinish")}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("advanced.label")}</summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">{t("captureShortcut.troubleshooting")}</p>
              <p className="break-words">{error?.detail ?? result?.warning}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">{t("captureShortcut.settingsFile")}</p>
            <p className="break-all font-mono">
              {preview?.path ??
                state.shortcutConfigPath ??
                (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf")}
            </p>
            {niri ? <p>{t("captureShortcut.includesHint")}</p> : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">
                {t("captureShortcut.linkedTo", { path: preview.resolvedPath })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy || !bridge}
              onClick={() => void read(true)}
            >
              {t("captureShortcut.chooseDifferentFile")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !bridge}
              onClick={() => void read(customFile, "remove")}
            >
              {t("captureShortcut.removeShortcutEllipsis")}
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !bridge}
                onClick={() => void read()}
              >
                {t("captureShortcut.reviewChanges")}
              </Button>
            ) : null}
          </div>
          <p>
            {t("captureShortcut.useSettingsFile")}{" "}
            {niri ? t("captureShortcut.niriConfigHint") : t("captureShortcut.omarchyHint")}
          </p>
          {result?.backupPath ? (
            <p className="break-all">{t("captureShortcut.backup", { path: result.backupPath })}</p>
          ) : null}
          <p className="font-medium text-foreground">{t("captureShortcut.manualSetup")}</p>
          <p>
            {niri ? t("captureShortcut.niriManualHint") : t("captureShortcut.hyprlandManualHint")}{" "}
            {t("captureShortcut.changeKeysHint")}
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
            {isCopied ? t("captureShortcut.copied") : t("captureShortcut.copyShortcut")}
          </Button>
          <p>{t("captureShortcut.turnOffHint", { desktop })}</p>
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
              {t("captureShortcut.addedConfirm")}
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
