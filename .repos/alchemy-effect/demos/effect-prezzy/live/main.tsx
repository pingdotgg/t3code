/**
 * The live presenter: the real Remotion compositions played in the browser,
 * stepped like the tcut presenter, and hot-reloaded as you edit.
 *
 *   → / PageDown   play the next step (stops at its end)
 *   ←  / PageUp    play the previous step
 *   Space          pause / resume (replays a finished step)
 *   R              replay this step
 *   Home / End     first / last step
 *   F              presentation mode: fullscreen, video only (F or Esc to leave)
 *
 * The current step lives in the URL hash, so a reload lands on the same step.
 * Opens the agent-loop talk (intro/loop.ts); `?deck=talk` opens the original one.
 */
import { Player, type PlayerRef } from "@remotion/player";
import { StrictMode, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Intro } from "../remotion/intro/Intro.tsx";
import { Scene } from "../remotion/scene/Scene.tsx";
import { Slide } from "../remotion/slides/Slide.tsx";
import { VIDEO } from "../shared/types.ts";
import { loadDeck, type LiveItem, type LiveStep } from "./deck.ts";

type Deck = { items: LiveItem[]; steps: LiveStep[] };

const componentFor = (item: LiveItem) =>
  (item.item.kind === "intro"
    ? Intro
    : item.item.kind === "scene"
      ? Scene
      : Slide) as unknown as ComponentType<Record<string, unknown>>;

const stepFromHash = () => Math.max(0, Number(location.hash.slice(1)) - 1 || 0);

function App() {
  const [deck, setDeck] = useState<Deck>();
  const [index, setIndex] = useState(stepFromHash);
  const [presenting, setPresenting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const player = useRef<PlayerRef>(null);
  /** Whether the current step should start playing once its player is ready. */
  const autoplay = useRef(false);

  const reload = useCallback(
    () => loadDeck(new URLSearchParams(location.search).get("deck") ?? "loop").then(setDeck),
    [],
  );
  useEffect(() => {
    reload();
    // intro.json or a scene.json was rebuilt: reload the data, keep the step.
    import.meta.hot?.on("prezzy:data", reload);
  }, [reload]);

  const step = deck?.steps[Math.min(index, (deck?.steps.length ?? 1) - 1)];
  const item = step ? deck!.items[step.item] : undefined;

  useEffect(() => {
    history.replaceState(null, "", `${location.search}#${index + 1}`);
  }, [index]);

  // Enter a step: play it from the start if we got here with → / ←; otherwise
  // (first load, hot reload) show where it ends, which is what you're editing.
  const settle = useCallback(() => {
    const p = player.current;
    if (!p || !step) return;
    p.pause();
    p.seekTo(step.to - 1);
    setEnded(true);
  }, [step]);
  useEffect(() => {
    const p = player.current;
    if (!p || !step) return;
    if (autoplay.current) {
      setEnded(false);
      p.seekTo(step.from);
      p.play();
    } else {
      settle();
    }
    autoplay.current = false;
  }, [step?.item, step?.from, step?.to, deck]);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // moveToBeginningWhenEnded={false} keeps the last frame; settle() pins it.
    const onEnded = () => {
      setPlaying(false);
      settle();
    };
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onEnded);
    return () => {
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onEnded);
    };
  }, [item, settle]);

  const go = useCallback(
    (next: number, play = true) => {
      if (!deck) return;
      const clamped = Math.max(0, Math.min(deck.steps.length - 1, next));
      autoplay.current = play;
      if (clamped === index) {
        // Same step (first/last): just replay it.
        player.current?.seekTo(deck.steps[clamped]!.from);
        if (play) player.current?.play();
      }
      setIndex(clamped);
    },
    [deck, index],
  );

  useEffect(() => {
    // Esc leaves fullscreen, and with it presentation mode.
    const onChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const state = playing ? "playing" : ended ? "end · → next" : "paused";

  const handleKey = useCallback(
    (key: string) => {
      const p = player.current;
      switch (key) {
        case "ArrowRight":
        case "PageDown":
          go(index + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          go(index - 1);
          break;
        case " ":
          if (ended || !p) go(index);
          else if (p.isPlaying()) p.pause();
          else p.play();
          break;
        case "r":
          go(index);
          break;
        case "Home":
          go(0, false);
          break;
        case "End":
          go(Number.MAX_SAFE_INTEGER, false);
          break;
        case "f":
          // Presentation mode works even where fullscreen is refused (or the browser's own fullscreen is used).
          if (presenting) {
            setPresenting(false);
            if (document.fullscreenElement) document.exitFullscreen();
          } else {
            setPresenting(true);
            document.documentElement.requestFullscreen().catch(() => {});
          }
          break;
        default:
          return false;
      }
      return true;
    },
    [go, index, ended, presenting],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (handleKey(event.key.length === 1 ? event.key.toLowerCase() : event.key))
        event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleKey]);

  if (!deck || !step || !item) return <div className="loading">Loading the deck…</div>;
  return (
    <div className={presenting ? "stage presenting" : "stage"}>
      <div className="player">
        <Player
          ref={player}
          key={item.item.id}
          component={componentFor(item)}
          inputProps={item.inputProps}
          durationInFrames={item.durationInFrames}
          compositionWidth={VIDEO.width}
          compositionHeight={VIDEO.height}
          fps={VIDEO.fps}
          inFrame={step.from}
          outFrame={step.to - 1}
          moveToBeginningWhenEnded={false}
          acknowledgeRemotionLicense
          // Only the presenter's keys control playback.
          spaceKeyToPlayOrPause={false}
          clickToPlay={false}
          doubleClickToFullscreen={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
      <div className="bar">
        <span className="count">
          {index + 1} / {deck.steps.length}
        </span>
        <span className="title">{step.title}</span>
        <span className="state">{state}</span>
        <span className="hint">F to present</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
