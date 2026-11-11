import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { voiceSpeechBenchmarksAtom } from "../voice-input/voiceDestination";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";
import { useVoiceModels, VoiceModelRow } from "./VoiceModelSection";

export function SettingsVoiceModelsRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === route.params.environmentId)
      ?.label ?? "This environment";
  const voice = useVoiceModels(route.params.environmentId, label);
  const benchmarks = new Map(
    (
      AsyncResult.getOrElse(
        useAtomValue(voiceSpeechBenchmarksAtom(route.params.environmentId)),
        () => null,
      )?.models ?? []
    ).map((model) => [model.id, model.benchmark]),
  );
  const language = new Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0]!.toLowerCase();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Catalog order, not state order: re-sorting when a download finishes would move rows under a tap.
  const models = voice.models
    .map((model) => {
      const benchmark = benchmarks.get(model.id);
      return benchmark ? { ...model, benchmark } : model;
    })
    .filter((model) =>
      `${model.name} ${model.description} ${model.languages.join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  return (
    <PullRequestSearchSheet
      title="Transcription models"
      placeholder="Search models or languages"
      closeAccessibilityLabel="Close transcription models"
      clearAccessibilityLabel="Clear model search"
      query={query}
      onQueryChange={setQuery}
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
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            voice.canManage ? undefined : (
              <Text className="pb-3 text-xs text-foreground-muted">
                This connection can’t change settings on {label}.
              </Text>
            )
          }
          renderItem={({ item, index }) => (
            <View
              className={cn(
                "overflow-hidden",
                index === 0 && "rounded-t-2xl",
                index === models.length - 1 && "rounded-b-2xl",
              )}
            >
              <VoiceModelRow model={item} voice={voice} separated={index > 0} language={language} />
            </View>
          )}
          ListEmptyComponent={
            voice.loading ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <EmptyState
                title={needle ? "No models match" : "No transcription models"}
                detail={
                  needle ? "Try another name or language." : `${label} has no models to list.`
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
