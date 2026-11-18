import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DeviceSummary, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { renewDeviceHubAccess } from "~/state/device";
import { type DeviceRecorder, startDeviceRecorder } from "./deviceRecorder";
import { type DeviceActionBody, describeDeviceAction } from "./deviceRecording.logic";
import { handOffDeviceRecording } from "./deviceRecordingHandoff";
import { deviceScreenKey, observeDeviceInput } from "./deviceStreamSession";

/** Keeps the video under the attachment limit at the recorder's bitrate. */
const MAX_DEVICE_RECORDING_MS = 3 * 60_000;

export type DeviceRecordingState =
  | { readonly status: "idle" }
  | { readonly status: "recording"; readonly startedAt: number }
  | { readonly status: "saving" };

interface ActiveRecording {
  readonly recorder: DeviceRecorder;
  readonly threadRef: ScopedThreadRef;
  readonly context: string;
  readonly videoUnavailableReason: string | null;
  readonly unobserve: () => void;
  readonly limitTimer: ReturnType<typeof setTimeout>;
}

export function useDeviceRecording(options: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly device: DeviceSummary;
  readonly access: DeviceHubAccess | null;
  readonly visible: boolean;
  /** The app in the foreground when recording starts, such as a bundle id. */
  readonly appId: string | null;
}) {
  const { environmentId, device, access, visible } = options;
  const [state, setState] = useState<DeviceRecordingState>({ status: "idle" });
  const active = useRef<ActiveRecording | null>(null);

  const finish = () => {
    const recording = active.current;
    if (!recording) return;
    active.current = null;
    recording.unobserve();
    clearTimeout(recording.limitTimer);
    setState({ status: "saving" });
    void recording.recorder
      .stop()
      .then((result) =>
        handOffDeviceRecording({
          threadRef: recording.threadRef,
          result,
          context: recording.context,
          videoUnavailableReason: recording.videoUnavailableReason,
        }),
      )
      .then(
        ({ steps, frames, video }) =>
          toastManager.add({
            type: "success",
            title: m(msg("Recording added to the composer")),
            description: video
              ? m(
                  msg(
                    "{steps, plural, one {{steps} step} other {{steps} steps}}, {frames, plural, one {{frames} frame} other {{frames} frames}} and a video. Edit it, then send.",
                    { steps, frames },
                  ),
                )
              : m(
                  msg(
                    "{steps, plural, one {{steps} step} other {{steps} steps}} and {frames, plural, one {{frames} frame} other {{frames} frames}}. Edit it, then send.",
                    { steps, frames },
                  ),
                ),
          }),
        (cause: unknown) =>
          toastManager.add({
            type: "error",
            title: m(msg("Could not add the recording")),
            description: cause instanceof Error ? cause.message : m(msg("Try recording again.")),
          }),
      )
      .finally(() => setState({ status: "idle" }));
  };

  const start = (videoSource: HTMLCanvasElement | null) => {
    if (active.current || state.status !== "idle" || !access || !visible) return;
    const recorder = startDeviceRecorder({
      target: { access, platform: device.platform, deviceId: device.id },
      renewAccess: () => renewDeviceHubAccess(environmentId, device.hostId),
      videoSource,
    });
    active.current = {
      recorder,
      threadRef: options.threadRef,
      context: [`${device.name} (${device.version})`, options.appId ? `in ${options.appId}` : null]
        .filter(Boolean)
        .join(" "),
      videoUnavailableReason: videoSource
        ? null
        : // oxlint-disable-next-line t3code/no-untranslated-copy -- a note in the recording sent to the agent
          "this browser streams the device as still images, which cannot be recorded",
      unobserve: observeDeviceInput(
        deviceScreenKey(environmentId, device.hostId, device.id),
        recorder.record,
      ),
      limitTimer: setTimeout(finish, MAX_DEVICE_RECORDING_MS),
    };
    setState({ status: "recording", startedAt: Date.now() });
  };

  const finishOnHide = useEffectEvent(finish);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends an active recording (timers, MediaRecorder, input observer) when the panel hides or unmounts, since the stream it records stops too
  useEffect(() => {
    if (!visible) return;
    return () => finishOnHide();
  }, [visible]);

  return {
    state,
    toggle: (videoSource: HTMLCanvasElement | null) =>
      state.status === "recording" ? finish() : start(videoSource),
    /** Logs a host action, such as an appearance change, that does not go through the stream. */
    noteAction: (action: DeviceActionBody) => {
      active.current?.recorder.record({
        type: "action",
        description: describeDeviceAction(action),
      });
    },
  };
}
