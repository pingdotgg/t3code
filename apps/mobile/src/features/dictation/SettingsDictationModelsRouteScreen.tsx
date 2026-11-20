import { useGT, T } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { File } from "expo-file-system";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { getLocalVoiceTranscriber as getSystemVoiceTranscriber } from "../../native/voiceTranscription";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  KEPT_VOICE_RECORDINGS,
  keptVoiceRecordings,
  type KeptVoiceRecording,
} from "../voice-input/keptRecordings";
import { localVoiceTranscriberAtom } from "../voice-input/VoiceInputProvider";
import { useAppleDictationAvailable } from "./appleDictation";
import { nativeErrorMessage, type DictationDownloads } from "./dictationDownloads";
import {
  DICTATION_PROCESSING,
  deviceCanRun,
  formatMegabytes,
  LOCAL_DICTATION_MODELS,
  recommendedDictationModel,
  type LocalDictationModel,
} from "./dictationModels";
import { dictationNative, type DictationNativeModule } from "./dictationNative";
import {
  currentDictationSettings,
  deviceLocale,
  dictationDownloads,
  makeDictationTranscriber,
  updateDictationSettings,
  useDictationState,
} from "./dictationRuntime";
import {
  DictationSettingsPage,
  DictationUnavailable,
  DownloadRow,
  Footnote,
} from "./DictationSettingsPage";
import { describeRun } from "./runSummary";

const TITLE = "Dictation model";

type TrialResult =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "failed"; readonly message: string };

const SAMPLE = "sample";

/** `of` is the sample or a kept recording's URI. One result is on screen at a time, so the run details under it are its own. */
type Trial = { readonly of: string; readonly result: TrialResult };

