import { useEffect, useId, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";
import { useNowMinute } from "../hooks/useNowMinute";
import type { MessageResolver } from "../i18n/messages";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
import { AlarmClockIcon, CalendarIcon, Settings2Icon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { weekStartsOn } from "../timestampFormat";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Input } from "./ui/input";
import { SubmitKbd } from "./SubmitKbd";
import { Label } from "./ui/label";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
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

type SnoozeChoice = { readonly snoozedUntil: string };
type Request = { readonly resolve: (choice: SnoozeChoice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCustomSnooze(): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending snooze request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

type DurationParts = { readonly days: number; readonly hours: number; readonly minutes: number };

const DURATION_FIELDS = [
  {
    key: "days",
    label: msg("Days"),
    decrementLabel: msg("Fewer days"),
    incrementLabel: msg("More days"),
  },
  {
    key: "hours",
    label: msg("Hours"),
    decrementLabel: msg("Fewer hours"),
    incrementLabel: msg("More hours"),
  },
  {
    key: "minutes",
    label: msg("Minutes"),
    decrementLabel: msg("Fewer minutes"),
    incrementLabel: msg("More minutes"),
  },
] as const;

function durationMinutes(parts: DurationParts): number {
  return parts.days * 24 * 60 + parts.hours * 60 + parts.minutes;
}

/** "Returns today at 6:12 PM", "… tomorrow at 9:00 AM", or "… on Mon, Sep 29 at 9:00 AM". */
function formatReturnTime(wake: Date, now: Date, resolve: MessageResolver): string {
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayOffset = Math.round(
    (new Date(wake).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (dayOffset === 0) return resolve(msg("Returns today at {time}", { time }));
  if (dayOffset === 1) return resolve(msg("Returns tomorrow at {time}", { time }));
  const day = wake.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(wake.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return resolve(msg("Returns on {day} at {time}", { day, time }));
}

/** The current time, refreshed each minute while mounted so a live label never goes stale. */
function useMinuteClock(): Date {
  const now = useNowMinute();
  return new Date(`${now}:00Z`);
}

function CustomSnoozeDialog() {
  const gt = useGT();
  const messages = useMessages();
  const id = useId();
  const navigate = useNavigate();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const nowMinute = useNowMinute();
  // Follows the clock so a dialog left open past midnight stops offering yesterday.
  const today = startOfLocalDay(Date.parse(`${nowMinute}Z`));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("duration");
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [duration, setDuration] = useState<DurationParts>({ days: 0, hours: 2, minutes: 0 });
  const [error, setError] = useState<string | null>(null);
  const now = useMinuteClock();
  const totalMinutes = durationMinutes(duration);
  const input: CustomSnoozeInput =
    mode === "date"
      ? { mode, date: localSnoozeDate(date), time }
      : { mode, amount: String(totalMinutes), unit: "minutes" };
  const wakeAt = mode === "duration" ? resolveCustomSnooze(input, now) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? gt("Choose a valid date and time in the future.")
                  : gt("Enter a positive duration."),
              );
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Custom snooze</T>
            </DialogTitle>
            <DialogDescription>
              <T>Choose when snoozed threads return to your inbox.</T>
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
                  setError(null);
                }}
              >
                <Toggle value="duration">
                  <T>Snooze for</T>
                </Toggle>
                <Toggle value="date">
                  <T>Date and time</T>
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
                              size="standard"
                              id={`${id}-date`}
                              variant="secondary"
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
                              setError(null);
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
                          setError(null);
                        }}
                      />
                    </Label>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <fieldset className="flex min-w-0 flex-col gap-1.5">
                      <legend className="mb-1.5 text-muted-foreground text-label">
                        <T>Duration</T>
                      </legend>
                      <div className="grid grid-cols-3 gap-2">
                        {DURATION_FIELDS.map((field) => (
                          <NumberField
                            size="sm"
                            key={field.key}
                            id={`${id}-${field.key}`}
                            min={0}
                            step={1}
                            value={duration[field.key]}
                            onValueChange={(value) => {
                              setDuration((current) => ({
                                ...current,
                                [field.key]: Math.max(0, Math.floor(value ?? 0)),
                              }));
                              setError(null);
                            }}
                          >
                            <NumberFieldGroup>
                              <NumberFieldDecrement aria-label={messages(field.decrementLabel)} />
                              <NumberFieldInput aria-label={messages(field.label)} />
                              <NumberFieldIncrement aria-label={messages(field.incrementLabel)} />
                            </NumberFieldGroup>
                            <label
                              htmlFor={`${id}-${field.key}`}
                              className="text-dim-foreground text-meta"
                            >
                              {messages(field.label)}
                            </label>
                          </NumberField>
                        ))}
                      </div>
                    </fieldset>
                    <p className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-body surface-selected-soft">
                      <AlarmClockIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      {wakeAt
                        ? formatReturnTime(new Date(wakeAt), now, messages)
                        : gt("Set a duration longer than zero.")}
                    </p>
                  </div>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              size="standard"
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
            <Button size="standard" type="button" variant="secondary" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button size="standard" type="submit">
              <T context="verb">Snooze</T>
              <SubmitKbd />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
