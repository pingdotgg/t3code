import { MicIcon } from "lucide-react";
import type { PointerEvent } from "react";

import type { ComposerDictation } from "~/dictation/useComposerDictation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerDictationActivity } from "./ComposerDictationActivity";

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

// Keep recording controls available while the editor is frozen.
export function ComposerDictationControl(props: {
  readonly dictation: ComposerDictation;
  readonly disabled: boolean;
  readonly shortcutLabel: string | null;
}) {
  const { dictation } = props;
  const phase = dictation.state.phase;
  const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
  const label = dictation.environmentId === null ? "Set up dictation" : "Dictate";

  return (
    <div
      role="group"
      aria-label="Dictation"
      data-active={active ? "" : undefined}
      className="group flex h-8 items-center rounded-full border border-transparent transition-[border-color] duration-200 ease-out data-active:border-border motion-reduce:transition-none"
    >
      <div
        className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-data-active:grid-cols-[1fr] motion-reduce:transition-none"
        inert={!active}
      >
        <div className="min-w-0 overflow-hidden">
          <ComposerDictationActivity
            phase={phase}
            level={dictation.level}
            onCancel={dictation.cancel}
          />
        </div>
      </div>
      {active ? (
        <button
          type="button"
          disabled={phase !== "recording"}
          onPointerDown={keepComposerFocus}
          onClick={dictation.stop}
          aria-label={phase === "recording" ? "Stop and insert dictation" : "Transcribing"}
          className="mr-0.5 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground transition-[opacity,scale] duration-200 ease-out starting:scale-50 starting:opacity-0 disabled:opacity-45 motion-reduce:transition-none"
        >
          <span className="size-2.5 rounded-xs bg-current" />
        </button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={props.disabled}
                onPointerDown={keepComposerFocus}
                onClick={dictation.start}
                aria-label={label}
              />
            }
          >
            <MicIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {props.shortcutLabel && dictation.environmentId !== null
              ? `${label} (hold ${props.shortcutLabel})`
              : label}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
