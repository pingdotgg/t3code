import { useGT } from "gt-react-native";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { createContext, useContext, useRef } from "react";
import type { SpeechPlaybackControls } from "@t3tools/client-runtime/voice-output";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import {
  AuthSettingsWriteScope,
  type ScopedThreadRef,
  type ProjectSettingsOverrides,
  SpeechPlaybackRate,
  SpeechOutputDestination,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { voiceOutput } from "./voiceOutput";

export const SpeechPlaybackSettingsContext = createContext<SpeechPlaybackControls | null>(null);

export function useSpeechOutputDestination(
  threadRef: ScopedThreadRef | null = null,
): SpeechPlaybackControls {
  const gt = useGT();
  const scoped = useContext(SpeechPlaybackSettingsContext);
  const thread = useQuietThreadShell(threadRef);
  const { presentation } = useEnvironmentPresentation(threadRef?.environmentId ?? null);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canManage = useEnvironmentScope(threadRef?.environmentId ?? null, AuthSettingsWriteScope);
  const settings = presentation?.serverConfig?.settings;
  const effective = settings
    ? resolveProjectSettings(settings, thread?.projectId ?? null).settings
    : null;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const localDestination = AsyncResult.isSuccess(preferences)
    ? (preferences.value.speechOutputDestination ?? null)
    : null;
  const localRate = AsyncResult.isSuccess(preferences)
    ? (preferences.value.speechPlaybackRate ?? 1)
    : 1;
  const destination =
    effective?.speechPlaybackDestination === undefined
      ? localDestination
      : effective.speechPlaybackDestination;
  const playbackRate = effective?.speechPlaybackRate ?? localRate;
  const pending = useRef<{
    key: string;
    source: ProjectSettingsOverrides | undefined;
    value: ProjectSettingsOverrides;
  } | null>(null);
  const persist = (patch: {
    speechPlaybackDestination?: SpeechOutputDestination | null;
    speechPlaybackRate?: SpeechPlaybackRate;
  }) => {
    if (!threadRef || !thread?.projectId || !settings) return false;
    const key = `${threadRef.environmentId}:${thread.projectId}`;
    const source = settings.projectSettingsOverrides[thread.projectId];
    const previous = pending.current;
    const base = previous?.key === key && previous.source === source ? previous : null;
    const staged = { key, source, value: { ...(base?.value ?? source), ...patch } };
    pending.current = staged;
    void update({
      environmentId: threadRef.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [thread.projectId]: staged.value,
          },
        },
      },
    }).then((result) => {
      if (result._tag === "Failure" && pending.current === staged) pending.current = base;
    });
    return true;
  };
  const saveLocal = (patch: Parameters<typeof save>[0], title: string, message: string) => {
    void save(patch).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        Dialog.alert(title, message);
    });
  };
  const setPlaybackRate = (rate: SpeechPlaybackRate) => {
    if (threadRef && voiceOutput.getSnapshot().owner?.startsWith(`${scopedThreadKey(threadRef)}:`))
      voiceOutput.setPlaybackRate(rate);
    if (!persist({ speechPlaybackRate: rate }))
      saveLocal(
        { speechPlaybackRate: rate },
        gt("Could not save playback speed"),
        gt("Your previous playback speed is still selected. Please try again."),
      );
  };
  const choose = (destination: SpeechOutputDestination | null) => {
    if (persist({ speechPlaybackDestination: destination })) return;
    saveLocal(
      { speechOutputDestination: destination },
      gt("Could not save speech output choice"),
      gt("Your previous destination is still selected. Please try again."),
    );
  };
  return (
    scoped ?? {
      destination,
      choose,
      playbackRate,
      setPlaybackRate,
      selectVoice: (voice) => {
        if (destination) choose({ ...destination, voice });
      },
      canManage: threadRef ? canManage : true,
    }
  );
}
