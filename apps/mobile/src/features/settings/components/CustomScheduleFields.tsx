import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ScheduledTaskId,
  ScheduledTaskPreviewResult,
} from "@t3tools/contracts";
import {
  customScheduleFromDraft,
  type CustomScheduleDraft,
} from "@t3tools/client-runtime/scheduled-task-custom";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

export function CustomScheduleFields(props: {
  environmentId: EnvironmentId;
  taskId?: ScheduledTaskId | undefined;
  value: CustomScheduleDraft;
  disabled: boolean;
  onChange: (value: CustomScheduleDraft) => void;
}) {
  const preview = useAtomCommand(serverEnvironment.previewScheduledTask, { reportFailure: false });
  const canPreview = useAtomValue(
    serverEnvironment.previewScheduledTask.permissionAtom(props.environmentId),
  );
  const [result, setResult] = useState<ScheduledTaskPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Edits and unmount bump the version so a late preview cannot overwrite them.
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current += 1;
    },
    [],
  );
  const update = (values: Partial<CustomScheduleDraft>) => {
    version.current += 1;
    setResult(null);
    setError(null);
    props.onChange({ ...props.value, ...values });
  };
  const check = async () => {
    const requestVersion = ++version.current;
    setBusy(true);
    setError(null);
    const response = await preview({
      environmentId: props.environmentId,
      input: {
        ...(props.taskId ? { id: props.taskId } : {}),
        schedule: customScheduleFromDraft(props.value),
      },
    });
    setBusy(false);
    if (version.current !== requestVersion) return;
    if (response._tag === "Failure") {
      setResult(null);
      setError(String(squashAtomCommandFailure(response)));
      return;
    }
    setResult(response.value);
  };
  return (
    <View className="gap-3 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">Cron or RRULE expression</Text>
      <TextInput
        accessibilityLabel="Cron or RRULE expression"
        value={props.value.expression}
        onChangeText={(expression) => update({ expression })}
        readOnly={props.disabled}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0"
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-20 font-sans text-base text-foreground"
      />
      <Text className="text-sm text-foreground-muted">
        A five-field cron expression or an RRULE, optionally after one DTSTART line.
      </Text>
      <Text className="text-sm text-foreground-muted">Time zone</Text>
      <TextInput
        accessibilityLabel="Time zone"
        value={props.value.timeZone}
        onChangeText={(timeZone) => update({ timeZone })}
        readOnly={props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Environment time zone"
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-10 font-sans text-base text-foreground"
      />
      <Button
        label={busy ? "Checking…" : "Preview occurrences"}
        disabled={props.disabled || !canPreview || busy || !props.value.expression.trim()}
        onPress={() => void check()}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {result ? (
        <View accessibilityLiveRegion="polite" className="gap-2">
          <Text className="text-sm text-foreground">
            Detected {result.schedule.format === "rrule" ? "RRULE" : "cron"} ·{" "}
            {result.schedule.timeZone}
          </Text>
          {result.completed ? (
            <Text className="text-sm text-foreground">Completed. No upcoming occurrences.</Text>
          ) : (
            <>
              <Text className="text-sm text-foreground">Upcoming occurrences</Text>
              {result.occurrences.map((at) => (
                <Text key={at} className="text-sm text-foreground-muted">
                  {new Date(at).toLocaleString(undefined, {
                    timeZone: result.schedule.timeZone,
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    timeZoneName: "short",
                  })}
                </Text>
              ))}
              {result.occurrences.length < 5 ? (
                <Text className="text-sm text-foreground-muted">
                  Completed after the final occurrence shown.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
