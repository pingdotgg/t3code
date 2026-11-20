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
import { useGT, useMessages } from "gt-react";
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
import { useSearchableSetting } from "./settingsSearch";
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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
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
          ? gt(
              "Written system alerts and sounds for input, approval, failures and review guides on this device. Completion audio is controlled separately below; older hosts keep this device setting.",
            )
          : gt(
              "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.",
            ))
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
                  gt(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  ),
                );
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(
                  gt(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  ),
                );
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(
                  gt(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  ),
                );
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={gt("Thread notifications")}
          >
            <SelectValue>{m(NOTIFICATION_MODE_LABELS[mode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {m(label)}
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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
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
            ? gt("Update unsupported selected environments before changing defaults.")
            : undefined
        }
        description={gt(
          "Applies to future top-level threads; subagents and forks start Off. Voice uses provider hooks and cannot cancel speech already started. Sound plays on web and desktop.",
        )}
        resetAction={
          mixedDefault || settings.defaultMode !== "off" ? (
            <SettingResetButton
              ariaLabel={gt("Reset completion audio for new threads to default")}
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
            <SelectTrigger size="sm" aria-label={gt("Completion audio for new threads")}>
              <SelectValue>
                {mixedDefault
                  ? gt("Mixed")
                  : settings.defaultMode === "voice"
                    ? gt("Voice")
                    : settings.defaultMode === "sound"
                      ? gt("Sound")
                      : gt("Off")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">{gt("Off")}</SelectItem>
              <SelectItem value="voice">{gt("Voice")}</SelectItem>
              <SelectItem value="sound">{gt("Sound")}</SelectItem>
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
          gt(
            "Bundled tone for threads set to Sound. Preview plays only on this device and does not change a preference.",
          )
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
              <SelectTrigger size="sm" aria-label={gt("Completion sound")}>
                <SelectValue>
                  {mixedTone
                    ? gt("Mixed")
                    : settings.tone === "completion"
                      ? gt("Chime")
                      : gt("Alert")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="completion">{gt("Chime")}</SelectItem>
                <SelectItem value="input">{gt("Alert")}</SelectItem>
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
                        gt("Couldn't play the preview. Click anywhere in the app, then try again."),
                      );
                  },
                  () => {
                    setPreviewing(false);
                    setPreviewError(
                      gt("Couldn't play the preview. Click anywhere in the app, then try again."),
                    );
                  },
                );
              }}
            >
              {previewing ? gt("Playing…") : gt("Preview")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={gt("Completion sound volume")}
        serverScoped
        settingKeys={["completionAudio"]}
        mixed={mixedVolume}
        description={gt(
          "Applies to completion tones, not provider-owned voice. Saves when you release the slider or an arrow key.",
        )}
        control={
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              disabled={settingsDisabled}
              aria-label={gt("Completion sound volume")}
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
              {mixedVolume && editedVolume === null ? gt("Mixed") : `${volume}%`}
            </output>
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("completion-audio-bulk-off")}
        status={
          projectScope
            ? gt("Choose an environment scope to turn off existing threads.")
            : !canBulk
              ? gt("This connection lacks permission to operate threads on selected environments.")
              : undefined
        }
        description={
          <span>
            {gt(
              "Includes existing archived threads and subagents across all providers. Does not change the default for future threads or guarantee immediate cancellation of external hooks.",
            )}
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
                .map((environment) =>
                  gt("{environment}: not changed (offline or unsupported).", {
                    environment: settingsScopeEnvironmentLabel(environment, environments),
                  }),
                );
              for (const environment of supported) {
                const label = settingsScopeEnvironmentLabel(environment, environments);
                const result = await runBulk({
                  environmentId: environment.environmentId,
                  input: { clientRequestId: randomUUID() },
                });
                if (result._tag !== "Success") {
                  lines.push(
                    gt(
                      "{environment}: could not turn off existing threads. Retry after checking the connection and permissions.",
                      { environment: label },
                    ),
                  );
                  continue;
                }
                const report = result.value;
                const superseded = report.failed.filter(
                  (failure) => failure.reason === "superseded",
                ).length;
                const counts = {
                  environment: label,
                  turnedOff: report.turnedOff,
                  alreadyOff: report.alreadyOff,
                };
                const details = [
                  report.failedCount > 0
                    ? gt(
                        "{environment}: {turnedOff} turned off, {alreadyOff} already off, {count} failed or changed after the request.",
                        { ...counts, count: report.failedCount },
                      )
                    : gt(
                        "{environment}: {turnedOff} turned off, {alreadyOff} already off.",
                        counts,
                      ),
                ];
                if (!report.complete) details.push(gt("Incomplete."));
                if (superseded > 0) {
                  details.push(
                    gt("{count} reported later choices were preserved.", {
                      count: superseded,
                    }),
                  );
                }
                if (report.failuresTruncated) {
                  details.push(
                    gt("Failure details were truncated to {shown} of {count} targets.", {
                      shown: report.failed.length,
                      count: report.failedCount,
                    }),
                  );
                }
                lines.push(details.join(" "));
              }
              setResults(lines);
              setPending(false);
            }}
          >
            {pending ? gt("Turning off…") : gt("Turn off existing threads")}
          </Button>
        }
      />
    </>
  );
}
