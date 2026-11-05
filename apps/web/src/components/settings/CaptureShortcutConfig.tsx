import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
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
        message: "Couldn't prepare the changes. Check Advanced for help.",
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
          title: t({ message: "Shortcut saved" }),
          description: t`Use ${preview.shortcut} from another app.`,
        });
        await onComplete();
      }
    });
    if (saved._tag === "Failure") {
      const cause = Cause.squash(saved.cause);
      setError({
        message: "Couldn't save your shortcut. Review the changes and try again.",
        ...(cause instanceof Error ? { detail: cause.message } : {}),
      });
      setPreview(null);
    }
    end();
  };

  const messageText =
    result && !result.warning && !(preview?.operation === "remove") ? preview?.shortcut : undefined;
  return (
    <div className="space-y-4 text-sm">
      {!result ? (
        <div className="flex items-center justify-between gap-3">
          <span>
            <Trans>Shortcut</Trans>
          </span>
          {recorder.input}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          <Trans>Press your shortcut. Esc cancels.</Trans>
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning ? (
            <Trans>Saved, but the shortcut needs attention. Check Advanced for help.</Trans>
          ) : preview?.operation === "remove" ? (
            <Trans>Shortcut removed.</Trans>
          ) : (
            <Trans>Use {messageText} from another app to capture a window.</Trans>
          )}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed ? (
              preview.operation === "remove" ? (
                <Trans>Review the change below to remove your shortcut.</Trans>
              ) : (
                <Trans>Review the change below, then save your shortcut.</Trans>
              )
            ) : preview.operation === "remove" ? (
              <Trans>There's no capture shortcut to remove.</Trans>
            ) : (
              <Trans>This shortcut is already set up.</Trans>
            )}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label={t({ message: "Shortcut changes" })}
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
            <p className="text-xs text-muted-foreground">
              <Trans>Only these changes will be saved. We'll keep a backup.</Trans>
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
                {working === "writing" ? (
                  <Trans>Saving…</Trans>
                ) : changed ? (
                  preview.operation === "install" ? (
                    <Trans>Save shortcut</Trans>
                  ) : (
                    <Trans>Remove shortcut</Trans>
                  )
                ) : (
                  <Trans>Done</Trans>
                )}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            <Trans>
              Allow T3 Code to read your desktop settings. You'll review any changes here before
              saving.
            </Trans>
          </p>
          <Button
            disabled={actionBusy || !bridge}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading" ? (
              <Trans>Preparing changes…</Trans>
            ) : (
              <Trans>Review changes</Trans>
            )}
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
          {state.shortcutPending ? (
            <Trans>Connecting to your desktop…</Trans>
          ) : (
            <Trans>Restart T3 Code to finish connecting your shortcut.</Trans>
          )}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          <Trans>Advanced</Trans>
        </summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                <Trans>Troubleshooting</Trans>
              </p>
              <p className="break-words">{error?.detail ?? result?.warning}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              <Trans>Settings file</Trans>
            </p>
            <p className="break-all font-mono">
              {preview?.path ??
                state.shortcutConfigPath ??
                (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf")}
            </p>
            {niri ? (
              <p>
                <Trans>T3 Code also reads any files included by this file.</Trans>
              </p>
            ) : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">
                <Trans>Linked to {preview.resolvedPath}. The link will be kept.</Trans>
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
              <Trans>Choose a different file…</Trans>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !bridge}
              onClick={() => void read(customFile, "remove")}
            >
              <Trans>Remove shortcut…</Trans>
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !bridge}
                onClick={() => void read()}
              >
                <Trans>Review changes</Trans>
              </Button>
            ) : null}
          </div>
          <p>
            {niri ? (
              <Trans>
                Use your desktop's shortcut settings file. A custom --config or NIRI_CONFIG can
                change its location.
              </Trans>
            ) : (
              <Trans>
                Use your desktop's shortcut settings file. On Omarchy, use your own bindings file,
                not its defaults.
              </Trans>
            )}
          </p>
          {result?.backupPath ? (
            <p className="break-all">
              <Trans>Backup: {result.backupPath}</Trans>
            </p>
          ) : null}
          <p className="font-medium text-foreground">
            <Trans>Manual setup</Trans>
          </p>
          <p>
            {niri ? (
              <Trans>
                Paste this inside <code>{"binds { … }"}</code> in your Niri config, then save.
                Change the keys if needed.
              </Trans>
            ) : (
              <Trans>
                Add this binding to your Hyprland config, then save. Change the keys if needed.
              </Trans>
            )}
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
            {isCopied ? <Trans>Copied</Trans> : <Trans>Copy shortcut</Trans>}
          </Button>
          <p>
            <Trans>
              Turn capture off in T3 Code to stop it. Remove the shortcut from {desktop} to free up
              the keys.
            </Trans>
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
              <Trans>I've added the shortcut</Trans>
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
