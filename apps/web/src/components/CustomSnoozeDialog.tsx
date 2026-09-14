import { useEffect, useId, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
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
  const [date, setDate] = useState(localSnoozeDate(initial));
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput = mode === "date" ? { mode, date, time } : { mode, amount, unit };
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
                    <Label
                      className="flex min-w-0 flex-col items-stretch gap-1.5"
                      htmlFor={`${id}-date`}
                    >
                      Date
                      <Input
                        nativeInput
                        id={`${id}-date`}
                        type="date"
                        required
                        value={date}
                        min={localSnoozeDate(new Date())}
                        onChange={(event) => {
                          setDate(event.target.value);
                          setError(null);
                        }}
                      />
                    </Label>
                    <Label
                      className="flex min-w-0 flex-col items-stretch gap-1.5"
                      htmlFor={`${id}-time`}
                    >
                      Time
                      <Input
                        nativeInput
                        id={`${id}-time`}
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
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      id={`${id}-amount`}
                      min={0}
                      step={1}
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
                <p className="text-pretty text-muted-foreground">
                  {mode === "date"
                    ? `Your time zone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}.`
                    : "Starts when you press Snooze. One day is 24 hours."}
                </p>
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
