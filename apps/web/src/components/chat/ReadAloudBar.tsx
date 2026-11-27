import { READ_ALOUD_SPEEDS } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { readAloudController } from "../../speech/readAloud";
import {
  readAloudAway,
  returnToReadAloud,
  subscribeReadAloudAway,
} from "../../speech/readAloudHighlight";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { VoiceWaveform } from "./VoiceInputPill";

/** Tucked above the composer while a reply is read: what it is doing, how loud, how fast. */
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
    <ComposerBanner.Attachment className="transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none">
      <ComposerBanner.Root role="toolbar" aria-label={gt("Read aloud")}>
        <ComposerBanner.Row>
          <ComposerBanner.Content className="gap-1.5">
            <BarButton
              label={toggle}
              onClick={() =>
                paused ? void readAloudController.resume() : readAloudController.pause()
              }
            >
              {paused ? (
                <PlayIcon className="fill-current" />
              ) : (
                <PauseIcon className="fill-current" />
              )}
            </BarButton>
            {/* Trimmed to its capitals, so centering lines the letters up with the icon, not the line box. */}
            <span className="min-w-0 truncate py-1 font-medium [text-box:trim-both_cap_alphabetic]">
              {state.status === "loading"
                ? gt("Preparing to read")
                : paused
                  ? gt("Paused")
                  : gt("Reading aloud")}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions className="flex-nowrap">
            {away ? (
              <Badge
                variant="info"
                size="control"
                className="rounded-full"
                render={<button type="button" onClick={returnToReadAloud} />}
              >
                {away === "above" ? <ArrowUpIcon /> : <ArrowDownIcon />}
                {gt("Jump to current")}
              </Badge>
            ) : null}
            <div className="flex w-12 items-center">
              <VoiceWaveform level={paused ? 0 : level} />
            </div>
            {/* As wide as the widest speed, so picking one never moves the waveform. */}
            <div className="flex w-18 justify-end">
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
                  {READ_ALOUD_SPEEDS.map((speed) => (
                    <SelectItem key={speed} value={String(speed)}>
                      {speed}×
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <BarButton label={gt("Stop reading")} onClick={() => readAloudController.stop()}>
              <SquareIcon className="fill-current" />
            </BarButton>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
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
            size="icon-xs"
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
