import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { readAloudButtonMode } from "@t3tools/client-runtime/read-aloud";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudController, warmReadAloud } from "../../speech/readAloud";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

/** Shows `title` and the error when reading message `id` failed. */
export function toastReadAloudError(id: string, title: string) {
  const result = readAloudController.getSnapshot();
  if (result.id === id && result.status === "error")
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
  const { action, stoppable } = readAloudButtonMode(state, id);
  const label = {
    read: gt("Read aloud"),
    cancel: gt("Cancel speech generation"),
    pause: gt("Pause reading"),
    resume: gt("Resume reading"),
  }[action];
  const Icon = { read: Volume2Icon, cancel: SquareIcon, pause: PauseIcon, resume: PlayIcon }[
    action
  ];
  const stopLabel = gt("Stop reading");
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label={label}
              onClick={async () => {
                if (action === "cancel") return readAloudController.stop();
                if (action === "pause") return readAloudController.pause();
                if (action === "resume") await readAloudController.resume();
                else await readAloudController.start(id, text, settings);
                toastReadAloudError(id, gt("Could not read aloud"));
              }}
            >
              <Icon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup>{state.id === id && state.error ? state.error : label}</TooltipPopup>
      </Tooltip>
      {stoppable && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                aria-label={stopLabel}
                onClick={() => readAloudController.stop()}
              >
                <SquareIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup>{stopLabel}</TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
