import { useEffect, useId, useState } from "react";
import { useTranslation } from "@t3tools/i18n/react";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { getCurrentTimestampLocale, resolveWeekStartsOn } from "../timestampFormat";
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

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

function CustomSnoozeDialog() {
  const { t } = useTranslation("snooze");
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const weekStartsOn = resolveWeekStartsOn(getCurrentTimestampLocale());
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
              setError(mode === "date" ? t("chooseFutureDateError") : t("positiveDurationError"));
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label={t("scheduleType")}
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="date">{t("dateTime")}</Toggle>
                <Toggle value="duration">{t("duration")}</Toggle>
              </ToggleGroup>
              <div className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-date`}>{t("date")}</Label>
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
                          {date.toLocaleDateString(getCurrentTimestampLocale(), {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          <CalendarIcon className="size-4 text-muted-foreground" />
                        </PopoverTrigger>
                        <PopoverPopup align="start" aria-label={t("chooseSnoozeDate")}>
                          <Calendar
                            mode="single"
                            required
                            selected={date}
                            defaultMonth={date}
                            {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
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
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-time`}>
                      {t("time")}
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
                      <Label htmlFor={`${id}-amount`}>{t("snoozeFor")}</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label={t("decreaseDuration")} />
                        <NumberFieldInput required />
                        <NumberFieldIncrement aria-label={t("increaseDuration")} />
                      </NumberFieldGroup>
                    </NumberField>
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-unit`}>
                      {t("unit")}
                      <Select
                        value={unit}
                        items={{
                          minutes: t("minutes"),
                          hours: t("hours"),
                          days: t("days"),
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
                          <SelectItem value="minutes">{t("minutes")}</SelectItem>
                          <SelectItem value="hours">{t("hours")}</SelectItem>
                          <SelectItem value="days">{t("days")}</SelectItem>
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
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit">{t("snooze")}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
