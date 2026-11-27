import { T, useGT, Var } from "gt-react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { voiceSpeechBenchmarksAtom } from "../voice-input/voiceDestination";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";
import { useDeviceVoiceModels } from "./DeviceVoiceEngineSection";
import { useVoiceModels, VoiceModelRow, type VoiceModelList } from "./VoiceModelSection";

type VoiceModelsSource =
  | { readonly source: "device" }
  | { readonly source: "environment"; readonly environmentId: EnvironmentId };

export function SettingsVoiceModelsRouteScreen({ route }: StaticScreenProps<VoiceModelsSource>) {
  return route.params.source === "device" ? (
    <DeviceVoiceModelsSheet />
  ) : (
    <EnvironmentVoiceModelsSheet environmentId={route.params.environmentId} />
  );
}

function DeviceVoiceModelsSheet() {
  const { voice } = useDeviceVoiceModels();
  return <VoiceModelsSheet voice={voice} />;
}

function EnvironmentVoiceModelsSheet({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    gt("This environment");
  const voice = useVoiceModels(environmentId, label);
  const benchmarks = new Map(
    (
      AsyncResult.getOrElse(useAtomValue(voiceSpeechBenchmarksAtom(environmentId)), () => null)
        ?.models ?? []
    ).map((model) => [model.id, model.benchmark]),
  );
  const models = voice.models.map((model) => {
    const benchmark = benchmarks.get(model.id);
    return benchmark ? { ...model, benchmark } : model;
  });
  return <VoiceModelsSheet voice={{ ...voice, models }} label={label} />;
}

function VoiceModelsSheet({
  voice,
  label,
}: {
  readonly voice: VoiceModelList;
  readonly label?: string;
}) {
  const gt = useGT();
  const language = new Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0]!.toLowerCase();
  const [query, setQuery] = useState("");
  const openSwipeable = useRef<SwipeableMethods>(null);
  const closeSwipeable = () => {
    openSwipeable.current?.close();
    openSwipeable.current = null;
  };
  const needle = query.trim().toLowerCase();
  const models = voice.models.filter((model) =>
    `${model.name} ${model.description} ${model.languages.join(" ")}`
      .toLowerCase()
      .includes(needle),
  );
  return (
    <PullRequestSearchSheet
      title={gt("Transcription models")}
      placeholder={gt("Search models or languages")}
      closeAccessibilityLabel={gt("Close transcription models")}
      clearAccessibilityLabel={gt("Clear model search")}
      query={query}
      onQueryChange={(value) => {
        closeSwipeable();
        setQuery(value);
      }}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={models}
          keyExtractor={(model) => model.id}
          extraData={{ voice, language, count: models.length }}
          estimatedItemSize={72}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={closeSwipeable}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            voice.canManage && models.some((model) => model.state === "installed") ? (
              <Text className="pb-3 text-xs text-foreground-muted">
                <T>Swipe left on an installed model to remove it.</T>
              </Text>
            ) : label !== undefined && !voice.canManage ? (
              <Text className="pb-3 text-xs text-foreground-muted">
                <T>
                  This connection can’t change settings on <Var>{label}</Var>.
                </T>
              </Text>
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <View
              className={cn(
                "overflow-hidden",
                index === 0 && "rounded-t-2xl",
                index === models.length - 1 && "rounded-b-2xl",
              )}
            >
              <VoiceModelRow
                model={item}
                voice={voice}
                separated={index > 0}
                language={language}
                onSwipeableOpen={(methods) => {
                  if (openSwipeable.current === methods) return;
                  closeSwipeable();
                  openSwipeable.current = methods;
                }}
                onSwipeableClose={(methods) => {
                  if (openSwipeable.current === methods) openSwipeable.current = null;
                }}
              />
            </View>
          )}
          ListEmptyComponent={
            voice.loading ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <EmptyState
                title={needle ? gt("No models match") : gt("No transcription models")}
                detail={
                  needle
                    ? gt("Try another name or language.")
                    : label === undefined
                      ? gt("Transcription unavailable")
                      : gt("{environment} has no models to list.", { environment: label })
                }
                variant="plain"
              />
            )
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
