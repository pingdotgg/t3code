import type { PluginUiContext, PluginSubscriptionEvent } from "@t3tools/plugin-api/ui";

import { VOICE_INPUT_COMMANDS, VOICE_INPUT_EVENTS } from "../shared/constants.ts";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  WHISPER_DEVICES,
  WHISPER_MODELS,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
  type VoiceInputSettingsUpdateResult,
  type VoiceInputTranscriptionTestResult,
} from "../shared/schema.ts";
import {
  applyVoiceInputSettingsPatch,
  getModelDownloadBlockedReason,
  sameVoiceInputSettings,
} from "../shared/settings.ts";
import {
  useVoiceInputClientState,
  voiceInputCommandErrorMessage,
} from "./voiceInputClientState.ts";

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function bytesFromMb(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return parsed * 1024 * 1024;
}

function statusTone(available: boolean): "success" | "warning" {
  return available ? "success" : "warning";
}

function statusLabel(available: boolean): string {
  return available ? "Ready" : "Missing";
}

function DependencyRow({
  ctx,
  label,
  available,
  detail,
}: {
  readonly ctx: PluginUiContext;
  readonly label: string;
  readonly available: boolean;
  readonly detail?: string;
}) {
  const React = ctx.react;
  const C = ctx.components;
  return React.createElement(
    C.ListRow,
    {
      actions: React.createElement(
        C.Badge,
        { tone: statusTone(available) },
        statusLabel(available),
      ),
    },
    React.createElement(
      C.Stack,
      { gap: "xs" },
      React.createElement(C.Text, { variant: "label" }, label),
      detail ? React.createElement(C.Text, { tone: "muted", variant: "caption" }, detail) : null,
    ),
  );
}

