import { T, useGT } from "gt-react";
import { ClockIcon } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";

import { Button } from "./button";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import {
  applyHourDigit,
  applyMinuteDigit,
  buildMinuteOptions,
  formatTimeValue,
  padTimePart,
  parseTimeValue,
  stepHour,
  stepMinute,
  to12Hour,
  to24Hour,
  type TimePeriod,
} from "./time-picker.logic";

const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const HOURS_24 = Array.from({ length: 24 }, (_, index) => index);
const PERIODS: ReadonlyArray<TimePeriod> = ["am", "pm"];

export interface TimePickerProps {
  id?: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
  hour12?: boolean | undefined;
  step?: number | undefined;
  size?: "sm" | "default" | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
}

export function TimePicker({
  id,
  value,
  onValueChange,
  hour12 = true,
  step = 5,
  size = "default",
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: TimePickerProps): React.ReactElement {
  const gt = useGT();
  const resolvedAriaLabel = ariaLabel ?? gt("Time", { $context: "time of day" });
  const parsed = parseTimeValue(value) ?? { hours: 9, minutes: 0 };
  const { hour12: displayHour12, period } = to12Hour(parsed.hours);

  const [open, setOpen] = React.useState(false);
  const [hourBuffer, setHourBuffer] = React.useState("");
  const [minuteBuffer, setMinuteBuffer] = React.useState("");

  const openedValueRef = React.useRef(value);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const hourSegRef = React.useRef<HTMLSpanElement>(null);
  const minuteSegRef = React.useRef<HTMLSpanElement>(null);
  const periodSegRef = React.useRef<HTMLSpanElement>(null);
  const hourListRef = React.useRef<HTMLUListElement>(null);
  const minuteListRef = React.useRef<HTMLUListElement>(null);
  const periodListRef = React.useRef<HTMLUListElement>(null);

  const minuteOptions = buildMinuteOptions(parsed.minutes, step);

  const commit = (hours: number, minutes: number) => {
    const next = formatTimeValue(hours, minutes);
    if (next !== value) {
      onValueChange(next);
    }
  };

  const scrollColumnToSelected = (list: HTMLUListElement | null, smooth: boolean) => {
    if (!list) return;
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    const top = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled && nextOpen) return;
    if (nextOpen) {
      openedValueRef.current = value;
      setHourBuffer("");
      setMinuteBuffer("");
      requestAnimationFrame(() => {
        scrollColumnToSelected(hourListRef.current, false);
        scrollColumnToSelected(minuteListRef.current, false);
      });
    }
    setOpen(nextOpen);
  };

  const handleRevertAndClose = () => {
    if (openedValueRef.current !== value) {
      onValueChange(openedValueRef.current);
    }
    setOpen(false);
    hourSegRef.current?.focus();
  };

  const handleHourKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHourBuffer("");
      commit(stepHour(parsed.hours, 1, hour12), parsed.minutes);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.altKey) {
        handleOpenChange(true);
        return;
      }
      setHourBuffer("");
      commit(stepHour(parsed.hours, -1, hour12), parsed.minutes);
    } else if (event.key === "ArrowRight" || event.key === ":") {
      event.preventDefault();
      setHourBuffer("");
      minuteSegRef.current?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      handleOpenChange(!open);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      setHourBuffer("");
    } else if (/^\d$/.test(event.key)) {
      event.preventDefault();
      const result = applyHourDigit(hourBuffer, event.key, hour12, period);
      setHourBuffer(result.nextBuffer);
      if (result.nextHour24 !== null) {
        commit(result.nextHour24, parsed.minutes);
      }
      if (result.advance) {
        minuteSegRef.current?.focus();
      }
    }
  };

  const handleMinuteKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMinuteBuffer("");
      commit(parsed.hours, stepMinute(parsed.minutes, event.shiftKey ? step : 1));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.altKey) {
        handleOpenChange(true);
        return;
      }
      setMinuteBuffer("");
      commit(parsed.hours, stepMinute(parsed.minutes, event.shiftKey ? -step : -1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setMinuteBuffer("");
      hourSegRef.current?.focus();
    } else if (event.key === "ArrowRight" && hour12) {
      event.preventDefault();
      setMinuteBuffer("");
      periodSegRef.current?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      handleOpenChange(!open);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      setMinuteBuffer("");
    } else if (/^\d$/.test(event.key)) {
      event.preventDefault();
      const result = applyMinuteDigit(minuteBuffer, event.key);
      setMinuteBuffer(result.nextBuffer);
      commit(parsed.hours, result.nextMinute);
      if (result.advance && hour12) {
        periodSegRef.current?.focus();
      }
    }
  };

  const handlePeriodKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (disabled) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      minuteSegRef.current?.focus();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === " ") {
      event.preventDefault();
      if (event.key === "ArrowDown" && event.altKey) {
        handleOpenChange(true);
        return;
      }
      const nextPeriod: TimePeriod = period === "am" ? "pm" : "am";
      commit(to24Hour(displayHour12, nextPeriod), parsed.minutes);
    } else if (event.key.toLowerCase() === "a") {
      event.preventDefault();
      commit(to24Hour(displayHour12, "am"), parsed.minutes);
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      commit(to24Hour(displayHour12, "pm"), parsed.minutes);
    } else if (event.key === "Enter") {
      event.preventDefault();
      handleOpenChange(!open);
    }
  };

  const focusSelectedInColumn = (list: HTMLUListElement | null) => {
    list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  };

  const handleColumnKeyDown = (
    column: "hour" | "minute" | "period",
    event: React.KeyboardEvent<HTMLUListElement>,
  ) => {
    const columns: ReadonlyArray<{
      kind: "hour" | "minute" | "period";
      ref: React.RefObject<HTMLUListElement | null>;
    }> = hour12
      ? [
          { kind: "hour", ref: hourListRef },
          { kind: "minute", ref: minuteListRef },
          { kind: "period", ref: periodListRef },
        ]
      : [
          { kind: "hour", ref: hourListRef },
          { kind: "minute", ref: minuteListRef },
        ];
    const columnIndex = columns.findIndex((entry) => entry.kind === column);

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleRevertAndClose();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(false);
      hourSegRef.current?.focus();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusSelectedInColumn(columns[columnIndex + 1]?.ref.current ?? null);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusSelectedInColumn(columns[columnIndex - 1]?.ref.current ?? null);
      return;
    }

    if (column === "hour") {
      const hours = hour12 ? HOURS_12 : HOURS_24;
      const current = hour12 ? displayHour12 : parsed.hours;
      const index = hours.indexOf(current as never);
      let nextIndex = index;
      if (event.key === "ArrowDown") nextIndex = (index + 1) % hours.length;
      else if (event.key === "ArrowUp") nextIndex = (index - 1 + hours.length) % hours.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = hours.length - 1;
      else if (event.key === "PageDown") nextIndex = Math.min(hours.length - 1, index + 4);
      else if (event.key === "PageUp") nextIndex = Math.max(0, index - 4);
      else return;

      event.preventDefault();
      const nextHour = hours[nextIndex]!;
      commit(hour12 ? to24Hour(nextHour, period) : nextHour, parsed.minutes);
      requestAnimationFrame(() => {
        scrollColumnToSelected(hourListRef.current, true);
        focusSelectedInColumn(hourListRef.current);
      });
    } else if (column === "minute") {
      const index = minuteOptions.findIndex((option) => option.minute === parsed.minutes);
      let nextIndex = index;
      if (event.key === "ArrowDown") nextIndex = (index + 1) % minuteOptions.length;
      else if (event.key === "ArrowUp")
        nextIndex = (index - 1 + minuteOptions.length) % minuteOptions.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = minuteOptions.length - 1;
      else if (event.key === "PageDown") nextIndex = Math.min(minuteOptions.length - 1, index + 4);
      else if (event.key === "PageUp") nextIndex = Math.max(0, index - 4);
      else return;

      event.preventDefault();
      const nextMinute = minuteOptions[nextIndex]!.minute;
      commit(parsed.hours, nextMinute);
      requestAnimationFrame(() => {
        scrollColumnToSelected(minuteListRef.current, true);
        focusSelectedInColumn(minuteListRef.current);
      });
    } else {
      let nextPeriod: TimePeriod | null = null;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        nextPeriod = period === "am" ? "pm" : "am";
      } else if (event.key.toLowerCase() === "a") {
        nextPeriod = "am";
      } else if (event.key.toLowerCase() === "p") {
        nextPeriod = "pm";
      }
      if (!nextPeriod) return;
      event.preventDefault();
      commit(to24Hour(displayHour12, nextPeriod), parsed.minutes);
      requestAnimationFrame(() => focusSelectedInColumn(periodListRef.current));
    }
  };

  const hoursList = hour12 ? HOURS_12 : HOURS_24;
  const shownHourText =
    hourBuffer !== ""
      ? hourBuffer.padStart(2, "0")
      : padTimePart(hour12 ? displayHour12 : parsed.hours);
  const shownMinuteText =
    minuteBuffer !== "" ? minuteBuffer.padStart(2, "0") : padTimePart(parsed.minutes);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div
        ref={fieldRef}
        id={id}
        role="group"
        aria-label={ariaLabelledBy ? undefined : resolvedAriaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        data-disabled={disabled || undefined}
        data-open={open || undefined}
        data-size={size}
        data-slot="time-picker"
        className={cn(
          "relative inline-flex w-32 items-center justify-between rounded-lg border border-input bg-background not-dark:bg-clip-padding ps-2 pe-1 text-base text-foreground tabular-nums shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-within:not-data-open:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:shadow-none data-open:border-ring data-open:ring-[3px] data-open:ring-inset data-open:shadow-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm dark:bg-input/32 dark:not-data-disabled:not-focus-within:not-data-open:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          size === "sm" ? "h-8 sm:h-7" : "h-9 sm:h-8",
          className,
        )}
        onMouseDown={(event) => {
          if (disabled) return;
          if (event.target === event.currentTarget) {
            event.preventDefault();
            handleOpenChange(!open);
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center select-none">
          <span
            ref={hourSegRef}
            role="spinbutton"
            tabIndex={disabled ? -1 : 0}
            aria-label={gt("Hour")}
            aria-valuemin={hour12 ? 1 : 0}
            aria-valuemax={hour12 ? 12 : 23}
            aria-valuenow={hour12 ? displayHour12 : parsed.hours}
            data-pending={hourBuffer !== "" || undefined}
            className="cursor-text rounded px-0.5 leading-5 outline-none focus:bg-primary/25 focus:text-foreground data-pending:text-muted-foreground"
            onKeyDown={handleHourKeyDown}
            onBlur={() => setHourBuffer("")}
          >
            {shownHourText}
          </span>
          <span aria-hidden="true" className="px-px text-muted-foreground">
            :
          </span>
          <span
            ref={minuteSegRef}
            role="spinbutton"
            tabIndex={disabled ? -1 : 0}
            aria-label={gt("Minute")}
            aria-valuemin={0}
            aria-valuemax={59}
            aria-valuenow={parsed.minutes}
            data-pending={minuteBuffer !== "" || undefined}
            className="cursor-text rounded px-0.5 leading-5 outline-none focus:bg-primary/25 focus:text-foreground data-pending:text-muted-foreground"
            onKeyDown={handleMinuteKeyDown}
            onBlur={() => setMinuteBuffer("")}
          >
            {shownMinuteText}
          </span>
          {hour12 ? (
            <span
              ref={periodSegRef}
              role="spinbutton"
              tabIndex={disabled ? -1 : 0}
              aria-label={gt("AM or PM")}
              aria-valuetext={period}
              className="ms-1 cursor-text rounded px-0.5 leading-5 outline-none focus:bg-primary/25 focus:text-foreground"
              onKeyDown={handlePeriodKeyDown}
            >
              {period}
            </span>
          ) : null}
        </div>

        <PopoverTrigger
          disabled={disabled}
          aria-label={gt("Choose time")}
          render={
            <Button
              type="button"
              variant={open ? "default" : "ghost-muted"}
              size="icon-micro"
              className="size-5.5 rounded-[5px]"
            />
          }
        >
          <ClockIcon className="size-3.5" aria-hidden="true" />
        </PopoverTrigger>
      </div>

      <PopoverPopup
        align="start"
        anchor={fieldRef}
        padding="none"
        aria-label={gt("Choose time")}
        className="w-54"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            handleRevertAndClose();
          }
        }}
      >
        <div className="flex gap-0.5 p-1">
          <ul
            ref={hourListRef}
            role="listbox"
            aria-label={gt("Hour")}
            className="h-[182px] flex-1 overflow-y-auto rounded-md outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onKeyDown={(event) => handleColumnKeyDown("hour", event)}
          >
            {hoursList.map((hourOption) => {
              const selected = hour12 ? displayHour12 === hourOption : parsed.hours === hourOption;
              return (
                <li
                  key={hourOption}
                  role="option"
                  tabIndex={selected ? 0 : -1}
                  aria-selected={selected}
                  className={cn(
                    "mx-0.5 my-px flex h-7 cursor-default items-center justify-center rounded-md text-sm tabular-nums select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected
                      ? "bg-primary/20 font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => {
                    commit(hour12 ? to24Hour(hourOption, period) : hourOption, parsed.minutes);
                    requestAnimationFrame(() => scrollColumnToSelected(hourListRef.current, true));
                  }}
                >
                  {padTimePart(hourOption)}
                </li>
              );
            })}
          </ul>

          <ul
            ref={minuteListRef}
            role="listbox"
            aria-label={gt("Minute")}
            className="h-[182px] flex-1 overflow-y-auto rounded-md border-s border-border/60 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onKeyDown={(event) => handleColumnKeyDown("minute", event)}
          >
            {minuteOptions.map(({ minute, offStep }) => {
              const selected = parsed.minutes === minute;
              return (
                <li
                  key={minute}
                  role="option"
                  tabIndex={selected ? 0 : -1}
                  aria-selected={selected}
                  data-offstep={offStep || undefined}
                  className={cn(
                    "mx-0.5 my-px flex h-7 cursor-default items-center justify-center rounded-md text-sm tabular-nums select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    offStep && "italic",
                    selected
                      ? "bg-primary/20 font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => {
                    commit(parsed.hours, minute);
                    requestAnimationFrame(() =>
                      scrollColumnToSelected(minuteListRef.current, true),
                    );
                  }}
                >
                  {padTimePart(minute)}
                </li>
              );
            })}
          </ul>

          {hour12 ? (
            <ul
              ref={periodListRef}
              role="listbox"
              aria-label={gt("AM or PM")}
              className="w-13 shrink-0 self-start rounded-md border-s border-border/60 outline-none"
              onKeyDown={(event) => handleColumnKeyDown("period", event)}
            >
              {PERIODS.map((periodOption) => {
                const selected = period === periodOption;
                return (
                  <li
                    key={periodOption}
                    role="option"
                    tabIndex={selected ? 0 : -1}
                    aria-selected={selected}
                    className={cn(
                      "mx-0.5 my-px flex h-7 cursor-default items-center justify-center rounded-md text-sm select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected
                        ? "bg-primary/20 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => commit(to24Hour(displayHour12, periodOption), parsed.minutes)}
                  >
                    {periodOption}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1 select-none" aria-hidden="true">
            <kbd className="rounded border border-border px-1 font-mono text-[10px] text-foreground/80">
              ↑↓
            </kbd>
            <kbd className="rounded border border-border px-1 font-mono text-[10px] text-foreground/80">
              ←→
            </kbd>
            <kbd className="rounded border border-border px-1 font-mono text-[10px] text-foreground/80">
              ⏎
            </kbd>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              setOpen(false);
              hourSegRef.current?.focus();
            }}
          >
            <T>Done</T>
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
