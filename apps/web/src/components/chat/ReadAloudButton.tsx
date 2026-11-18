import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudController, warmReadAloud } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const settings = useClientSettings((value) => value.readAloud);
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loading the environment's local model while replies are on screen hides its startup from the first click.
  useEffect(() => warmReadAloud(settings), [settings]);
  const gt = useGT();
  if (settings.provider === "off") return null;
  const active = state.id === id;
  const stoppable = active && (state.status === "playing" || state.status === "loading");
  const label = stoppable
    ? gt("Stop reading")
    : active && state.status === "paused"
      ? gt("Resume reading")
      : gt("Read aloud");
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
                  title: gt("Could not read aloud"),
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
          ? gt("Cancel speech generation")
          : active && state.error
            ? state.error
            : label}
      </TooltipPopup>
    </Tooltip>
  );
}