export function VoiceInputSettingsPage({ ctx }: { readonly ctx: PluginUiContext }) {
  const React = ctx.react;
  const C = ctx.components;
  const clientState = useVoiceInputClientState(ctx, {
    errorToastTitle: "Could not load Voice Input settings",
  });
  const settings = clientState.settings;
  const status = clientState.status;
  const cachePath = clientState.cachePath;
  const loading = clientState.loading;
  const [draft, setDraft] = React.useState<VoiceInputSettings | null>(null);
  const previousSettingsRef = React.useRef<VoiceInputSettings | null>(null);
  const [microphonePermission, setMicrophonePermission] = React.useState<string>("unknown");
  const [saving, setSaving] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [downloadPhase, setDownloadPhase] = React.useState<string | null>(null);
  const [testMessage, setTestMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!settings) return;
    const previousSettings = previousSettingsRef.current;
    previousSettingsRef.current = settings;
    setDraft((current) =>
      current === null ||
      previousSettings === null ||
      sameVoiceInputSettings(current, previousSettings)
        ? settings
        : current,
    );
  }, [settings]);

  React.useEffect(() => {
    let cancelled = false;
    let removePermissionListener: (() => void) | null = null;
    if (!navigator.permissions?.query) return;
    void navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((permissionStatus) => {
        if (cancelled) return;
        const syncPermission = () => {
          setMicrophonePermission(permissionStatus.state);
        };
        syncPermission();
        permissionStatus.addEventListener("change", syncPermission);
        removePermissionListener = () =>
          permissionStatus.removeEventListener("change", syncPermission);
      })
      .catch(() => {
        if (!cancelled) setMicrophonePermission("unknown");
      });
    return () => {
      cancelled = true;
      removePermissionListener?.();
    };
  }, []);

  React.useEffect(() => {
    return ctx.api.subscribe((event: PluginSubscriptionEvent) => {
      if (event.type === VOICE_INPUT_EVENTS.modelDownloadStarted) {
        setDownloading(true);
        setDownloadPhase("Starting download");
      }
      if (event.type === VOICE_INPUT_EVENTS.modelDownloadProgress) {
        setDownloadPhase("Loading model");
      }
      if (event.type === VOICE_INPUT_EVENTS.modelDownloadCompleted) {
        setDownloading(false);
        setDownloadPhase("Downloaded");
      }
      if (event.type === VOICE_INPUT_EVENTS.modelDownloadFailed) {
        setDownloading(false);
        setDownloadPhase("Download failed");
      }
    });
  }, [ctx.api]);

  const patchDraft = (patch: VoiceInputSettingsPatch) => {
    setDraft((current) => (current ? applyVoiceInputSettingsPatch(current, patch) : current));
  };

  const hasChanges = !sameVoiceInputSettings(settings, draft);
  const modelCached = status?.selectedModelCached === true;
  const downloadBlockedReason = getModelDownloadBlockedReason(status, hasChanges);
  const downloadDisabled = downloading || !draft || downloadBlockedReason !== null;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await ctx.api.invoke<VoiceInputSettingsUpdateResult>(
        VOICE_INPUT_COMMANDS.settingsUpdate,
        { patch: draft },
      );
      setDraft(result.settings);
      clientState.applySettingsResult(result);
      ctx.toast.success("Voice Input settings saved");
    } catch (error) {
      ctx.toast.error("Could not save Voice Input settings", voiceInputCommandErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const downloadModel = async () => {
    if (downloadBlockedReason) {
      ctx.toast.error("Whisper model is not ready to download", downloadBlockedReason);
      return;
    }
    setDownloading(true);
    setDownloadPhase("Starting download");
    try {
      await ctx.api.invoke(VOICE_INPUT_COMMANDS.modelDownload, {});
      ctx.toast.success("Whisper model downloaded");
    } catch (error) {
      ctx.toast.error("Could not download Whisper model", voiceInputCommandErrorMessage(error));
    } finally {
      setDownloading(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestMessage("Testing model load");
    try {
      const result = await ctx.api.invoke<VoiceInputTranscriptionTestResult>(
        VOICE_INPUT_COMMANDS.transcriptionTest,
        {},
      );
      setTestMessage(result.message);
      if (result.ok) {
        ctx.toast.success("Local Whisper test passed", result.message);
      } else {
        ctx.toast.error("Local Whisper test failed", result.message);
      }
    } catch (error) {
      const message = voiceInputCommandErrorMessage(error);
      setTestMessage(message);
      ctx.toast.error("Local Whisper test failed", message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <C.Page
      title="Voice Input"
      actions={
        <>
          <C.Button disabled={loading} onClick={clientState.refreshWithToast}>
            Refresh
          </C.Button>
          <C.Button disabled={!hasChanges || saving || !draft} variant="primary" onClick={save}>
            {saving ? "Saving" : "Save"}
          </C.Button>
        </>
      }
    >
      <C.Section description="Microphone recording happens in this browser. Local Whisper runs on the connected T3 backend.">
        {!draft ? (
          <C.Spinner label="Loading Voice Input" />
        ) : (
          <C.Stack gap="md">
            <C.Field label="Enabled">
              <C.Switch
                checked={draft.enabled}
                label="Enable Composer microphone action"
                onCheckedChange={(enabled) => patchDraft({ enabled })}
              />
            </C.Field>
            <C.Inline gap="md" wrap>
              <C.Field label="Whisper model">
                <C.Select
                  value={draft.model}
                  options={WHISPER_MODELS.map((model) => ({ value: model, label: model }))}
                  onValueChange={(model) =>
                    patchDraft({ model: model as VoiceInputSettings["model"] })
                  }
                />
              </C.Field>
              <C.Field label="Language">
                <C.Input
                  value={draft.language}
                  placeholder="auto"
                  onValueChange={(language) => patchDraft({ language: language || "auto" })}
                />
              </C.Field>
              <C.Field label="Device">
                <C.Select
                  value={draft.device}
                  options={WHISPER_DEVICES.map((device) => ({ value: device, label: device }))}
                  onValueChange={(device) =>
                    patchDraft({ device: device as VoiceInputSettings["device"] })
                  }
                />
              </C.Field>
            </C.Inline>
            <C.Inline gap="md" wrap>
              <C.Field label="Max recording seconds">
                <C.Input
                  type="number"
                  value={String(draft.maxRecordingSeconds)}
                  onValueChange={(value) =>
                    patchDraft({ maxRecordingSeconds: Number.parseInt(value, 10) || 120 })
                  }
                />
              </C.Field>
              <C.Field label="Max upload MB">
                <C.Input
                  type="number"
                  value={String(mb(draft.maxUploadBytes))}
                  onValueChange={(value) => patchDraft({ maxUploadBytes: bytesFromMb(value) })}
                />
              </C.Field>
              <C.Field label="Timeout seconds">
                <C.Input
                  type="number"
                  value={String(draft.transcriptionTimeoutSeconds)}
                  onValueChange={(value) =>
                    patchDraft({ transcriptionTimeoutSeconds: Number.parseInt(value, 10) || 120 })
                  }
                />
              </C.Field>
            </C.Inline>
            <C.Field label="Prompt hint">
              <C.TextArea
                rows={3}
                value={draft.promptHint}
                placeholder="Optional vocabulary or context"
                onValueChange={(promptHint) => patchDraft({ promptHint })}
              />
            </C.Field>
            <C.Field label="Cache path">
              <C.Input value={cachePath} disabled onValueChange={() => {}} />
            </C.Field>
            <C.Field
              label="Python executable"
              description="Leave blank to auto-detect the plugin venv first, then python3."
            >
              <C.Input
                value={draft.pythonCommand ?? ""}
                placeholder="auto"
                onValueChange={(pythonCommand) => patchDraft({ pythonCommand })}
              />
            </C.Field>
          </C.Stack>
        )}
      </C.Section>

      <C.Section
        title="Status"
        actions={
          <C.Inline gap="sm">
            <C.Button
              disabled={downloadDisabled}
              {...(downloadBlockedReason ? { title: downloadBlockedReason } : {})}
              onClick={() => void downloadModel()}
            >
              {downloading ? "Downloading" : modelCached ? "Download again" : "Download model"}
            </C.Button>
            <C.Button disabled={!modelCached || testing} onClick={() => void runTest()}>
              {testing ? "Testing" : "Test"}
            </C.Button>
          </C.Inline>
        }
      >
        {status ? (
          <C.List>
            <DependencyRow
              ctx={ctx}
              label="Browser microphone"
              available={microphonePermission !== "denied"}
              detail={microphonePermission}
            />
            <DependencyRow
              ctx={ctx}
              label="Python"
              available={status.python.available}
              {...(status.python.detail !== undefined ? { detail: status.python.detail } : {})}
            />
            <DependencyRow
              ctx={ctx}
              label="faster-whisper"
              available={status.fasterWhisper.available}
              detail={status.fasterWhisper.detail ?? status.installCommand}
            />
            <DependencyRow
              ctx={ctx}
              label="Plugin venv"
              available={status.venvPython.available}
              detail={status.venvPython.detail ?? status.venvPythonCommand}
            />
            <DependencyRow
              ctx={ctx}
              label="Selected model"
              available={status.selectedModelCached}
              detail={status.selectedModelCached ? "Cached" : "Not downloaded"}
            />
            <DependencyRow
              ctx={ctx}
              label="ffmpeg"
              available={status.ffmpeg.available}
              {...(status.ffmpeg.detail !== undefined ? { detail: status.ffmpeg.detail } : {})}
            />
          </C.List>
        ) : (
          <C.Spinner label="Checking dependencies" />
        )}
        {downloadPhase ? (
          <C.Text tone="muted" variant="caption">
            {downloadPhase}
          </C.Text>
        ) : null}
        {downloadBlockedReason ? (
          <C.Text tone="warning" variant="caption">
            {downloadBlockedReason}
          </C.Text>
        ) : null}
        {status && !status.fasterWhisper.available ? (
          <C.Field label="Recommended venv setup command">
            <C.Input value={status.venvSetupCommand} disabled onValueChange={() => {}} />
          </C.Field>
        ) : null}
        {testMessage ? (
          <C.Text tone="muted" variant="caption">
            {testMessage}
          </C.Text>
        ) : null}
      </C.Section>

      <C.Section title="Keybinding">
        <C.Inline gap="sm" align="center" wrap>
          <C.Text tone="muted">Assign shortcuts for toggle and cancel in Keybindings.</C.Text>
          <C.Link href="/settings/keybindings">Open Keybindings</C.Link>
        </C.Inline>
      </C.Section>
    </C.Page>
  );
}
