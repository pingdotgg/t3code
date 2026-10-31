import { useEffect, useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";
import { useNowMinute } from "../hooks/useNowMinute";
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
  { key: "days", label: "Days" },
  { key: "hours", label: "Hours" },
  { key: "minutes", label: "Minutes" },
] as const;

function durationMinutes(parts: DurationParts): number {
  return parts.days * 24 * 60 + parts.hours * 60 + parts.minutes;
}

/** "today at 6:12 PM", "tomorrow at 9:00 AM", or "on Mon, Sep 29 at 9:00 AM". */
function formatReturnTime(wake: Date, now: Date): string {
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayOffset = Math.round(
    (new Date(wake).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (dayOffset === 0) return `today at ${time}`;
  if (dayOffset === 1) return `tomorrow at ${time}`;
  const day = wake.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(wake.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `on ${day} at ${time}`;
}

/** The current time, refreshed each minute while mounted so a live label never goes stale. */
function useMinuteClock(): Date {
  const now = useNowMinute();
  return new Date(`${now}:00Z`);
}

function CustomSnoozeDialog() {
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
      <DialogPopup className="sm:max-w-100">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when snoozed threads return to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label="Schedule type"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="duration">Snooze for</Toggle>
                <Toggle value="date">Date and time</Toggle>
              </ToggleGroup>
              <div className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                      <Label htmlFor={`${id}-date`}>Date</Label>
                      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger
                          render={
                            <Button
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
                        <PopoverPopup align="start" aria-label="Choose snooze date">
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
                      Time
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
                      <legend className="mb-1.5 text-muted-foreground text-label">Duration</legend>
                      <div className="grid grid-cols-3 gap-2">
                        {DURATION_FIELDS.map((field) => (
                          <NumberField
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
                              <NumberFieldDecrement
                                aria-label={`Fewer ${field.label.toLowerCase()}`}
                              />
                              <NumberFieldInput aria-label={field.label} />
                              <NumberFieldIncrement
                                aria-label={`More ${field.label.toLowerCase()}`}
                              />
                            </NumberFieldGroup>
                            <label
                              htmlFor={`${id}-${field.key}`}
                              className="text-dim-foreground text-meta"
                            >
                              {field.label}
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
                        ? `Returns ${formatReturnTime(new Date(wakeAt), now)}`
                        : "Set a duration longer than zero."}
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
              Edit snooze options
            </Button>
            <Button type="button" variant="secondary" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">
              Snooze
              <SubmitKbd />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
