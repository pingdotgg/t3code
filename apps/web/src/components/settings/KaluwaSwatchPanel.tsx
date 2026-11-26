// Fork: on Kaluwa an accent colour comes from the current palette; a custom colour waits behind
// "Advanced". The picked swatch is stored as its hex and shown as that swatch of any later palette
// (see kaluwa/kaluwaAccent.ts).
import { T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { KALUWA_SWATCH_SLOTS, kaluwaSwatchSlotForHex } from "../../kaluwa/kaluwaPalette";
import { useKaluwaLook } from "../../kaluwa/kaluwaLook";
import { KALUWA_SWATCH_LABELS } from "./kaluwaLookLabels";
import { Button } from "../ui/button";
import { PopoverClose } from "../ui/popover";

export function KaluwaSwatchPanel(props: {
  readonly value: string | undefined;
  readonly onCommit: (value: string) => void;
  /** The custom colour picker, shown under "Advanced". */
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const m = useMessages();
  const { palette } = useKaluwaLook();
  const pickedSlot = props.value ? kaluwaSwatchSlotForHex(props.value) : null;
  const [advanced, setAdvanced] = useState(() => Boolean(props.value) && pickedSlot === null);

  return (
    <div className="w-56 bg-popover">
      <div className="grid grid-cols-7 gap-1.5 p-3" role="group" aria-label={gt("Palette")}>
        {KALUWA_SWATCH_SLOTS.map((slot) => {
          const label = m(KALUWA_SWATCH_LABELS[slot]);
          const picked = pickedSlot === slot;
          return (
            <PopoverClose
              key={slot}
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={picked}
                  className={cn(
                    "aspect-square cursor-pointer rounded-md ring-1 ring-inset ring-foreground/12 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    picked && "ring-2 ring-foreground ring-offset-2 ring-offset-popover",
                  )}
                  style={{ backgroundColor: palette[slot] }}
                  onClick={() => props.onCommit(palette[slot])}
                />
              }
            />
          );
        })}
      </div>
      <div className="border-t border-border/60 p-1">
        <Button
          type="button"
          size="compact"
          variant="ghost-muted"
          className="w-full justify-start"
          aria-expanded={advanced}
          onClick={() => setAdvanced((open) => !open)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", !advanced && "-rotate-90")}
          />
          <T>Advanced: custom color</T>
        </Button>
      </div>
      {advanced ? <div className="border-t border-border/60">{props.children}</div> : null}
    </div>
  );
}
