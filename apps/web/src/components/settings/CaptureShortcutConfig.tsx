import {
  isModifierPairShortcut,
  type DesktopCaptureConfigApplied,
  type DesktopCaptureConfigPreview,
  type DesktopSnapShotState,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { FileDiff } from "@pierre/diffs/react";
import { T, useGT, Var } from "gt-react";
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
import { APP_NAME } from "@t3tools/shared/branding";

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
  const gt = useGT();
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
        message: gt("Couldn't prepare the changes. Check Advanced for help."),
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
          title: gt("Shortcut saved"),
          description: gt("Use {shortcut} from another app.", { shortcut: preview.shortcut }),
        });
        await onComplete();
      }
    });
    if (saved._tag === "Failure") {
      const cause = Cause.squash(saved.cause);
      setError({
        message: gt("Couldn't save your shortcut. Review the changes and try again."),
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
          <span>
            <T>Shortcut</T>
          </span>
          {recorder.input}
        </div>
      ) : null}
      {recorder.recording ? (
        <p role="status" className="text-xs text-muted-foreground">
          <T>Press your shortcut. Esc cancels.</T>
        </p>
      ) : null}
      {result ? (
        <p role="status">
          {result.warning
            ? gt("Saved, but the shortcut needs attention. Check Advanced for help.")
            : preview?.operation === "remove"
              ? gt("Shortcut removed.")
              : gt("Use {shortcut} from another app to capture a window.", {
                  shortcut: preview?.shortcut,
                })}
        </p>
      ) : preview ? (
        <>
          <p className="text-muted-foreground">
            {changed
              ? preview.operation === "remove"
                ? gt("Review the change below to remove your shortcut.")
                : gt("Review the change below, then save your shortcut.")
              : preview.operation === "remove"
                ? gt("There's no capture shortcut to remove.")
                : gt("This shortcut is already set up.")}
          </p>
          {diff ? (
            <div
              className="max-h-80 overflow-auto rounded-lg border text-xs"
              aria-label={gt("Shortcut changes")}
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
              <T>Only these changes will be saved. We'll keep a backup.</T>
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
                  ? gt("Saving…")
                  : changed
                    ? preview.operation === "install"
                      ? gt("Save shortcut")
                      : gt("Remove shortcut")
                    : gt("Done")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={actionBusy} onClick={() => setPreview(null)}>
              <T>Cancel</T>
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Allow {APP_NAME} to read your desktop settings. You'll review any changes here before
            saving.
          </p>
          <Button
            disabled={actionBusy || !bridge}
            aria-busy={working === "reading"}
            onClick={() => void read()}
          >
            {working === "reading" ? gt("Preparing changes…") : gt("Review changes")}
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
            ? "Connecting to your desktop…"
            : `Restart ${APP_NAME} to finish connecting your shortcut.`}
        </p>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          <T>Advanced</T>
        </summary>
        <div className="mt-3 space-y-3">
          {error?.detail || result?.warning ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                <T>Troubleshooting</T>
              </p>
              <p className="break-words">{error?.detail ?? result?.warning}</p>
            </div>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              <T>Settings file</T>
            </p>
            <p className="break-all font-mono">
              {preview?.path ??
                state.shortcutConfigPath ??
                (niri ? "~/.config/niri/config.kdl" : "~/.config/hypr/hyprland.conf")}
            </p>
            {niri ? <p>{APP_NAME} also reads any files included by this file.</p> : null}
            {preview && preview.resolvedPath !== preview.path ? (
              <p className="break-all">
                <T>
                  Linked to <Var>{preview.resolvedPath}</Var>. The link will be kept.
                </T>
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
              <T>Choose a different file…</T>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionBusy || !bridge}
              onClick={() => void read(customFile, "remove")}
            >
              <T>Remove shortcut…</T>
            </Button>
            {result ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy || !bridge}
                onClick={() => void read()}
              >
                <T>Review changes</T>
              </Button>
            ) : null}
          </div>
          <p>
            {niri
              ? gt(
                  "Use your desktop's shortcut settings file. A custom --config or NIRI_CONFIG can change its location.",
                )
              : gt(
                  "Use your desktop's shortcut settings file. On Omarchy, use your own bindings file, not its defaults.",
                )}
          </p>
          {result?.backupPath ? (
            <p className="break-all">{gt("Backup: {path}", { path: result.backupPath })}</p>
          ) : null}
          <p className="font-medium text-foreground">
            <T>Manual setup</T>
          </p>
          <p>
            {niri
              ? gt(
                  "Paste this inside {block} in your Niri config, then save. Change the keys if needed.",
                  { block: "binds { … }" },
                )
              : gt(
                  "Add this binding to your Hyprland config, then save. Change the keys if needed.",
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
            {isCopied ? gt("Copied") : gt("Copy shortcut")}
          </Button>
          <p>
            Turn capture off in {APP_NAME} to stop it. Remove the shortcut from {desktop} to free up
            the keys.
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
              <T>I've added the shortcut</T>
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
