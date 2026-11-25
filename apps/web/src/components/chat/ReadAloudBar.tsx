import { useEffect, useState, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { ArrowDownToLineIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { readAloudController } from "../../speech/readAloud";
import {
  readAloudAway,
  returnToReadAloud,
  subscribeReadAloudAway,
} from "../../speech/readAloudHighlight";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceWaveform } from "./VoiceInputPill";

const SPEEDS = [0.75, 1, 1.25, 1.5];

/** Above the composer while a reply is read: how loud it plays, its speed, and its controls. */
export function ReadAloudBar() {
  const gt = useGT();
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const away = useSyncExternalStore(subscribeReadAloudAway, readAloudAway);
  const settings = useClientSettings((value) => value.readAloud);
  const shown =
    state.status === "loading" || state.status === "playing" || state.status === "paused";
  const [level, setLevel] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follows the playing audio's loudness, which only the player reports.
  useEffect(() => (shown ? readAloudController.subscribeLevel(setLevel) : undefined), [shown]);
  if (!shown) return null;
  const paused = state.status === "paused";
  const toggle = paused ? gt("Resume reading") : gt("Pause reading");
  return (
    // Floats above the composer, so starting and stopping never shifts the thread.
    <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex justify-center">
      <div
        role="toolbar"
        aria-label={gt("Read aloud")}
        className="pointer-events-auto flex h-8 items-center gap-1 rounded-full border bg-popover px-1.5 shadow-md/5"
      >
        <div className="flex w-14 items-center pl-1">
          <VoiceWaveform level={paused ? 0 : level} />
        </div>
        <Select
          value={String(settings.speed)}
          onValueChange={(value) => {
            const speed = Number(value);
            void updateClientSettings({ readAloud: { ...settings, speed } });
            void readAloudController.setSpeed(speed);
          }}
        >
          <SelectTrigger size="compact" variant="ghost" aria-label={gt("Read-aloud speed")}>
            <SelectValue>{settings.speed}×</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {SPEEDS.map((speed) => (
              <SelectItem key={speed} value={String(speed)}>
                {speed}×
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <BarButton
          label={toggle}
          onClick={() => (paused ? void readAloudController.resume() : readAloudController.pause())}
        >
          {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
        </BarButton>
        <BarButton label={gt("Stop reading")} onClick={() => readAloudController.stop()}>
          <SquareIcon className="size-3.5" />
        </BarButton>
        {away ? (
          <BarButton label={gt("Go to the word being read")} onClick={returnToReadAloud}>
            <ArrowDownToLineIcon className="size-3.5" />
          </BarButton>
        ) : null}
      </div>
    </div>
  );
}

function BarButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm-pill"
            variant="ghost"
            aria-label={props.label}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
