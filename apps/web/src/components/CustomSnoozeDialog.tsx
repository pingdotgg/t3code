import { useEffect, useId, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";
import { SNOOZE_REMINDER_MAX_CHARS } from "@lathe/contracts";
import {
  localSnoozeDate,
  localSnoozeTime,
  type CustomSnoozeInput,
} from "@lathe/client-runtime/state/thread-settled";
import {
  resolveDialogReminder,
  resolveDialogSnoozedUntil,
  type CustomSnoozeOptions,
  type SnoozeChoice,
} from "./CustomSnoozeDialog.logic";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { CalendarIcon, Settings2Icon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { weekStartsOn } from "../timestampFormat";
import { useNowMinute } from "../hooks/useNowMinute";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldDecrement,
  NumberFieldIncrement,
} from "./ui/number-field";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

type Request = {
  readonly id: number;
  readonly options: CustomSnoozeOptions;
  readonly resolve: (choice: SnoozeChoice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let nextRequestId = 0;

export function requestCustomSnooze(
  options: CustomSnoozeOptions = {},
): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { id: nextRequestId++, options, resolve } }),
  );
}

function finish(choice: SnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

function startOfLocalDay(ms: number) {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- resolves any pending snooze request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  // Keyed per request so a replacing request starts from its own options.
  return request ? <CustomSnoozeDialog key={request.id} options={request.options} /> : null;
}

function CustomSnoozeDialog({ options }: { options: CustomSnoozeOptions }) {
  const gt = useGT();
  const id = useId();
  const navigate = useNavigate();
  const initialSnoozedUntil = options.snoozedUntil ?? null;
  const initialReminder = options.reminder?.initial ?? null;
  const [initial] = useState(() =>
    initialSnoozedUntil ? new Date(initialSnoozedUntil) : new Date(Date.now() + 3_600_000),
  );
  const nowMinute = useNowMinute();
  // Follows the clock so a dialog left open past midnight stops offering yesterday.
  const today = startOfLocalDay(Date.parse(`${nowMinute}Z`));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [reminder, setReminder] = useState(initialReminder ?? "");
  const [error, setError] = useState<string | null>(null);
  const reminderRef = useRef<HTMLTextAreaElement>(null);
  const input: CustomSnoozeInput =
    mode === "date" ? { mode, date: localSnoozeDate(date), time } : { mode, amount, unit };
  const scheduleChanged = () => {
    setScheduleTouched(true);
    setError(null);
  };
  const editing = initialSnoozedUntil !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup
        className="sm:max-w-md"
        {...(options.reminder?.focus ? { initialFocus: reminderRef } : {})}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveDialogSnoozedUntil({
              schedule: input,
              initialSnoozedUntil,
              scheduleTouched,
              now: new Date(),
            });
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? gt("Choose a valid date and time in the future.")
                  : gt("Enter a positive duration."),
              );
              return;
            }
            const note = options.reminder
              ? resolveDialogReminder(reminder, initialReminder)
              : undefined;
            finish(note === undefined ? { snoozedUntil } : { snoozedUntil, reminder: note });
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? gt("Edit snooze") : gt("Custom snooze")}</DialogTitle>
            <DialogDescription>
              {options.reminder
                ? gt(
                    "Choose when this thread returns. An optional reminder appears in the chat when it wakes.",
                  )
                : gt("Choose when snoozed threads return to your inbox.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label={gt("Schedule type")}
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  scheduleChanged();
                }}
              >
                <Toggle value="date">
                  <T>Date and time</T>
                </Toggle>
                <Toggle value="duration">
                  <T>Duration</T>
                </Toggle>
              </ToggleGroup>
              <div className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                      <Label htmlFor={`${id}-date`}>
                        <T context="calendar date">Date</T>
                      </Label>
                      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger
                          render={
                            <Button
                              id={`${id}-date`}
                              variant="outline"
                              className="w-full justify-between"
                            />
                          }
                        >
                          {date.toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          <CalendarIcon className="size-4 text-muted-foreground" />
                        </PopoverTrigger>
                        <PopoverPopup align="start" aria-label={gt("Choose snooze date")}>
                          <Calendar
                            mode="single"
                            required
                            selected={date}
                            defaultMonth={date}
                            {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
                            disabled={{ before: today }}
                            onSelect={(selected) => {
                              setDate(selected);
                              setCalendarOpen(false);
                              scheduleChanged();
                            }}
                          />
                        </PopoverPopup>
                      </Popover>
                    </div>
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-time`}>
                      <T context="time of day">Time</T>
                      <Input
                        nativeInput
                        id={`${id}-time`}
                        className="h-9 sm:h-8"
                        type="time"
                        required
                        value={time}
                        onChange={(event) => {
                          setTime(event.target.value);
                          scheduleChanged();
                        }}
                      />
                    </Label>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberField
                      id={`${id}-amount`}
                      min={0}
                      step="any"
                      value={amount === "" ? null : Number(amount)}
                      onValueChange={(value) => {
                        setAmount(value === null ? "" : String(value));
                        scheduleChanged();
                      }}
                    >
                      <Label htmlFor={`${id}-amount`}>
                        <T>Snooze for</T>
                      </Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label={gt("Decrease duration")} />
                        <NumberFieldInput required />
                        <NumberFieldIncrement aria-label={gt("Increase duration")} />
                      </NumberFieldGroup>
                    </NumberField>
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-unit`}>
                      <T context="unit of time">Unit</T>
                      <Select
                        value={unit}
                        items={{ minutes: gt("Minutes"), hours: gt("Hours"), days: gt("Days") }}
                        onValueChange={(value) => {
                          if (value === "minutes" || value === "hours" || value === "days")
                            setUnit(value);
                          scheduleChanged();
                        }}
                      >
                        <SelectTrigger id={`${id}-unit`} className="min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="minutes">
                            <T>Minutes</T>
                          </SelectItem>
                          <SelectItem value="hours">
                            <T>Hours</T>
                          </SelectItem>
                          <SelectItem value="days">
                            <T>Days</T>
                          </SelectItem>
                        </SelectPopup>
                      </Select>
                    </Label>
                  </div>
                )}
              </div>
              {options.reminder ? (
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-reminder`}>
                  <T>Reminder</T>
                  <Textarea
                    ref={reminderRef}
                    id={`${id}-reminder`}
                    value={reminder}
                    maxLength={SNOOZE_REMINDER_MAX_CHARS}
                    placeholder={gt("Optional. Shown in the chat when the thread wakes.")}
                    onChange={(event) => setReminder(event.target.value)}
                  />
                </Label>
              ) : null}
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost-muted"
              className="sm:mr-auto"
              onClick={() => {
                finish(null);
                void navigate({
                  to: "/settings/threads",
                  hash: "snooze-options",
                });
              }}
            >
              <Settings2Icon />
              <T>Edit snooze options</T>
            </Button>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit">
              {editing ? gt("Save") : gt("Snooze", { $context: "verb" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
