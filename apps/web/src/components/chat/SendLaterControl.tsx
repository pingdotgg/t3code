import { useEffect, useId, useRef, useState, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronUpIcon, Clock3Icon, PencilIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import { parseSendLaterMinutes, SEND_LATER_CUSTOM_MINUTES, SEND_LATER_DELAYS } from "./sendLater";

interface SendLaterControlProps {
  /** Read live: the popover can stay open while the connection or thread state changes. */
  canSend: boolean;
  onPointerDown?: PointerEventHandler<HTMLElement> | undefined;
  onSendLater: (delayMs: number) => void;
}

export function SendLaterControl({ canSend, onPointerDown, onSendLater }: SendLaterControlProps) {
  const composerMenuProps = useComposerMenuProps();
  const titleId = useId();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Send later"
                  onPointerDown={onPointerDown}
                  disabled={!canSend}
                />
              }
            />
          }
        >
          <Clock3Icon />
        </TooltipTrigger>
        <TooltipPopup>Send later</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="top"
        align="end"
        width="sm"
        padding="none"
        aria-labelledby={titleId}
        {...composerMenuProps}
      >
        <SendLaterOptions
          titleId={titleId}
          canSend={canSend}
          onSchedule={(delayMs) => {
            if (!canSend) return;
            setOpen(false);
            onSendLater(delayMs);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

// Remounts on every open, so the custom field starts collapsed at the default.
function SendLaterOptions({
  titleId,
  canSend,
  onSchedule,
}: {
  titleId: string;
  canSend: boolean;
  onSchedule: (delayMs: number) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [minutes, setMinutes] = useState(String(SEND_LATER_CUSTOM_MINUTES.default));
  const [attempted, setAttempted] = useState(false);
  const delayMs = parseSendLaterMinutes(minutes);
  const showInvalid = delayMs === null && (attempted || minutes.trim() !== "");
  const range = `${SEND_LATER_CUSTOM_MINUTES.min}–${SEND_LATER_CUSTOM_MINUTES.max}`;

  useEffect(() => {
    if (!customOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [customOpen]);

  return (
    <div className="flex flex-col p-1">
      <p id={titleId} className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        Send later
      </p>
      {SEND_LATER_DELAYS.map((option) => (
        <Button
          key={option.delayMs}
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          disabled={!canSend}
          onClick={() => onSchedule(option.delayMs)}
        >
          <Clock3Icon />
          {option.label}
        </Button>
      ))}
      <div className="mt-1 rounded-md border border-border/60 bg-muted/40">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          aria-expanded={customOpen}
          aria-controls={`${id}-custom`}
          onClick={() => setCustomOpen((value) => !value)}
        >
          <PencilIcon />
          Custom…
          {customOpen ? (
            <ChevronUpIcon className="ms-auto" />
          ) : (
            <ChevronDownIcon className="ms-auto" />
          )}
        </Button>
        {customOpen ? (
          <form
            id={`${id}-custom`}
            className="flex flex-col gap-1 px-2 pb-2"
            onSubmit={(event) => {
              // React bubbles this through the portal to the composer form,
              // whose own submit would send the message immediately.
              event.preventDefault();
              event.stopPropagation();
              setAttempted(true);
              if (delayMs !== null) onSchedule(delayMs);
            }}
          >
            <div className="flex items-center gap-1.5">
              <Input
                ref={inputRef}
                id={`${id}-minutes`}
                size="sm"
                className="w-14"
                inputMode="numeric"
                autoComplete="off"
                value={minutes}
                aria-invalid={showInvalid || undefined}
                aria-describedby={`${id}-help`}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <label htmlFor={`${id}-minutes`} className="flex-1 text-muted-foreground text-sm">
                minutes
              </label>
              <Button type="submit" size="sm" disabled={!canSend}>
                Schedule
              </Button>
            </div>
            <p
              id={`${id}-help`}
              className={showInvalid ? "text-destructive text-xs" : "text-muted-foreground text-xs"}
            >
              {showInvalid ? `Enter a whole number from ${range}.` : `Whole minutes, ${range}.`}
            </p>
          </form>
        ) : null}
      </div>
      {canSend ? null : (
        <p role="status" className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
          Sending is unavailable right now. Your message stays in the composer.
        </p>
      )}
    </div>
  );
}
