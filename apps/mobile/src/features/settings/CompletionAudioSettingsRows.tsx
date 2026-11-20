import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { NumberField } from "../../components/ui/NumberField";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { COMPLETION_AUDIO_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function CompletionAudioSettingsRows() {
  const gt = useGT();
  const m = useMessages();
  const { selectedTargets, selectedIds, selectedProjectKey } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  const targets = selectedTargets.filter(
    (environment) =>
      environment.serverConfig.environment.capabilities.completionNotifications === true,
  );
  const scopedTargets = resolveMobileSettingsTargets(targets, null);
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const operable = useEnvironmentsWithScope(targets, AuthOrchestrationOperateScope);
  const writeSettings = useSettingsWriter();
  const bulkOff = useAtomCommand(serverEnvironment.bulkOffCompletionAudio, {
    label: "turn off existing completion audio",
    reportFailure: false,
  });
  const [writing, setWriting] = useState(false);
  const [runningBulk, setRunningBulk] = useState(false);
  const writeInFlight = useRef(false);
  const bulkInFlight = useRef(false);
  const common = uniformMobileSetting(scopedTargets, "completionAudio");
  const audio = common ?? scopedTargets[0]?.settings.completionAudio;
  if (!audio || targets.length === 0) return null;
  const defaultMode =
    common?.defaultMode ??
    (scopedTargets.every(
      (target) => target.settings.completionAudio.defaultMode === audio.defaultMode,
    )
      ? audio.defaultMode
      : null);
  const tone =
    common?.tone ??
    (scopedTargets.every((target) => target.settings.completionAudio.tone === audio.tone)
      ? audio.tone
      : null);
  const volume =
    common?.volume ??
    (scopedTargets.every((target) => target.settings.completionAudio.volume === audio.volume)
      ? audio.volume
      : null);
  const projectSelected = selectedProjectKey !== null;
  const canWrite =
    !projectSelected && targets.every((environment) => writable.has(environment.environmentId));
  const disabled = !canWrite || writing;
  const selected = environments.filter(
    (environment) => selectedIds === null || selectedIds.has(environment.environmentId),
  );
  const skipped = selected.filter(
    (environment) => !targets.some((target) => target.environmentId === environment.environmentId),
  );
  const patch = (completionAudio: NonNullable<ServerSettingsPatch["completionAudio"]>) => {
    if (
      writeInFlight.current ||
      !canWrite ||
      !targets.every((environment) =>
        readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    writeInFlight.current = true;
    setWriting(true);
    const writes = planMobileScopedSettingsPatch(scopedTargets, false, { completionAudio });
    void writeSettings(scopedTargets, writes).then(
      () => {
        writeInFlight.current = false;
        setWriting(false);
      },
      () => {
        writeInFlight.current = false;
        setWriting(false);
      },
    );
  };
  return (
    <SettingsSection title={gt("Completion audio")}>
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        {gt("Default for future top-level threads. Subagents and forks start Off.")}{" "}
        <T>
          Sound plays on web and desktop. Voice uses provider-owned hooks and may not stop speech
          already started.
        </T>
        {projectSelected ? ` ${gt("Choose an environment scope to edit these settings.")}` : ""}
        {!canWrite && !projectSelected
          ? ` ${gt("Settings-write permission is required on every selected capable environment.")}`
          : ""}
      </Text>
      {skipped.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          {gt("Not changed: {environments} (offline or unsupported).", {
            environments: skipped.map((environment) => environment.label).join(", "),
          })}
        </Text>
      ) : null}
      {COMPLETION_AUDIO_CHOICES.map((choice, index) => (
        <ListChoiceRow
          key={choice.mode}
          label={gt("New threads: {mode}", { mode: m(choice.label) })}
          selected={defaultMode === choice.mode}
          disabled={disabled}
          separated={index > 0}
          onPress={() => patch({ defaultMode: choice.mode })}
        />
      ))}
      {defaultMode !== "off" ? (
        <ListActionRow
          label={gt("Reset new threads to Off")}
          disabled={disabled}
          onPress={() => patch({ defaultMode: "off" })}
        />
      ) : null}
      <ListChoiceRow
        label={gt("Sound: Chime")}
        selected={tone === "completion"}
        disabled={disabled}
        onPress={() => patch({ tone: "completion" })}
      />
      <ListChoiceRow
        label={gt("Sound: Alert")}
        selected={tone === "input"}
        disabled={disabled}
        separated
        onPress={() => patch({ tone: "input" })}
      />
      <View className="flex-row items-center justify-between gap-4 px-4 py-4 android:min-h-14 android:py-3">
        <Text className="flex-1 text-lg text-foreground android:text-base">
          {volume === null ? gt("Volume (mixed)") : gt("Volume")}
        </Text>
        <NumberField
          label={gt("Completion sound volume")}
          min={0}
          max={100}
          value={Math.round((volume ?? audio.volume) * 100)}
          formatValue={(value) => `${value}%`}
          disabled={disabled}
          onValueChange={(value) => patch({ volume: value / 100 })}
        />
      </View>
      <ListActionRow
        label={gt("Turn off existing thread audio")}
        description={
          operable.size === 0
            ? gt(
                "This connection cannot operate threads on selected environments. The future default is separate.",
              )
            : gt("Includes archived threads and subagents. Does not change the future default.")
        }
        loading={runningBulk}
        disabled={projectSelected || operable.size === 0}
        onPress={async () => {
          if (bulkInFlight.current || projectSelected) return;
          bulkInFlight.current = true;
          setRunningBulk(true);
          const lines: string[] = [];
          for (const environment of selected) {
            if (!targets.some((target) => target.environmentId === environment.environmentId)) {
              lines.push(
                gt("{environment}: not changed (offline or unsupported).", {
                  environment: environment.label,
                }),
              );
              continue;
            }
            if (
              !appAtomRegistry.get(
                serverEnvironment.bulkOffCompletionAudio.permissionAtom(environment.environmentId),
              )
            ) {
              lines.push(
                gt("{environment}: not changed (permission denied).", {
                  environment: environment.label,
                }),
              );
              continue;
            }
            const result = await bulkOff({
              environmentId: environment.environmentId,
              input: { clientRequestId: uuidv4() },
            });
            if (result._tag !== "Success") {
              lines.push(
                gt(
                  "{environment}: could not turn off existing thread audio. Check the connection and permissions.",
                  {
                    environment: environment.label,
                  },
                ),
              );
              continue;
            }
            const report = result.value;
            const superseded = report.failed.filter(
              (failure) => failure.reason === "superseded",
            ).length;
            const counts = {
              environment: environment.label,
              turnedOff: report.turnedOff,
              alreadyOff: report.alreadyOff,
            };
            lines.push(
              [
                report.failedCount > 0
                  ? gt(
                      "{environment}: {turnedOff} turned off, {alreadyOff} already off, {failedCount} failed or changed after the request.",
                      {
                        ...counts,
                        failedCount: report.failedCount,
                      },
                    )
                  : gt("{environment}: {turnedOff} turned off, {alreadyOff} already off.", counts),
                !report.complete ? gt("Incomplete.") : null,
                superseded
                  ? gt("{count} reported later choices were preserved.", { count: superseded })
                  : null,
                report.failuresTruncated
                  ? gt("Failure details were limited to {shown} of {total} targets.", {
                      shown: report.failed.length,
                      total: report.failedCount,
                    })
                  : null,
              ]
                .filter((line) => line !== null)
                .join(" "),
            );
          }
          bulkInFlight.current = false;
          setRunningBulk(false);
          Dialog.alert(
            gt("Existing thread completion audio"),
            lines.join("\n\n") || gt("No selected environments were changed."),
          );
        }}
      />
    </SettingsSection>
  );
}
