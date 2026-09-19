import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Button } from "./ui/button";
import { CalendarIcon, ClockIcon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Label } from "./ui/label";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "~/lib/utils";
import { toggleVariants } from "./ui/toggle";
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

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

function CustomSnoozeDialog() {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput =
    mode === "date" ? { mode, date: localSnoozeDate(date), time } : { mode, amount, unit };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
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
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Tabs.Root
              value={mode}
              onValueChange={(value) => {
                if (value === "date" || value === "duration") setMode(value);
                setError(null);
              }}
              className="flex flex-col gap-4"
            >
              <Tabs.List
                aria-label="Schedule type"
                className="flex gap-0.5 rounded-lg bg-input/40 p-0.5"
              >
                {(["date", "duration"] as const).map((value) => (
                  <Tabs.Tab
                    key={value}
                    value={value}
                    data-pressed={mode === value ? "" : undefined}
                    className={toggleVariants({
                      variant: "segmented",
                      size: "sm",
                      className: "flex-1",
                    })}
                  >
                    {value === "date" ? "Date and time" : "Duration"}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              <Tabs.Panel value={mode} className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-date`}>Date</Label>
                      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger
                          render={
                            <Button
                              id={`${id}-date`}
                              variant="outline"
                              className="w-full justify-between font-normal"
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
                            disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                            onSelect={(selected) => {
                              setDate(selected);
                              setCalendarOpen(false);
                              setError(null);
                            }}
                          />
                        </PopoverPopup>
                      </Popover>
                    </div>
                    <Label
                      className="flex min-w-0 flex-col items-stretch gap-1.5"
                      htmlFor={`${id}-time`}
                    >
                      Time
                      <TimeField
                        id={`${id}-time`}
                        time={time}
                        onChange={(next) => {
                          setTime(next);
                          setError(null);
                        }}
                      />
                    </Label>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberField
                      className="gap-1.5"
                      id={`${id}-amount`}
                      min={0}
                      step="any"
                      value={amount === "" ? null : Number(amount)}
                      onValueChange={(value) => {
                        setAmount(value === null ? "" : String(value));
                        setError(null);
                      }}
                    >
                      <Label htmlFor={`${id}-amount`}>Snooze for</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label="Decrease duration" />
                        <NumberFieldInput required />
                        <NumberFieldIncrement aria-label="Increase duration" />
                      </NumberFieldGroup>
                    </NumberField>
                    <Label
                      className="flex min-w-0 flex-col items-stretch gap-1.5"
                      htmlFor={`${id}-unit`}
                    >
                      Unit
                      <Select
                        value={unit}
                        items={{ minutes: "Minutes", hours: "Hours", days: "Days" }}
                        onValueChange={(value) => {
                          if (value === "minutes" || value === "hours" || value === "days")
                            setUnit(value);
                          setError(null);
                        }}
                      >
                        <SelectTrigger id={`${id}-unit`} className="min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="minutes">Minutes</SelectItem>
                          <SelectItem value="hours">Hours</SelectItem>
                          <SelectItem value="days">Days</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Label>
                  </div>
                )}
              </Tabs.Panel>
            </Tabs.Root>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function parseSnoozeTime(time: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = time.split(":");
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 9,
    minute: Number.isInteger(minute) && minute >= 0 && minute < 60 ? minute : 0,
  };
}

function formatSnoozeTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function resolve12HourClock(timestampFormat: TimestampFormat | undefined): boolean {
  if (timestampFormat === "12-hour") return true;
  if (timestampFormat === "24-hour") return false;
  // "locale" (or still hydrating): mirror what the runtime locale renders —
  // a dayPeriod part means the locale uses AM/PM.
  const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatToParts(
    new Date(2026, 0, 1, 13, 0),
  );
  return parts.some((part) => part.type === "dayPeriod");
}

const HOUR_12_OPTIONS = Array.from({ length: 12 }, (_, index) => {
  const hour12 = index + 1;
  return { value: String(hour12), label: String(hour12).padStart(2, "0") };
});
const HOUR_24_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: String(hour).padStart(2, "0"),
}));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, minute) => ({
  value: String(minute),
  label: String(minute).padStart(2, "0"),
}));
const PERIOD_OPTIONS = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
];

/**
 * Time picker that shares the date picker's styling: an outline trigger
 * button opening a PopoverPopup with the same dropdown-glass surface and
 * primary/accent selection tokens as the calendar. The native
 * `<input type="time">` rendered an unstyled browser popup that matched
 * neither the calendar nor the rest of the app.
 */
function TimeField({
  id,
  time,
  onChange,
}: {
  id: string;
  time: string;
  onChange: (next: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const use12Hour = useMemo(() => resolve12HourClock(timestampFormat), [timestampFormat]);
  const [open, setOpen] = useState(false);
  const { hour, minute } = parseSnoozeTime(time);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;

  const display = use12Hour
    ? `${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${period}`
    : formatSnoozeTime(hour, minute);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button id={id} variant="outline" className="w-full justify-between font-normal" />}
      >
        {display}
        <ClockIcon className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        aria-label="Choose snooze time"
        viewportClassName="py-2 [--viewport-inline-padding:--spacing(2)]"
      >
        <div className="flex gap-0.5">
          <TimeColumn
            label={use12Hour ? "Hour (12-hour)" : "Hour"}
            options={use12Hour ? HOUR_12_OPTIONS : HOUR_24_OPTIONS}
            value={use12Hour ? String(hour12) : String(hour)}
            onSelect={(next) => {
              const nextHour = use12Hour
                ? (Number(next) % 12) + (period === "PM" ? 12 : 0)
                : Number(next);
              onChange(formatSnoozeTime(nextHour, minute));
            }}
            open={open}
          />
          <TimeColumn
            label="Minute"
            options={MINUTE_OPTIONS}
            value={String(minute)}
            onSelect={(next) => onChange(formatSnoozeTime(hour, Number(next)))}
            open={open}
          />
          {use12Hour && (
            <TimeColumn
              label="AM or PM"
              options={PERIOD_OPTIONS}
              value={period}
              onSelect={(next) => {
                const nextHour = (hour12 % 12) + (next === "PM" ? 12 : 0);
                onChange(formatSnoozeTime(nextHour, minute));
              }}
              open={open}
            />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function TimeColumn({
  label,
  options,
  value,
  onSelect,
  open,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onSelect: (value: string) => void;
  open: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      listRef.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
    }
  }, [open]);
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      className="flex max-h-48 min-w-14 flex-col overflow-y-auto p-1"
    >
      {options.map((option, optionIndex) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(option.value)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "ArrowDown"
                  ? (optionIndex + 1) % options.length
                  : event.key === "ArrowUp"
                    ? (optionIndex - 1 + options.length) % options.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? options.length - 1
                        : null;

              if (nextIndex === null || nextIndex === optionIndex) return;
              const nextOption = options[nextIndex];
              if (!nextOption) return;
              event.preventDefault();
              onSelect(nextOption.value);
              listRef.current?.querySelectorAll<HTMLButtonElement>("button")[nextIndex]?.focus();
            }}
            className={cn(
              "flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md px-2 text-base outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm",
              selected ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
