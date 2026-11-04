import { memo } from "react";
import { LoaderCircle, Square, Volume2 } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
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
        <MorphIcon
          className={cn("size-3", active && "text-primary", status === "loading" && "animate-spin")}
          icon={status === "loading" ? LoaderCircle : status === "playing" ? Square : Volume2}
        />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
        {note ? <p className="text-muted-foreground">{note}</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
});
