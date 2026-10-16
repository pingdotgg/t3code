import { useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (char) => {
    if (char === "@" || char === "." || char === "-" || char === "_") return char;
    return nextChar();
  }).join("");
}

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly className?: string;
}) {
  // "hiding" blurs the real value first; the placeholder swaps in once the blur has faded in.
  const [visibility, setVisibility] = useState<"hidden" | "hiding" | "revealed">("hidden");
  const revealed = visibility === "revealed";
  const hideTimeout = useRef(0);
  const value = props.value?.trim();
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);
  const finishHiding = () =>
    setVisibility((current) => (current === "hiding" ? "hidden" : current));

  if (!value) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer rounded-sm font-mono text-2xs leading-normal transition hover:text-foreground",
              revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-xs",
              props.className,
            )}
            onClick={() => {
              window.clearTimeout(hideTimeout.current);
              if (!revealed) {
                setVisibility("revealed");
                return;
              }
              setVisibility("hiding");
              // Finishes the hide when the blur never reports its end, e.g. a theme change suppressed it.
              hideTimeout.current = window.setTimeout(finishHiding, 400);
            }}
            onTransitionEnd={(event) => {
              if (event.propertyName === "filter") finishHiding();
            }}
            aria-label={props.ariaLabel}
          >
            {visibility === "hidden" ? redacted : value}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}
