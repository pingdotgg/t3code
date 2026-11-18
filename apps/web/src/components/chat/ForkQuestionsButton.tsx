import { useGT } from "gt-react";
import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Fork: the prompt the composer's question button sends, a Claude Code skill. */
export const FORK_QUESTIONS_PROMPT = "/q";

export function ForkQuestionsButton(props: {
  readonly disabled: boolean;
  readonly onSend: () => void;
}) {
  const gt = useGT();
  const label = gt("Work through my questions ({command})", { command: FORK_QUESTIONS_PROMPT });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onSend}
            aria-label={label}
          />
        }
      >
        <MessageCircleQuestionIcon />
      </TooltipTrigger>
      <TooltipPopup>
        {props.disabled
          ? gt("Work through my questions ({command}). Clear the draft first.", {
              command: FORK_QUESTIONS_PROMPT,
            })
          : label}
      </TooltipPopup>
    </Tooltip>
  );
}
