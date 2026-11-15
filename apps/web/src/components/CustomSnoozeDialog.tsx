import { useEffect, useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
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

function CustomSnoozeDialog() {
  const id = useId();
  const navigate = useNavigate();
  const { t } = useTranslation("shell");
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const nowMinute = useNowMinute();
  // Follows the clock so a dialog left open past midnight stops offering yesterday.
  const today = startOfLocalDay(Date.parse(`${nowMinute}Z`));
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
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(mode === "date" ? t("snooze.invalidDate") : t("snooze.invalidDuration"));
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("snooze.title")}</DialogTitle>
            <DialogDescription>{t("snooze.description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label={t("snooze.scheduleType")}
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="date">{t("snooze.dateAndTime")}</Toggle>
                <Toggle value="duration">{t("snooze.duration")}</Toggle>
              </ToggleGroup>
              <div className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                      <Label htmlFor={`${id}-date`}>{t("snooze.date")}</Label>
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
                        <PopoverPopup align="start" aria-label={t("snooze.chooseDate")}>
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
                      {t("snooze.time")}
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
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberField
                      id={`${id}-amount`}
                      min={0}
                      step="any"
                      value={amount === "" ? null : Number(amount)}
                      onValueChange={(value) => {
                        setAmount(value === null ? "" : String(value));
                        setError(null);
                      }}
                    >
                      <Label htmlFor={`${id}-amount`}>{t("snooze.snoozeFor")}</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label={t("snooze.decreaseDuration")} />
                        <NumberFieldInput required />
                        <NumberFieldIncrement aria-label={t("snooze.increaseDuration")} />
                      </NumberFieldGroup>
                    </NumberField>
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-unit`}>
                      {t("snooze.unit")}
                      <Select
                        value={unit}
                        items={{
                          minutes: t("snooze.minutes"),
                          hours: t("snooze.hours"),
                          days: t("snooze.days"),
                        }}
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
                          <SelectItem value="minutes">{t("snooze.minutes")}</SelectItem>
                          <SelectItem value="hours">{t("snooze.hours")}</SelectItem>
                          <SelectItem value="days">{t("snooze.days")}</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Label>
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
              {t("snooze.editOptions")}
            </Button>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              {t("snooze.cancel")}
            </Button>
            <Button type="submit">{t("snooze.snooze")}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
