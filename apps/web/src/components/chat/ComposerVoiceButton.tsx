import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { Volume2Icon } from "lucide-react";
import type { PointerEvent } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { setVoiceThread, voiceThreadAtom } from "../../speech/voiceReplies";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepFocus = (event: PointerEvent) => event.preventDefault();

/** Turns on reading this thread's replies aloud, or turns voice off. */
export function ComposerVoiceButton(props: {
  thread: ScopedThreadRef;
  keybindings: ResolvedKeybindingsConfig;
  disabled: boolean;
}) {
  const voiceThread = useAtomValue(voiceThreadAtom);
  const on = voiceThread?.threadId === props.thread.threadId;
  const label = on ? "Stop reading replies aloud" : "Read replies aloud";
  const shortcutLabel = shortcutLabelForCommand(
    props.keybindings,
    on ? "voice.off" : "voice.cycle",
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={on ? "secondary" : "ghost"}
            aria-label={label}
            aria-pressed={on}
            disabled={props.disabled}
            onPointerDown={keepFocus}
            onClick={() => void setVoiceThread(appAtomRegistry, on ? null : props.thread)}
            className="shrink-0"
          >
            <Volume2Icon />
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
