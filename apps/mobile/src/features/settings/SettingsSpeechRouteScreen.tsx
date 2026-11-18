import { speechPlaybackSelection } from "@t3tools/client-runtime/voice-output";
import { useRef, useState } from "react";
import { useGT } from "gt-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AuthSettingsWriteScope,
  type SpeechOutputDestination,
  type SpeechPlaybackRate,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  SpeechPlaybackSettingsContext,
  useSpeechOutputDestination,
} from "../voice-output/useSpeechOutputDestination";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import {
  resolveMobileSettingsTargets,
  planMobileScopedSettingsPatch,
  planMobileScopedSettingsClear,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";
import { useEnvironmentsWithScope } from "../../state/session";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { SpeechOutputSettings } from "./SpeechOutputSettings";

export function SettingsSpeechRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const fallback = useSpeechOutputDestination();
  const { selectedTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const menu = useSettingsEnvironmentMenu();
  const members = selectedProjectKey
    ? (projectGroups
        .find((group) => group.key === selectedProjectKey)
        ?.members.map((member) => member.project) ?? [])
    : null;
  const targets = resolveMobileSettingsTargets(selectedTargets, members);
  const reference = targets[0]?.settings;
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const canWrite =
    targets.length > 0 && targets.every((target) => writable.has(target.environment.environmentId));
  const write = useSettingsWriter();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const queued = useRef<{ key: string; patch: ServerSettingsPatch } | null>(null);
  const targetsKey = targets
    .map((target) => `${target.environment.environmentId}:${target.projectId}`)
    .join(",");
  const canManage = canWrite && !pending;
  const destination =
    reference?.speechPlaybackDestination === undefined
      ? fallback.destination
      : reference.speechPlaybackDestination;
  const update = (patch: Parameters<typeof planMobileScopedSettingsPatch>[2]) => {
    if (inFlight.current) {
      queued.current = {
        key: targetsKey,
        patch: queued.current?.key === targetsKey ? { ...queued.current.patch, ...patch } : patch,
      };
      return;
    }
    if (!canWrite) return;
    inFlight.current = true;
    setPending(true);
    void write(targets, planMobileScopedSettingsPatch(targets, members !== null, patch)).finally(
      () => {
        inFlight.current = false;
        setPending(false);
        const next = queued.current;
        queued.current = null;
        // Whole-entry project writes must retain fields whose successful response has not arrived yet.
        if (next?.key === targetsKey) update({ ...patch, ...next.patch });
      },
    );
  };
  const controls = {
    ...speechPlaybackSelection(
      targets.map((target) => ({
        destination:
          target.settings.speechPlaybackDestination === undefined
            ? fallback.destination
            : target.settings.speechPlaybackDestination,
        playbackRate: target.settings.speechPlaybackRate ?? fallback.playbackRate,
      })),
    ),
    destination,
    playbackRate: reference?.speechPlaybackRate ?? fallback.playbackRate,
    canManage,
    choose: (destination: SpeechOutputDestination | null) => {
      update({
        speechPlaybackDestination: destination
          ? { ...destination, voice: destination.voice ?? null }
          : null,
      });
    },
    setPlaybackRate: (rate: SpeechPlaybackRate) => {
      update({ speechPlaybackRate: rate });
    },
    selectVoice: (voice: string | null) => {
      if (destination) update({ speechPlaybackDestination: { ...destination, voice } });
    },
  };
  const { environments } = useEnvironments();
  return (
    <SettingsScreen title={gt("Speech")} menus={[menu]}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SpeechPlaybackSettingsContext value={controls}>
          <SpeechOutputSettings key={targetsKey} environments={environments} />
          {members !== null &&
          targets.some(
            (target) =>
              target.sources.speechPlaybackDestination === "project" ||
              target.sources.speechPlaybackRate === "project",
          ) ? (
            <ListActionRow
              label={gt("Use environment defaults")}
              disabled={!canManage}
              onPress={() => {
                if (inFlight.current || !canWrite) return;
                inFlight.current = true;
                setPending(true);
                void write(
                  targets,
                  planMobileScopedSettingsClear(targets, [
                    "speechPlaybackDestination",
                    "speechPlaybackRate",
                  ]),
                ).finally(() => {
                  inFlight.current = false;
                  queued.current = null;
                  setPending(false);
                });
              }}
            />
          ) : null}
        </SpeechPlaybackSettingsContext>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
