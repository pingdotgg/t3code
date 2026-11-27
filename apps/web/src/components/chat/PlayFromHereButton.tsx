import { use } from "react";
import { useGT } from "gt-react";
import { ListVideoIcon } from "lucide-react";
import type { MessageId } from "@t3tools/contracts";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudController } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { toastReadAloudError } from "./ReadAloudButton";
import { TimelineRowCtx } from "./timelineRowContext";

/** Reads this message and every one after it aloud. */
export function PlayFromHereButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const settings = useClientSettings((value) => value.readAloud);
  const gt = useGT();
  if (settings.provider === "off") return null;
  const label = gt("Play from here");
  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-label={label}
          onClick={() => {
            void readAloudController
              .playFrom(ctx.readAloudQueue(messageId), settings)
              .then(() => toastReadAloudError(null, gt("Could not read aloud")));
          }}
        />
      }
      label={label}
    >
      <ListVideoIcon className="size-3" />
    </SharedTooltipTrigger>
  );
}
