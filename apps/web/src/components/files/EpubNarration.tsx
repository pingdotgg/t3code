import { useGT } from "gt-react";
import { HeadphonesIcon, PauseIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { Button } from "~/components/ui/button";
import type { EpubNarrationCue } from "./officePreviewProtocol";

export function EpubNarration(props: {
  readonly cues: readonly EpubNarrationCue[];
  readonly frame: RefObject<HTMLIFrameElement | null>;
}) {
  const gt = useGT();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  const index = useRef(0);
  const request = useRef(0);
  const highlight = useRef<Element | null>(null);

  function mark(cue: EpubNarrationCue | undefined) {
    const doc = props.frame.current?.contentDocument;
    const target = cue?.anchor ? doc?.getElementById(cue.anchor) : null;
    if (target === highlight.current) return;
    highlight.current?.classList.remove("t3-epub-narration-active");
    highlight.current = target ?? null;
    if (!target || !doc?.defaultView) return;
    target.classList.add("t3-epub-narration-active");
    const rect = target.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > doc.defaultView.innerHeight)
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function pause() {
    active.current = false;
    request.current++;
    audio.current?.pause();
    setPlaying(false);
  }

  function finish() {
    pause();
    index.current = 0;
    if (audio.current) audio.current.removeAttribute("src");
    mark(undefined);
  }

  function play(cue: EpubNarrationCue, resume: boolean) {
    const player = audio.current;
    if (!player) return;
    const command = ++request.current;
    const sameSource = player.getAttribute("src") === cue.src;
    if (!sameSource) player.src = cue.src;
    if (!resume || !sameSource) player.currentTime = cue.begin;
    void player.play().catch(() => {
      if (command !== request.current) return;
      finish();
      setFailed(true);
    });
  }

  function advance() {
    const previous = props.cues[index.current];
    const next = props.cues[++index.current];
    if (!next) return finish();
    const player = audio.current;
    if (
      !player ||
      player.ended ||
      previous?.src !== next.src ||
      previous.end === undefined ||
      Math.abs(next.begin - previous.end) > 0.02
    ) {
      play(next, false);
    }
  }

  function synchronize() {
    const player = audio.current;
    const cue = props.cues[index.current];
    if (!active.current || !player || !cue) return;
    if (!player.seeking && cue.end !== undefined && player.currentTime >= cue.end) {
      advance();
    }
    if (active.current) mark(props.cues[index.current]);
  }

  const synchronizeWhilePlaying = useEffectEvent(synchronize);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel narration callbacks when the chapter is replaced.
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      synchronizeWhilePlaying();
      timer = window.setInterval(() => synchronizeWhilePlaying(), 50);
    };
    player.addEventListener("playing", start);
    player.addEventListener("pause", stop);
    return () => {
      active.current = false;
      request.current++;
      stop();
      player.removeEventListener("playing", start);
      player.removeEventListener("pause", stop);
      player.pause();
      highlight.current?.classList.remove("t3-epub-narration-active");
    };
  }, []);

  const toggle = () => {
    if (active.current) return pause();
    const cue = props.cues[index.current];
    if (!cue) return;
    setFailed(false);
    setPlaying(true);
    active.current = true;
    play(cue, true);
  };

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-divider px-3 py-1 max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11">
      <Button size="sm" variant="secondary" onClick={toggle}>
        {playing ? <PauseIcon /> : <HeadphonesIcon />}
        {playing ? gt("Pause narration") : gt("Read aloud")}
      </Button>
      {failed ? (
        <span role="status" className="text-meta">
          {gt("Could not play narration.")}
        </span>
      ) : null}
      <audio
        ref={audio}
        preload="none"
        onTimeUpdate={synchronize}
        onEnded={() => {
          if (!active.current || !audio.current?.ended) return;
          advance();
        }}
      />
    </div>
  );
}
