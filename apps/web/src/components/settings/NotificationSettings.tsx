import { randomUUID } from "../../lib/utils";
import { DEFAULT_COMPLETION_AUDIO_SETTINGS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { Button } from "../ui/button";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
  previewCompletionSound,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
  useScopedSettingsWriteAllowed,
} from "./useScopedSettings";

export function NotificationSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const hasCompletionControls = connectedEnvironments.some(
    (environment) =>
      environment.serverConfig?.environment.capabilities.completionNotifications === true,
  );
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        permissionMessage ??
        (hasCompletionControls
          ? "Written system alerts and sounds for input, approval, failures and review guides on this device. Completion audio is controlled separately below; older hosts keep this device setting."
          : "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.")
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(
                  "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                );
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(
                  "Notifications are unavailable in this browser. Sound only is still available.",
                );
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(
                  "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                );
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
            <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const completionAudioPermissions = environmentAtomList(
  "web-completion-audio-permissions",
  serverEnvironment.bulkOffCompletionAudio.permissionAtom,
);

export function CompletionAudioSettings() {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const runBulk = useAtomCommand(serverEnvironment.bulkOffCompletionAudio, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [draftVolume, setDraftVolume] = useState<{ scopeKey: string; value: number } | null>(null);
  const volumeScopeKey = JSON.stringify([
    scope.kind,
    environments.map(({ environmentId }) => environmentId),
  ]);
  const editedVolume = draftVolume?.scopeKey === volumeScopeKey ? draftVolume.value : null;
  const supported = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.completionNotifications === true,
  );
  const permissions = useAtomValue(
    completionAudioPermissions(
      environmentIdsKey(supported.map(({ environmentId }) => environmentId)),
    ),
  );
  const settings =
    supported[0]?.serverConfig?.settings.completionAudio ?? DEFAULT_COMPLETION_AUDIO_SETTINGS;
  const mixedDefault = supported.some(
    (environment) =>
      environment.serverConfig?.settings.completionAudio.defaultMode !== settings.defaultMode,
  );
  const mixedTone = supported.some(
    (environment) => environment.serverConfig?.settings.completionAudio.tone !== settings.tone,
  );
  const mixedVolume = supported.some(
    (environment) => environment.serverConfig?.settings.completionAudio.volume !== settings.volume,
  );
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const settingsDisabled =
    !canWrite || projectScope || supported.length !== connectedEnvironments.length;
  const canBulk = !projectScope && permissions.every(Boolean);
  const volume = editedVolume ?? Math.round(settings.volume * 100);
  const commitVolume = () => {
    if (editedVolume === null || settingsDisabled) return;
    updateSettings({ completionAudio: { volume: editedVolume / 100 } });
    setDraftVolume(null);
  };
  if (supported.length === 0) return null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("completion-audio-default")}
        serverScoped
        settingKeys={["completionAudio"]}
        mixed={mixedDefault}
        status={
          supported.length !== connectedEnvironments.length
            ? "Update unsupported selected environments before changing defaults."
            : undefined
        }
        description="Applies to future top-level threads; subagents and forks start Off. Voice uses provider hooks and cannot cancel speech already started. Sound plays on web and desktop."
        resetAction={
          mixedDefault || settings.defaultMode !== "off" ? (
            <SettingResetButton
              label="completion audio for new threads"
              disabled={settingsDisabled}
              onClick={() => updateSettings({ completionAudio: { defaultMode: "off" } })}
            />
          ) : null
        }
        control={
          <Select
            value={mixedDefault ? null : settings.defaultMode}
            disabled={settingsDisabled}
            onValueChange={(defaultMode) => {
              if (defaultMode === "off" || defaultMode === "voice" || defaultMode === "sound")
                updateSettings({ completionAudio: { defaultMode } });
            }}
          >
            <SelectTrigger size="sm" aria-label="Completion audio for new threads">
              <SelectValue>
                {mixedDefault
                  ? "Mixed"
                  : settings.defaultMode === "voice"
                    ? "Voice"
                    : settings.defaultMode === "sound"
                      ? "Sound"
                      : "Off"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="voice">Voice</SelectItem>
              <SelectItem value="sound">Sound</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("completion-audio-sound")}
        serverScoped
        settingKeys={["completionAudio"]}
        mixed={mixedTone}
        description={
          previewError ??
          "Bundled tone for threads set to Sound. Preview plays only on this device and does not change a preference."
        }
        control={
          <div className="flex items-center gap-2">
            <Select
              value={mixedTone ? null : settings.tone}
              disabled={settingsDisabled}
              onValueChange={(tone) => {
                if (tone === "completion" || tone === "input")
                  updateSettings({ completionAudio: { tone } });
              }}
            >
              <SelectTrigger size="sm" aria-label="Completion sound">
                <SelectValue>
                  {mixedTone ? "Mixed" : settings.tone === "completion" ? "Chime" : "Alert"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="completion">Chime</SelectItem>
                <SelectItem value="input">Alert</SelectItem>
              </SelectPopup>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={previewing || mixedTone || mixedVolume}
              onClick={() => {
                setPreviewError(null);
                setPreviewing(true);
                void previewCompletionSound(settings.tone, settings.volume).then(
                  (played) => {
                    setPreviewing(false);
                    if (!played)
                      setPreviewError(
                        "Couldn't play the preview. Click anywhere in the app, then try again.",
                      );
                  },
                  () => {
                    setPreviewing(false);
                    setPreviewError(
                      "Couldn't play the preview. Click anywhere in the app, then try again.",
                    );
                  },
                );
              }}
            >
              {previewing ? "Playing…" : "Preview"}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Completion sound volume"
        serverScoped
        settingKeys={["completionAudio"]}
        mixed={mixedVolume}
        description="Applies to completion tones, not provider-owned voice. Saves when you release the slider or an arrow key."
        control={
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              disabled={settingsDisabled}
              aria-label="Completion sound volume"
              onChange={(event) =>
                setDraftVolume({
                  scopeKey: volumeScopeKey,
                  value: Number(event.currentTarget.value),
                })
              }
              onPointerUp={commitVolume}
              onKeyUp={commitVolume}
              onPointerCancel={() => setDraftVolume(null)}
            />
            <output className="text-xs tabular-nums">
              {mixedVolume && editedVolume === null ? "Mixed" : `${volume}%`}
            </output>
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("completion-audio-bulk-off")}
        status={
          projectScope
            ? "Choose an environment scope to turn off existing threads."
            : !canBulk
              ? "This connection lacks permission to operate threads on selected environments."
              : undefined
        }
        description={
          <span>
            Includes existing archived threads and subagents across all providers. Does not change
            the default for future threads or guarantee immediate cancellation of external hooks.
            {results.map((line) => (
              <span className="block" key={line}>
                {line}
              </span>
            ))}
          </span>
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !canBulk}
            onClick={async () => {
              if (pending || !canBulk) return;
              setPending(true);
              const lines = environments
                .filter(
                  (environment) =>
                    !supported.some((entry) => entry.environmentId === environment.environmentId),
                )
                .map(
                  (environment) =>
                    `${settingsScopeEnvironmentLabel(environment, environments)}: not changed (offline or unsupported).`,
                );
              for (const environment of supported) {
                const label = settingsScopeEnvironmentLabel(environment, environments);
                const result = await runBulk({
                  environmentId: environment.environmentId,
                  input: { clientRequestId: randomUUID() },
                });
                if (result._tag !== "Success") {
                  lines.push(
                    `${label}: could not turn off existing threads. Retry after checking the connection and permissions.`,
                  );
                  continue;
                }
                const report = result.value;
                const superseded = report.failed.filter(
                  (failure) => failure.reason === "superseded",
                ).length;
                lines.push(
                  `${label}: ${report.turnedOff} turned off, ${report.alreadyOff} already off${report.failedCount > 0 ? `, ${report.failedCount} failed or changed after the request` : ""}.${!report.complete ? " Incomplete." : ""}${superseded > 0 ? ` ${superseded} reported later choices were preserved.` : ""}${report.failuresTruncated ? ` Failure details were truncated to ${report.failed.length} of ${report.failedCount} targets.` : ""}`,
                );
              }
              setResults(lines);
              setPending(false);
            }}
          >
            {pending ? "Turning off…" : "Turn off existing threads"}
          </Button>
        }
      />
    </>
  );
}