function recordedAtLabel(recordedAt: number): string {
  return new Date(recordedAt).toLocaleString([], {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SettingsDictationModelsRouteScreen() {
  const downloads = dictationDownloads();
  if (dictationNative === null || downloads === null) return <DictationUnavailable title={TITLE} />;
  return <DictationModels native={dictationNative} downloads={downloads} />;
}

function DictationModels(props: {
  readonly native: DictationNativeModule;
  readonly downloads: DictationDownloads;
}) {
  const gt = useGT();
  const { native, downloads } = props;
  const snapshot = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  const { settings, lastRun } = useDictationState();
  const transcriber = useAtomValue(localVoiceTranscriberAtom);
  const appleMissing = useAppleDictationAvailable() === false;
  const [device] = useState(() => native.deviceInfo());
  const [trial, setTrial] = useState<Trial | null>(null);
  const [copied, setCopied] = useState(false);
  const [recordings, setRecordings] = useState(keptVoiceRecordings);
  const suggested = recommendedDictationModel({
    physicalMemoryBytes: device.physicalMemoryBytes,
    locale: deviceLocale(),
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- install state lives in native storage and is read when the page opens
  useEffect(() => {
    void downloads.refresh();
  }, [downloads]);

  useFocusEffect(useCallback(() => setRecordings(keptVoiceRecordings()), []));

  const describe = (model: LocalDictationModel) =>
    model.id === suggested ? `${model.summary} Suggested for this device.` : model.summary;
  const installed = LOCAL_DICTATION_MODELS.filter(
    (model) => snapshot[model.id].status?.installed === true,
  );
  const missing = LOCAL_DICTATION_MODELS.filter(
    (model) => snapshot[model.id].status?.installed === false,
  );

  const download = (model: LocalDictationModel) => {
    const chosen = settings.modelId;
    void downloads.download(model.id).then((ready) => {
      // A model the user picked while this one downloaded stays picked.
      if (ready && currentDictationSettings().modelId === chosen) {
        updateDictationSettings({ modelId: model.id });
      }
    });
  };

  const confirmDelete = (model: LocalDictationModel) =>
    Alert.alert(
      gt("Delete {name}?", { name: model.name }),
      gt("The model is removed from this device. You can download it again."),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (settings.modelId === model.id) {
              const other = installed.find((candidate) => candidate.id !== model.id);
              updateDictationSettings({ modelId: appleMissing && other ? other.id : "apple" });
            }
            void downloads.remove(model.id);
          },
        },
      ],
    );

  const transcribe = async (
    of: Trial["of"],
    uri: string,
    using: VoiceTranscriber,
    failure: string,
  ) => {
    setCopied(false);
    setTrial({ of, result: { status: "running" } });
    const { signal } = new AbortController();
    try {
      // Loaded first so this runs on the chosen model, not on the stand-in for a cold one.
      if (installed.some((model) => model.id === settings.modelId)) {
        await native.prepare(settings.modelId, DICTATION_PROCESSING);
      }
      const prepared = await using.prepare({ signal });
      const text = await prepared.transcribe(uri, { signal });
      setTrial({ of, result: { status: "done", text } });
    } catch (error) {
      setTrial({ of, result: { status: "failed", message: nativeErrorMessage(error, failure) } });
    }
  };

  const transcribeSample = () => {
    const uri = native.sampleClipUri();
    if (uri === null || transcriber === null || transcriber === "checking") {
      setTrial({
        of: SAMPLE,
        result: { status: "failed", message: gt("Dictation is not available right now.") },
      });
      return;
    }
    void transcribe(SAMPLE, uri, transcriber, "The sample could not be transcribed.");
  };

  const transcribeRecording = (recording: KeptVoiceRecording) => {
    if (!new File(recording.uri).exists) {
      setRecordings(keptVoiceRecordings());
      setTrial(null);
      return;
    }
    void transcribe(
      recording.uri,
      recording.uri,
      makeDictationTranscriber(getSystemVoiceTranscriber, { ignoreVoiceFilter: true }),
      "The recording could not be transcribed.",
    );
  };

  const running = trial?.result.status === "running" ? trial.of : null;
  const resultOf = (of: Trial["of"]) => {
    const result = trial?.of === of ? trial.result : null;
    if (result?.status === "failed") {
      return (
        <Text className="border-t border-border-subtle px-4 py-3 text-sm text-danger-foreground">
          {result.message}
        </Text>
      );
    }
    if (result?.status !== "done") return null;
    const heard = result.text.trim().length > 0;
    return (
      <>
        <View className="gap-1 border-t border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground" selectable>
            {heard ? result.text : gt("No speech was found in this recording.")}
          </Text>
          {lastRun === null ? null : (
            <Text className="text-sm text-foreground-muted">{describeRun(lastRun)}</Text>
          )}
        </View>
        {heard && of !== SAMPLE ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="doc.on.doc"
              label={copied ? gt("Copied") : gt("Copy the text")}
              onPress={() => void Clipboard.setStringAsync(result.text).then(() => setCopied(true))}
            />
          </View>
        ) : null}
      </>
    );
  };

  return (
    <DictationSettingsPage title={TITLE}>
      <SettingsSection title={gt("Use for dictation")}>
        <ListChoiceRow
          label={gt("Apple")}
          description={
            appleMissing
              ? gt("Not available on this device.")
              : gt("Built into iOS. Nothing to download.")
          }
          disabled={appleMissing}
          selected={settings.modelId === "apple" && !appleMissing}
          onPress={() => updateDictationSettings({ modelId: "apple" })}
        />
        {installed.map((model) => (
          <ListChoiceRow
            key={model.id}
            separated
            label={model.name}
            description={describe(model)}
            selected={settings.modelId === model.id}
            onPress={() => updateDictationSettings({ modelId: model.id })}
          />
        ))}
      </SettingsSection>

      {missing.length === 0 ? null : (
        <SettingsSection title={gt("Download")}>
          {missing.map((model, index) => (
            <View
              key={model.id}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              {deviceCanRun(model, device.physicalMemoryBytes) ? (
                <DownloadRow
                  name={model.name}
                  description={`${describe(model)} ${formatMegabytes(model.downloadBytes)}.`}
                  state={snapshot[model.id]}
                  onDownload={() => download(model)}
                  onCancel={() => downloads.cancel(model.id)}
                />
              ) : (
                <ListRowLayout
                  disabled
                  icon="arrow.down.circle"
                  label={model.name}
                  description={gt("{summary} Needs more memory than this device has.", {
                    summary: model.summary,
                  })}
                />
              )}
            </View>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title={gt("Try it")}>
        <ListActionRow
          icon="play"
          label={gt("Transcribe a sample")}
          description={gt("Runs a built-in recording through the model in use.")}
          loading={running === SAMPLE}
          disabled={running !== null}
          onPress={transcribeSample}
        />
        {resultOf(SAMPLE)}
      </SettingsSection>

      <SettingsSection
        title={gt("Recent recordings")}
        footer={`Your last ${KEPT_VOICE_RECORDINGS} dictations stay on this device, canceled ones included. Tap one to transcribe it again with the model in use and without the voice filter.`}
      >
        {recordings.length === 0 ? (
          <ListRowLayout disabled icon="mic" label={gt("No recordings yet")} />
        ) : (
          recordings.map((recording, index) => (
            <View
              key={recording.uri}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <ListActionRow
                icon="arrow.clockwise"
                label={recordedAtLabel(recording.recordedAt)}
                loading={running === recording.uri}
                disabled={running !== null}
                onPress={() => transcribeRecording(recording)}
              />
              {resultOf(recording.uri)}
            </View>
          ))
        )}
      </SettingsSection>

      {installed.length === 0 ? null : (
        <SettingsSection title={gt("Storage")}>
          {installed.map((model, index) => (
            <View
              key={model.id}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <ListActionRow
                icon="trash"
                tone="danger"
                label={`Delete ${model.name}`}
                detail={formatMegabytes(snapshot[model.id].status?.sizeOnDiskBytes ?? 0)}
                onPress={() => confirmDelete(model)}
              />
              {snapshot[model.id].error === null ? null : (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  {snapshot[model.id].error}
                </Text>
              )}
            </View>
          ))}
        </SettingsSection>
      )}

      <Footnote>
        <T>
          Downloaded models run on this device, and recordings never leave it. Parakeet models are
          by NVIDIA and moondream (CC BY 4.0), converted by Fluid Inference.
        </T>
      </Footnote>
    </DictationSettingsPage>
  );
}
