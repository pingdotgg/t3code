import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { T, useGT, useLocale, Var } from "gt-react-native";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  cancelEnvironmentSpeechModelDownload,
  installEnvironmentSpeechModel,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type EnvironmentSpeechModel,
} from "@t3tools/contracts";
import { speechModelDownloadPercent } from "@t3tools/shared/speech";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text as NativeText, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { m } from "../../i18n/messages";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { Progress } from "../../components/ui/Progress";
import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentScope } from "../../state/session";
import {
  runSpeech,
  voiceConnectionAtom,
  voiceSpeechModelsAtom,
  voiceSpeechStatusAtom,
} from "../voice-input/voiceDestination";

export type VoiceModel = Pick<
  EnvironmentSpeechModel,
  | "id"
  | "name"
  | "description"
  | "size"
  | "languages"
  | "benchmark"
  | "active"
  | "downloaded"
  | "linkedFrom"
> & {
  readonly state: EnvironmentSpeechModel["state"] | "cancelling" | "failed";
  readonly canRun?: boolean;
};

export type VoiceModelList = {
  readonly models: ReadonlyArray<VoiceModel>;
  readonly loading: boolean;
  readonly canManage: boolean;
  readonly requested?: string | null;
  readonly busy: boolean;
  readonly downloading: boolean;
  download(model: VoiceModel): void;
  select(model: VoiceModel): void;
  cancel(model: VoiceModel): void;
  remove(model: VoiceModel): void;
};

export const isDownloading = (model: VoiceModel) =>
  model.state === "downloading" || model.state === "verifying" || model.state === "cancelling";

export function useVoiceModels(environmentId: EnvironmentId, label: string) {
  const gt = useGT();
  const connection = useAtomValue(voiceConnectionAtom(environmentId));
  const statusAtom = voiceSpeechStatusAtom(environmentId);
  const modelsAtom = voiceSpeechModelsAtom(environmentId);
  const status = AsyncResult.getOrElse(useAtomValue(statusAtom), () => null);
  const modelsResult = useAtomValue(modelsAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  const refreshModels = useAtomRefresh(modelsAtom);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [requested, setRequested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const models = AsyncResult.getOrElse(modelsResult, () => null)?.models ?? [];
  const downloading = requested !== null || models.some(isDownloading);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the environment's download progress while one runs
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(refreshModels, 1_000);
    return () => clearInterval(timer);
  }, [downloading, refreshModels]);

  const run = async (title: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (downloadId) setRequested(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      Dialog.alert(
        title,
        error instanceof Error ? (errorDisplayMessage(error, m) ?? error.message) : String(error),
      );
    }
    if (downloadId) setRequested(null);
    else setBusy(false);
    refreshModels();
    refreshStatus();
  };
  const ready = connection !== null && status?.supported === true;
  return {
    connection,
    status,
    models,
    loading: modelsResult._tag === "Initial",
    canManage,
    requested,
    busy,
    downloading,
    label,
    download: (model: VoiceModel) => {
      if (!ready) return;
      Dialog.confirm({
        title: gt("Download {model}?", { model: model.name }),
        message: gt("{environment} will download {size} and use it as its transcription model.", {
          environment: label,
          size: formatBytes(model.size),
        }),
        confirmText: gt("Download", { $context: "verb" }),
        onConfirm: () =>
          void run(
            gt("Could not download the model"),
            () => runSpeech(installEnvironmentSpeechModel(connection, model.id)),
            model.id,
          ),
      });
    },
    select: (model: VoiceModel) => {
      if (!ready || model.active) return;
      void run(gt("Could not select the model"), () =>
        runSpeech(selectEnvironmentSpeechModel(connection, model.id)),
      );
    },
    cancel: (model: VoiceModel) => {
      if (!ready) return;
      void run(gt("Could not cancel the download"), () =>
        runSpeech(cancelEnvironmentSpeechModelDownload(connection, model.id)),
      );
    },
    remove: (model: VoiceModel) => {
      if (!ready) return;
      void run(gt("Could not remove the model"), () =>
        runSpeech(removeEnvironmentSpeechModel(connection, model.id)),
      );
    },
  };
}

const languageNames = new Map<string, Intl.DisplayNames>();
function languageLabel(code: string, locale: string) {
  if (typeof Intl.DisplayNames !== "function") return code.toUpperCase();
  let names = languageNames.get(locale);
  if (!names)
    languageNames.set(locale, (names = new Intl.DisplayNames([locale], { type: "language" })));
  return names.of(code) ?? code.toUpperCase();
}

