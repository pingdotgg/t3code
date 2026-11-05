import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect, useRef } from "react";

import { shortcutLabelForCommand } from "../../../keybindings";
import { cn } from "../../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { Button } from "../../ui/button";
import { attachDoom, detachDoom, quitDoom, registerDoomSlot, useDoomStore } from "./doomFrame";

/** Hosts the game inside the working row while an agent runs. */
export function DoomSlot() {
  const open = useDoomStore((state) => state.open);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hostRef = useRef<HTMLDivElement>(null);
  const shortcut = shortcutLabelForCommand(keybindings, "doom.toggle");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the hotkey a working row exists to host the game
  useLayoutEffect(() => registerDoomSlot(), []);

  // The host div always renders: React removes a conditional child before this cleanup runs,
  // and an iframe that leaves the document reloads.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the game's iframe, a DOM node React does not own, in and out of this row
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || host === null) return;
    attachDoom(host);
    return () => detachDoom(host);
  }, [open]);

  return (
    <div className={cn("mt-2 max-w-[640px]", !open && "hidden")}>
      <div ref={hostRef} className="aspect-[8/5] w-full overflow-hidden rounded-md bg-black" />
      <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
        <span>
          Click the game to play. {shortcut ? `${shortcut} hides it.` : null} Arrows move, Space
          fires, E opens doors.
        </span>
        <Button variant="ghost" size="xs" onClick={quitDoom}>
          Quit Doom
        </Button>
      </div>
    </div>
  );
}
