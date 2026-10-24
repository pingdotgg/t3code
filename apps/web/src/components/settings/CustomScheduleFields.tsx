import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
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

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="custom-schedule-expression">Cron or RRULE expression</Label>
        <Textarea
          id="custom-schedule-expression"
          value={props.value.expression}
          disabled={props.disabled}
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby="custom-schedule-help"
          onChange={(event) => update({ expression: event.target.value })}
          placeholder={"0 9 1 * *\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0"}
        />
        <p id="custom-schedule-help" className="text-xs wrap-anywhere text-muted-foreground">
          A five-field cron expression or an RRULE, optionally after one DTSTART line.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="custom-schedule-zone">Time zone</Label>
        <Input
          id="custom-schedule-zone"
          value={props.value.timeZone}
          disabled={props.disabled}
          placeholder="Environment time zone"
          onChange={(event) => update({ timeZone: event.target.value })}
        />
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled || !canPreview || busy || !props.value.expression.trim()}
          onClick={() => void check()}
        >
          {busy ? "Checking…" : "Preview occurrences"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p>
            Detected {result.schedule.format === "rrule" ? "RRULE" : "cron"} ·{" "}
            {result.schedule.timeZone}
          </p>
          {result.completed ? (
            <p>Completed. No upcoming occurrences.</p>
          ) : (
            <>
              <p>Upcoming occurrences</p>
              <ol className="list-inside list-decimal">
                {result.occurrences.map((at) => (
                  <li key={at}>
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
                  </li>
                ))}
              </ol>
              {result.occurrences.length < 5 ? (
                <p>Completed after the final occurrence shown.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