function ModelStats(props: { readonly model: VoiceModel; readonly language: string }) {
  const { model, language } = props;
  const locale = useLocale();
  const data = model.benchmark;
  const code = !data
    ? undefined
    : data.accuracy[language]
      ? language
      : (model.languages.find((candidate) => data.accuracy[candidate]) ?? model.languages[0]);
  const score = code ? data?.accuracy[code] : undefined;
  const parts: ReadonlyArray<readonly [string, ReactNode]> = [
    ...(code && score
      ? ([
          [
            "score",
            <T key="score">
              <Var>{languageLabel(code, locale)}</Var>{" "}
              <Text className="font-t3-medium text-foreground">
                <Var>{score.grade}</Var>
              </Text>{" "}
              (<Var>{score.errorPercent}</Var>% error)
            </T>,
          ],
        ] as const)
      : []),
    ...(data && data.secondsPer30s.accelerated !== null
      ? ([
          [
            "speed",
            <>
              <Text className="font-t3-medium text-foreground">
                {Number(data.secondsPer30s.accelerated.toFixed(2))} s
              </Text>{" "}
              / 30 s
            </>,
          ],
        ] as const)
      : []),
    // A single-language model's score already names its language.
    ...(model.languages.length > 1
      ? ([
          [
            "languages",
            <>
              <SymbolView
                name="globe"
                size={13}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
                weight="regular"
              />{" "}
              {model.languages.length}
            </>,
          ],
        ] as const)
      : score
        ? []
        : ([["languages", languageLabel(model.languages[0] ?? "", locale)]] as const)),
    ["size", formatBytes(model.size)],
  ];
  return (
    <Text textRole="footnote" className="text-foreground-muted tabular-nums">
      {parts.map(([key, part], index) => (
        // Plain Text inherits the muted footnote style; AppText would reset it.
        <NativeText key={key}>
          {index > 0 ? " · " : null}
          {part}
        </NativeText>
      ))}
    </Text>
  );
}

