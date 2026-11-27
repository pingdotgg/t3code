import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { Volume2Icon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudController, warmReadAloud } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

/** Shows `title` and the error when reading message `id` failed, or any message when null. */
export function toastReadAloudError(id: string | null, title: string) {
  const result = readAloudController.getSnapshot();
  if ((id === null || result.id === id) && result.status === "error")
    toastManager.add({ type: "error", title, description: result.error });
}

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
  const reading = stoppable || (active && state.status === "paused");
  const label = stoppable
    ? gt("Stop reading")
    : active && state.status === "paused"
      ? gt("Resume reading")
      : gt("Read aloud");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            // The player above the composer shows what is being read; this only marks which reply.
            variant={reading ? "ghost" : "ghost-muted"}
            aria-label={label}
            aria-pressed={reading}
            onClick={async () => {
              if (stoppable) return readAloudController.stop();
              if (active && state.status === "paused") await readAloudController.resume();
              else await readAloudController.start(id, text, settings);
              toastReadAloudError(id, gt("Could not read aloud"));
            }}
          >
            <Volume2Icon className="size-3" />
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
