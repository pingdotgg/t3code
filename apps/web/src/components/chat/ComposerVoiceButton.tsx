import type { ResolvedKeybindingsConfig, ScopedThreadRef, VoiceMode } from "@t3tools/contracts";
import { AudioLinesIcon, Volume2Icon } from "lucide-react";
import type { PointerEvent } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { changeVoiceMode } from "../../speech/voiceReplies";
import { nextButtonVoiceMode } from "../../speech/voiceReplies.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepFocus = (event: PointerEvent) => event.preventDefault();

const LABELS: Record<VoiceMode, string> = {
  off: "Turn on one-way voice",
  oneWay: "Turn on two-way voice",
  twoWay: "Turn voice off",
};

/** Steps this thread's voice from off to one-way, two-way, and off again. */
export function ComposerVoiceButton(props: {
  thread: ScopedThreadRef;
  mode: VoiceMode;
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
}) {
  const label = LABELS[props.mode];
  const shortcutLabel = shortcutLabelForCommand(
    props.keybindings,
    props.mode === "twoWay" ? "voice.off" : "voice.cycle",
  );
  const Icon = props.mode === "twoWay" ? AudioLinesIcon : Volume2Icon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={props.mode === "off" ? "ghost" : "secondary"}
            aria-label={label}
            aria-pressed={props.mode !== "off"}
            disabled={props.disabled}
            onPointerDown={keepFocus}
            onClick={() =>
              void changeVoiceMode(appAtomRegistry, props.thread, nextButtonVoiceMode(props.mode))
            }
            className="shrink-0"
          >
            <Icon />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
