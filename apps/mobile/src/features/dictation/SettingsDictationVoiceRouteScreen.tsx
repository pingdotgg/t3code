import { useGT, T } from "gt-react-native";
import { File } from "expo-file-system";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { nativeErrorMessage, type DictationDownloads } from "./dictationDownloads";
import {
  formatMegabytes,
  VOICE_FILTER_DOWNLOAD_BYTES,
  VOICE_FILTER_MODEL_ID,
} from "./dictationModels";
import { dictationNative, type DictationNativeModule } from "./dictationNative";
import { dictationDownloads, updateDictationSettings, useDictationState } from "./dictationRuntime";
import {
  DictationSettingsPage,
  DictationUnavailable,
  DownloadRow,
  Footnote,
} from "./DictationSettingsPage";
import { recordEnrollmentClip } from "./enrollmentRecorder";
import {
  createVoiceEnrollment,
  ENROLLMENT_CLIP_COUNT,
  ENROLLMENT_PROMPTS,
  type VoiceEnrollment,
} from "./voiceEnrollment";

const TITLE = "Only my voice";

type VoiceProfile = Awaited<ReturnType<DictationNativeModule["voiceProfileStatus"]>>;

/** A profile that cannot be read is shown as missing, so the page offers to record one. */
function loadProfile(
  native: DictationNativeModule,
  setProfile: (profile: VoiceProfile) => void,
  setFailure: (failure: string) => void,
) {
  return native.voiceProfileStatus().then(setProfile, (error: unknown) => {
    setProfile({ enrolled: false, clipCount: 0, createdAt: null });
    setFailure(nativeErrorMessage(error, "The voice profile could not be read."));
  });
}

export function SettingsDictationVoiceRouteScreen() {
  const downloads = dictationDownloads();
  if (dictationNative === null || downloads === null) return <DictationUnavailable title={TITLE} />;
  return <DictationVoice native={dictationNative} downloads={downloads} />;
}

