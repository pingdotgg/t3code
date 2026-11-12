import { memo } from "react";
import { LoaderCircleIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { startReadAloud, stopReadAloud, useReadAloudState } from "~/readAloud/readAloudPlayer";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Speaker button beside Copy on a reply's final message. Click again to stop. */
export const MessageReadAloudButton = memo(function MessageReadAloudButton({
  messageId,
  text,
}: {
  messageId: string;
  text: string;
}) {
  const voice = useClientSettings((settings) => settings.readAloudVoice);
  const readAloud = useReadAloudState();
  const isThisMessage = readAloud.messageId === messageId;
  const status = isThisMessage ? readAloud.status : "idle";
  const active = status !== "idle";
  const label = active ? "Stop reading" : "Read aloud";
  const Icon = status === "playing" ? SquareIcon : Volume2Icon;
  const note = readAloud.fallbackReason
    ? `${readAloud.fallbackReason} Using the basic Windows voice.`
    : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={active}
            onClick={() => {
              if (active) stopReadAloud();
              else void startReadAloud({ messageId, markdown: text, voice });
            }}
            type="button"
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        {status === "loading" ? (
          <LoaderCircleIcon className="size-3 animate-spin text-primary" />
        ) : (
          <Icon className={cn("size-3", active && "text-primary")} />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
        {note ? <p className="text-muted-foreground">{note}</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
});
