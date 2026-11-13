import { useSyncExternalStore } from "react";
import { PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudController } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const settings = useClientSettings((value) => value.readAloud);
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  if (settings.provider === "off") return null;
  const active = state.id === id;
  const stoppable = active && (state.status === "playing" || state.status === "loading");
  const label = stoppable
    ? "Stop reading"
    : active && state.status === "paused"
      ? "Resume reading"
      : "Read aloud";
  const Icon = stoppable
    ? SquareIcon
    : active && state.status === "paused"
      ? PlayIcon
      : Volume2Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={async () => {
              if (stoppable) return readAloudController.stop();
              if (active && state.status === "paused") await readAloudController.resume();
              else await readAloudController.start(id, text, settings);
              const result = readAloudController.getSnapshot();
              if (result.id === id && result.status === "error")
                toastManager.add({
                  type: "error",
                  title: "Could not read aloud",
                  description: result.error,
                });
            }}
          >
            <Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>
        {active && state.status === "loading"
          ? "Cancel speech generation"
          : active && state.error
            ? state.error
            : label}
      </TooltipPopup>
    </Tooltip>
  );
}
