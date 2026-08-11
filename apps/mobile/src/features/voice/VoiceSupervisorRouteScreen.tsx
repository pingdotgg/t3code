import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { REALTIME_VOICES } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { StatusPill } from "../../components/StatusPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentPresentation } from "../../state/presentation";
import { usePreparedConnection } from "../../state/session";
import type { VoiceSupervisorConfirmation } from "../../voice/voiceSupervisorHost";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useMobileVoiceSupervisorRuntime } from "./VoiceSupervisorRoot";
import {
  classifyMobileVoiceEnvironmentAvailability,
  mobileVoiceConfirmationAccessibilityLabel,
  selectMobileVoiceHistory,
  visibleMobileVoiceError,
  voiceConfirmationPreviewRows,
  voiceLabel,
  type MobileVoiceHistoryItem,
} from "./voiceSupervisorPresentation";

function VoiceConfirmationCard(props: {
  readonly confirmation: VoiceSupervisorConfirmation;
  readonly focusConfirm: boolean;
  readonly onConfirm: () => void;
  readonly onDeny: () => void;
}) {
  const announcementRef = useRef<View | null>(null);
  const previewRows = voiceConfirmationPreviewRows(props.confirmation);

  useEffect(() => {
    if (!props.focusConfirm) return;
    const node = findNodeHandle(announcementRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  }, [props.confirmation.callId, props.confirmation.generation, props.focusConfirm]);

  return (
    <View className="gap-3 rounded-[22px] border border-amber-500/40 bg-card p-4">
      <View
        ref={announcementRef}
        accessible
        accessibilityLabel={mobileVoiceConfirmationAccessibilityLabel(props.confirmation)}
        accessibilityRole="header"
        className="gap-1"
      >
        <Text className="text-xs font-t3-bold tracking-wide text-amber-700 uppercase dark:text-amber-300">
          Confirmation required
        </Text>
        <Text className="text-base font-t3-bold text-foreground" selectable>
          {props.confirmation.summary}
        </Text>
      </View>
      <View className="gap-2">
        {previewRows.map((row) => (
          <View key={row.label} className="gap-0.5">
            <Text className="text-2xs font-t3-bold tracking-wide text-foreground-muted uppercase">
              {row.label}
            </Text>
            <Text className="text-sm text-foreground" selectable>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityLabel={`Deny ${props.confirmation.action}`}
          accessibilityRole="button"
          onPress={props.onDeny}
          className="h-11 items-center justify-center rounded-full bg-subtle px-5"
        >
          <Text className="text-sm font-t3-bold text-foreground">Deny</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={`Confirm ${props.confirmation.action}`}
          accessibilityRole="button"
          onPress={props.onConfirm}
          className="h-11 items-center justify-center rounded-full bg-primary px-5"
        >
          <Text className="text-sm font-t3-bold text-primary-foreground">Confirm</Text>
        </Pressable>
      </View>
    </View>
  );
}

function VoiceHistoryRow({ item }: LegendListRenderItemProps<MobileVoiceHistoryItem>) {
  if (item.kind === "activity") {
    return (
      <View className="flex-row items-start gap-2 px-1 py-2">
        <View className="mt-1.5 size-1.5 rounded-full bg-foreground-muted" />
        <Text className="flex-1 text-xs text-foreground-muted" selectable>
          {item.entry.label}
        </Text>
      </View>
    );
  }
  return (
    <View className="mb-2 gap-1 rounded-[18px] bg-card px-4 py-3">
      <Text className="text-2xs font-t3-bold tracking-wide text-foreground-muted uppercase">
        {item.entry.speaker === "user" ? "You" : "Supervisor"}
        {item.entry.status === "streaming" ? " · speaking" : ""}
      </Text>
      <Text className="text-sm leading-5 text-foreground" selectable>
        {item.entry.text}
      </Text>
    </View>
  );
}

export function VoiceSupervisorRouteScreen() {
  const runtime = useMobileVoiceSupervisorRuntime();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const data = useAtomValue(runtime.dataAtom);
  const selection = useAtomValue(runtime.selectionAtom);
  const confirmations = useAtomValue(runtime.confirmationsAtom);
  const { environments, isReady: catalogReady } = useEnvironments();
  const selectedEnvironment =
    environments.find(
      (environment) => environment.environmentId === selection.selectedEnvironmentId,
    ) ?? null;
  const selectedPresentation = useEnvironmentPresentation(selection.selectedEnvironmentId);
  const selectedPrepared = usePreparedConnection(selection.selectedEnvironmentId);
  const active = data.phase === "connecting" || data.phase === "connected";
  const availability = classifyMobileVoiceEnvironmentAvailability({
    catalogReady: catalogReady && selectedPresentation.isReady,
    connectionPhase: selectedPresentation.presentation?.connection.phase ?? null,
    hasServerConfig: selectedPresentation.presentation?.serverConfig !== null,
    supportsRealtimeVoice:
      selectedPresentation.presentation?.serverConfig?.environment.capabilities.realtimeVoice ===
      true,
    hasPreparedConnection:
      Option.isSome(selectedPrepared) &&
      selectedPrepared.value.environmentId === selection.selectedEnvironmentId,
  });
  const history = useMemo(
    () => selectMobileVoiceHistory(data),
    [data.activity, data.generation, data.transcript],
  );
  const lastTranscriptAnnouncementRef = useRef<string | null>(null);
  const completedAnnouncementKey = history.completedAnnouncement?.key ?? null;
  const completedAnnouncementText = history.completedAnnouncement?.text ?? null;

  useEffect(() => {
    if (!isFocused || completedAnnouncementKey === null || completedAnnouncementText === null) {
      return;
    }
    if (lastTranscriptAnnouncementRef.current === completedAnnouncementKey) return;
    lastTranscriptAnnouncementRef.current = completedAnnouncementKey;
    AccessibilityInfo.announceForAccessibility(completedAnnouncementText);
  }, [completedAnnouncementKey, completedAnnouncementText, isFocused]);

  const environmentActions = environments.map((environment) => ({
    id: `environment:${environment.environmentId}`,
    title: environment.label,
    state:
      environment.environmentId === selection.selectedEnvironmentId
        ? ("on" as const)
        : ("off" as const),
  }));
  const voiceActions = REALTIME_VOICES.map((voice) => ({
    id: `voice:${voice}`,
    title: voiceLabel(voice),
    state: voice === selection.selectedVoice ? ("on" as const) : ("off" as const),
  }));
  const visibleError = visibleMobileVoiceError(selection.startError, data.errorMessage);
  const status =
    data.phase === "connecting"
      ? {
          label: "Connecting",
          pillClassName: "bg-sky-500/15",
          textClassName: "text-sky-700 dark:text-sky-300",
        }
      : data.phase === "connected"
        ? data.muted
          ? {
              label: "Muted",
              pillClassName: "bg-amber-500/15",
              textClassName: "text-amber-700 dark:text-amber-300",
            }
          : {
              label: "Listening",
              pillClassName: "bg-emerald-500/15",
              textClassName: "text-emerald-700 dark:text-emerald-300",
            }
        : data.phase === "failed"
          ? {
              label: "Failed",
              pillClassName: "bg-danger",
              textClassName: "text-danger-foreground",
            }
          : { label: "Idle", pillClassName: "bg-subtle", textClassName: "text-foreground-muted" };

  const header = (
    <View className="gap-5 pb-5">
      <View className="gap-3 rounded-[24px] bg-card p-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-lg font-t3-bold text-foreground">Voice Supervisor</Text>
            <Text className="text-sm text-foreground-muted">
              Talk through your work and open or update threads with local confirmation.
            </Text>
          </View>
          <StatusPill {...status} size="compact" />
        </View>

        <View className="flex-row flex-wrap gap-2">
          {active ? (
            <ControlPill
              accessibilityLabel="Voice host environment"
              disabled
              icon="desktopcomputer"
              label={selectedEnvironment?.label ?? "Environment"}
              variant="pill"
            />
          ) : (
            <ControlPillMenu
              actions={environmentActions}
              onPressAction={({ nativeEvent }) => {
                const environment = environments.find(
                  (candidate) => nativeEvent.event === `environment:${candidate.environmentId}`,
                );
                if (environment !== undefined) {
                  runtime.selectEnvironment(environment.environmentId);
                }
              }}
            >
              <ControlPill
                accessibilityLabel="Voice host environment"
                icon="desktopcomputer"
                label={selectedEnvironment?.label ?? "Environment"}
                variant="pill"
              />
            </ControlPillMenu>
          )}
          {active ? (
            <ControlPill
              accessibilityLabel="Realtime voice"
              disabled
              icon="text.bubble"
              label={voiceLabel(selection.selectedVoice)}
              variant="pill"
            />
          ) : (
            <ControlPillMenu
              actions={voiceActions}
              onPressAction={({ nativeEvent }) => {
                const voice = REALTIME_VOICES.find(
                  (candidate) => nativeEvent.event === `voice:${candidate}`,
                );
                if (voice !== undefined) runtime.selectVoice(voice);
              }}
            >
              <ControlPill
                accessibilityLabel="Realtime voice"
                icon="text.bubble"
                label={voiceLabel(selection.selectedVoice)}
                variant="pill"
              />
            </ControlPillMenu>
          )}
        </View>

        <Text
          className={
            availability.kind === "ready"
              ? "text-xs text-foreground-muted"
              : "text-xs text-amber-700 dark:text-amber-300"
          }
        >
          {availability.message}
        </Text>

        {visibleError ? (
          <View className="rounded-[16px] border border-danger-border bg-danger px-3 py-2.5">
            <Text className="text-sm font-t3-medium text-danger-foreground" selectable>
              {visibleError}
            </Text>
          </View>
        ) : null}

        <Text className="text-xs text-foreground-muted">
          OpenAI keys are managed from T3 Code on web or desktop, or with OPENAI_API_KEY on the host
          environment.
        </Text>

        <View className="flex-row flex-wrap gap-2">
          {!active ? (
            <ControlPill
              accessibilityLabel="Start Voice Supervisor"
              disabled={availability.kind !== "ready"}
              icon="mic"
              label="Start"
              onPress={() => runtime.start()}
              variant="primary"
            />
          ) : (
            <>
              <ControlPill
                accessibilityLabel={data.muted ? "Unmute microphone" : "Mute microphone"}
                disabled={data.phase !== "connected"}
                icon={data.muted ? "mic" : "mic.slash"}
                label={data.muted ? "Unmute" : "Mute"}
                onPress={() => runtime.setMuted(!data.muted)}
                variant="pill"
              />
              <ControlPill
                accessibilityLabel="Stop Voice Supervisor"
                icon="stop.fill"
                label="Stop"
                onPress={runtime.stop}
                variant="danger"
              />
            </>
          )}
          {data.phase === "failed" ? (
            <ControlPill
              accessibilityLabel="Dismiss failed voice session"
              icon="xmark"
              label="Dismiss"
              onPress={runtime.stop}
              variant="pill"
            />
          ) : null}
        </View>
      </View>

      {confirmations.length > 0 ? (
        <View className="gap-3">
          <Text className="px-1 text-xs font-t3-bold tracking-wide text-foreground-muted uppercase">
            Pending confirmations
          </Text>
          {confirmations.map((confirmation, index) => (
            <VoiceConfirmationCard
              key={`${confirmation.generation}:${confirmation.callId}`}
              confirmation={confirmation}
              focusConfirm={isFocused && index === 0}
              onConfirm={() => runtime.confirm(confirmation.generation, confirmation.callId)}
              onDeny={() => runtime.deny(confirmation.generation, confirmation.callId)}
            />
          ))}
        </View>
      ) : null}

      {history.items.length > 0 ? (
        <Text className="px-1 text-xs font-t3-bold tracking-wide text-foreground-muted uppercase">
          Conversation and activity
        </Text>
      ) : null}
    </View>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice Supervisor" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <WorkspaceSidebarToolbar />
      <LegendList
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        contentInsetAdjustmentBehavior="automatic"
        data={history.items}
        estimatedItemSize={72}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        ListEmptyComponent={
          <Text className="py-12 text-center text-sm text-foreground-muted">
            Start a session when you are ready. Opening this screen never turns on the microphone.
          </Text>
        }
        ListHeaderComponent={header}
        renderItem={VoiceHistoryRow}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