function DictationVoice(props: {
  readonly native: DictationNativeModule;
  readonly downloads: DictationDownloads;
}) {
  const gt = useGT();
  const { native, downloads } = props;
  const filter = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot)[
    VOICE_FILTER_MODEL_ID
  ];
  const { settings } = useDictationState();
  const [device] = useState(() => native.deviceInfo());
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [rerecording, setRerecording] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const readProfile = () => loadProfile(native, setProfile, setFailure);
  const profileSaved = () => {
    setRerecording(false);
    setFailure(null);
    updateDictationSettings({ onlyMyVoice: true });
    void readProfile();
  };
  const [enrollment] = useState(() =>
    createVoiceEnrollment({
      native,
      record: recordEnrollmentClip,
      deleteFile: (uri) => new File(uri).delete(),
      onSaved: profileSaved,
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the profile and the filter live in native storage; leaving the page or the app stops a recording in progress
  useEffect(() => {
    void downloads.refresh();
    void loadProfile(native, setProfile, setFailure);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "background") enrollment.reset();
    });
    return () => {
      appState.remove();
      enrollment.reset();
    };
  }, [downloads, enrollment, native]);

  const enrollSampleVoice = () => {
    const uri = native.sampleClipUri();
    if (uri === null) return setFailure("The sample recording is missing from this build.");
    void native
      .saveVoiceProfile(Array<string>(ENROLLMENT_CLIP_COUNT).fill(uri))
      .then(profileSaved, (error: unknown) =>
        setFailure(nativeErrorMessage(error, "The voice profile could not be saved.")),
      );
  };

  const confirmDeleteProfile = () =>
    Alert.alert(gt("Delete your voice profile?"), gt("Dictation will keep every voice it hears."), [
      { text: gt("Cancel"), style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          updateDictationSettings({ onlyMyVoice: false });
          void native
            .deleteVoiceProfile()
            .then(readProfile, (error: unknown) =>
              setFailure(nativeErrorMessage(error, "The voice profile could not be deleted.")),
            );
        },
      },
    ]);

  const confirmDeleteFilter = () =>
    Alert.alert(gt("Delete the voice filter?"), gt("Dictation will keep every voice it hears."), [
      { text: gt("Cancel"), style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          updateDictationSettings({ onlyMyVoice: false });
          void downloads.remove(VOICE_FILTER_MODEL_ID);
        },
      },
    ]);

  const installed = filter.status?.installed === true;
  const enrolled = profile?.enrolled === true;

  return (
    <DictationSettingsPage title={TITLE}>
      {filter.status?.installed === false ? (
        <SettingsSection title={gt("Voice filter")}>
          <DownloadRow
            name="voice filter"
            description={gt("Tells your voice from other people's. {value}.", {
              value: formatMegabytes(VOICE_FILTER_DOWNLOAD_BYTES),
            })}
            state={filter}
            onDownload={() => void downloads.download(VOICE_FILTER_MODEL_ID)}
            onCancel={() => downloads.cancel(VOICE_FILTER_MODEL_ID)}
          />
        </SettingsSection>
      ) : null}

      {installed && profile !== null && (!enrolled || rerecording) ? (
        <SettingsSection title={gt("Record your voice")}>
          <EnrollmentRecorder
            enrollment={enrollment}
            onCancel={
              rerecording
                ? () => {
                    enrollment.reset();
                    setRerecording(false);
                  }
                : null
            }
          />
          {device.isSimulator ? (
            <View className="border-t border-border-subtle">
              <ListActionRow
                icon="doc.text"
                label={gt("Use the built-in sample voice")}
                description={gt("Simulator only. Enrolls the voice in the sample recording.")}
                onPress={enrollSampleVoice}
              />
            </View>
          ) : null}
        </SettingsSection>
      ) : null}

      {installed && enrolled && !rerecording ? (
        <SettingsSection title={gt("Voice profile")}>
          <ListToggleRow
            icon="person.fill.checkmark"
            label={gt("Only my voice")}
            description={gt("Removes other people's speech before transcribing.")}
            value={settings.onlyMyVoice}
            onValueChange={(onlyMyVoice) => updateDictationSettings({ onlyMyVoice })}
          />
          <View className="border-t border-border-subtle">
            <ListRowLayout label={gt("Recorded")} detail={formatDay(profile?.createdAt ?? null)} />
          </View>
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="mic"
              label={gt("Record again")}
              onPress={() => setRerecording(true)}
            />
          </View>
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="trash"
              tone="danger"
              label={gt("Delete voice profile")}
              onPress={confirmDeleteProfile}
            />
          </View>
        </SettingsSection>
      ) : null}

      {failure === null ? null : (
        <Text className="px-2 text-sm text-danger-foreground">{failure}</Text>
      )}

      {installed ? (
        <SettingsSection title={gt("Storage")}>
          <ListActionRow
            icon="trash"
            tone="danger"
            label={gt("Delete voice filter")}
            detail={formatMegabytes(filter.status?.sizeOnDiskBytes ?? 0)}
            onPress={confirmDeleteFilter}
          />
          {filter.error === null ? null : (
            <Text className="px-4 pb-3 text-sm text-danger-foreground">{filter.error}</Text>
          )}
        </SettingsSection>
      ) : null}

      {settings.modelId === "apple" ? (
        <Footnote>
          <T>
            Only my voice works with a downloaded model. Apple dictation keeps every voice it hears.
          </T>
        </Footnote>
      ) : null}
      <Footnote>
        <T>
          The filter compares each stretch of speech with your voice profile and removes the ones
          that are someone else and quieter than you, further from the phone. A voice as loud as
          yours stays. It adds a short wait after each recording. If it does not recognise you,
          nothing is removed. Your voice profile stays on this device. The filter model is by
          pyannote, WeSpeaker and BUT Speech@FIT (CC BY 4.0), converted by Fluid Inference.
        </T>
      </Footnote>
    </DictationSettingsPage>
  );
}

function formatDay(at: number | null): string | undefined {
  if (at === null) return undefined;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function EnrollmentRecorder(props: {
  readonly enrollment: VoiceEnrollment;
  readonly onCancel: (() => void) | null;
}) {
  const gt = useGT();
  const { enrollment } = props;
  const { phase, accepted, message } = useSyncExternalStore(
    enrollment.subscribe,
    enrollment.getSnapshot,
  );
  const sample = Math.min(accepted, ENROLLMENT_CLIP_COUNT - 1);
  return (
    <View className="gap-3 px-4 py-4">
      <Text className="text-sm font-t3-medium text-foreground-muted">
        {phase === "saving"
          ? gt("Saving your voice profile")
          : gt("Sample {value} of {ENROLLMENT_CLIP_COUNT}. Read this aloud:", {
              value: sample + 1,
              ENROLLMENT_CLIP_COUNT,
            })}
      </Text>
      <Text className="text-base leading-[23px] text-foreground">{ENROLLMENT_PROMPTS[sample]}</Text>
      {message === null ? null : <Text className="text-sm text-danger-foreground">{message}</Text>}
      <View className="flex-row items-center gap-3">
        {phase === "recording" ? (
          <Button
            label={gt("Stop")}
            icon="stop.fill"
            tone="danger"
            onPress={() => void enrollment.stop()}
          />
        ) : (
          <Button
            label={gt("Record")}
            icon="mic"
            tone="primary"
            loading={phase !== "idle"}
            onPress={() => void enrollment.start()}
          />
        )}
        {props.onCancel === null || phase === "saving" ? null : (
          <Button label={gt("Cancel")} tone="text" onPress={props.onCancel} />
        )}
      </View>
    </View>
  );
}
