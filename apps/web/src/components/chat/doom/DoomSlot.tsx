import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect, useRef } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../../keybindings";
import { cn } from "../../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { Button } from "../../ui/button";
import {
  attachDoom,
  detachDoom,
  hideDoom,
  newDoomGame,
  openDoom,
  quitDoom,
  registerDoomSlot,
  useDoomStore,
} from "./doomFrame";

const killsLabel = (kills: number) => `${kills} ${kills === 1 ? "kill" : "kills"}`;

/** Hosts the game inside the working row while an agent runs, when enabled in Chat settings. */
export function DoomSlot() {
  const enabled = useClientSettings((settings) => settings.doomEnabled);
  return enabled ? <EnabledDoomSlot /> : null;
}

function EnabledDoomSlot() {
  const open = useDoomStore((state) => state.open);
  const live = useDoomStore((state) => state.live);
  const savedKills = useDoomStore((state) => state.savedKills);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hostRef = useRef<HTMLDivElement>(null);
  const shortcut = shortcutLabelForCommand(keybindings, "doom.toggle");
  const resumable = live || savedKills !== null;

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
    <div className="max-w-[640px]">
      {open ? null : (
        <div className="flex items-center gap-1 pt-1">
          <Button
            variant="ghost-muted"
            size="micro"
            onClick={openDoom}
            title={shortcut ? `Play Doom (${shortcut})` : "Play Doom"}
          >
            {resumable
              ? `Continue Doom${savedKills !== null && !live ? ` · ${killsLabel(savedKills)}` : ""}`
              : "Play Doom while you wait"}
          </Button>
          {resumable ? (
            <Button variant="ghost-muted" size="micro" onClick={newDoomGame}>
              New game
            </Button>
          ) : null}
        </div>
      )}
      <div className={cn("mt-2", !open && "hidden")}>
        <div ref={hostRef} className="aspect-[8/5] w-full overflow-hidden rounded-md bg-black" />
        <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
          <span>Click to play. Arrows move, Space fires, E opens doors.</span>
          <span className="flex shrink-0 items-center gap-1">
            <Button variant="ghost-muted" size="micro" onClick={newDoomGame}>
              New game
            </Button>
            <Button
              variant="ghost-muted"
              size="micro"
              onClick={hideDoom}
              title={shortcut ? `Hide (${shortcut})` : "Hide"}
            >
              Hide
            </Button>
            <Button variant="ghost-muted" size="micro" onClick={quitDoom}>
              Quit
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
