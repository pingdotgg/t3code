import { useEffect, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { Volume2Icon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { readAloudButtonAction } from "@t3tools/client-runtime/read-aloud";
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
  const action = readAloudButtonAction(state, id);
  const reading = action !== "read";
  const label =
    action === "stop" || action === "cancel"
      ? gt("Stop reading")
      : action === "resume"
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
              await readAloudController.toggle(id, text, settings);
              toastReadAloudError(id, gt("Could not read aloud"));
            }}
          >
            <Volume2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>
        {action === "cancel"
          ? gt("Cancel speech generation")
          : state.id === id && state.error
            ? state.error
            : label}
      </TooltipPopup>
    </Tooltip>
  );
}