function InstalledModelGlyph(props: { readonly linked: boolean }) {
  return (
    <View className="size-6">
      <SymbolView
        name={props.linked ? "link" : "tray.and.arrow.down"}
        size={Platform.OS === "android" ? 24 : 22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      {props.linked ? null : (
        <View className="absolute -right-1.5 -bottom-1 size-3.5 items-center justify-center rounded-full bg-primary ring-2 ring-grouped-card">
          <SymbolView
            name="checkmark"
            size={9}
            tintColorClassName="accent-primary-foreground"
            type="monochrome"
            weight="bold"
          />
        </View>
      )}
    </View>
  );
}

const FAIL_OFFSET_Y: [number, number] = [-10, 10];

export function VoiceModelRow(props: {
  readonly model: VoiceModel;
  readonly voice: VoiceModelList;
  readonly separated: boolean;
  /** The language whose benchmark score to show, when the model has one. */
  readonly language: string;
  readonly onSwipeableOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
}) {
  const gt = useGT();
  const swipeable = useRef<SwipeableMethods>(null);
  const { model, voice, separated } = props;
  const meta = <ModelStats model={model} language={props.language} />;
  const disabled = !voice.canManage || voice.busy || voice.downloading;
  if (model.state === "installed") {
    const linked = Boolean(model.linkedFrom);
    const canRun = model.canRun !== false;
    const actionLabel = linked ? gt("Unlink") : gt("Remove", { $context: "verb" });
    const accessibilityLabel = linked
      ? gt("Unlink {model}", { model: model.name })
      : gt("Remove {model}", { model: model.name });
    const confirmRemoval = () => {
      swipeable.current?.close();
      Dialog.confirm({
        title: linked
          ? gt("Unlink {model}?", { model: model.name })
          : gt("Remove {model}?", { model: model.name }),
        message: linked
          ? gt("Your model file stays on disk.")
          : !canRun
            ? undefined
            : model.active
              ? gt(
                  "This model is selected for dictation. Download it again to use it after removal.",
                )
              : gt("Download the model again to use it for dictation."),
        confirmText: actionLabel,
        destructive: !linked,
        onConfirm: () => voice.remove(model),
      });
    };
    const choice = (
      <ListChoiceRow
        leading={<InstalledModelGlyph linked={linked} />}
        label={model.name}
        description={canRun ? model.description : gt("Transcription unavailable")}
        meta={meta}
        selected={model.active}
        separated={separated}
        disabled={disabled}
        onPress={canRun ? () => voice.select(model) : undefined}
        accessibilityActions={
          disabled ? undefined : [{ name: "remove", label: accessibilityLabel }]
        }
        onAccessibilityAction={
          disabled
            ? undefined
            : ({ nativeEvent }) => {
                if (nativeEvent.actionName === "remove") confirmRemoval();
              }
        }
      />
    );
    if (disabled) return choice;
    return (
      <ReanimatedSwipeable
        key={model.id}
        ref={swipeable}
        dragOffsetFromRight={-8}
        failOffsetY={FAIL_OFFSET_Y}
        overshootRight={false}
        onSwipeableWillOpen={() => {
          if (swipeable.current) props.onSwipeableOpen(swipeable.current);
        }}
        onSwipeableClose={() => {
          if (swipeable.current) props.onSwipeableClose(swipeable.current);
        }}
        renderRightActions={() => (
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={confirmRemoval}
            className="min-w-20 items-center justify-center gap-1 bg-danger px-3 active:opacity-75"
          >
            <SymbolView
              name={linked ? "link" : "trash"}
              size={18}
              tintColorClassName="accent-danger-foreground"
            />
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              {actionLabel}
            </Text>
          </Pressable>
        )}
      >
        {choice}
      </ReanimatedSwipeable>
    );
  }
  const percent =
    model.downloaded === undefined
      ? undefined
      : speechModelDownloadPercent(model.downloaded, model.size);
  if (isDownloading(model) || voice.requested === model.id)
    return (
      <View className={separated ? "border-t border-border-subtle" : ""}>
        <ListActionRow
          icon="xmark"
          label={model.name}
          description={
            model.state === "verifying"
              ? gt("Verifying download…")
              : model.state === "cancelling"
                ? gt("Cancelling download…")
                : gt("{percent}% downloaded · Tap to cancel", {
                    percent: percent ?? 0,
                  })
          }
          disabled={!voice.canManage || voice.busy || model.state === "cancelling"}
          onPress={() => voice.cancel(model)}
        />
        <Progress
          className="bg-grouped-card px-4 pb-3"
          percent={model.state === "verifying" ? undefined : percent}
          label={gt("{model} download progress", { model: model.name })}
        />
      </View>
    );
  return (
    <View className={separated ? "border-t border-border-subtle" : ""}>
      <ListActionRow
        icon="tray.and.arrow.down"
        label={model.name}
        description={
          model.state === "failed" ? gt("Download failed. Try again.") : model.description
        }
        meta={meta}
        disabled={disabled}
        onPress={() => voice.download(model)}
      />
    </View>
  );
}

/** The environment's local-model method: chosen by its mark, opens the model list. */
export function LocalModelChoice(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const voice = useVoiceModels(props.environmentId, props.label);
  const { status } = voice;
  const open = () =>
    navigation.navigate("SettingsVoiceModels", {
      source: "environment",
      environmentId: props.environmentId,
    });
  if (!voice.connection || !status || !status.supported)
    return (
      <ListChoiceRow
        label={gt("Local model")}
        description={
          !voice.connection
            ? gt("Not available on this environment")
            : status?.supported === false
              ? status.reason
              : gt("Checking…")
        }
        selected={props.selected}
        disabled
        onPress={() => {}}
      />
    );

  const active = status.state === "missing-model" ? null : status;
  const pending = voice.models.find(isDownloading);
  return (
    <ListRow
      label={active?.model ?? gt("Local model")}
      description={
        pending
          ? pending.state === "verifying"
            ? gt("Verifying {model}…", { model: pending.name })
            : gt("Downloading {model} · {percent}%", {
                model: pending.name,
                percent: speechModelDownloadPercent(pending.downloaded ?? 0, pending.size),
              })
          : active
            ? gt("Local model · {size}", { size: formatBytes(active.size) })
            : voice.canManage
              ? gt("No model installed · Choose one to download")
              : gt("No model installed · Add one using {product} on {environment}", {
                  product: "T3 Code",
                  environment: props.label,
                })
      }
      selected={props.selected}
      onPress={() => {
        if (!props.selected) props.onSelect();
        // Switching to an installed model needs no further step.
        if (props.selected || !active) open();
      }}
    />
  );
}
