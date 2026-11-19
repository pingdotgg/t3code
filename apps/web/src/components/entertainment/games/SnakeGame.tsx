import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { readGameSave, writeGameSave } from "../entertainmentStore";
import {
  newSnake,
  queueTurn,
  type SnakeDirection,
  type SnakeGame as SnakeGameState,
  snakeTickMs,
  stepSnake,
} from "./snake.logic";

const KEYS: Record<string, SnakeDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

function readBest(): number {
  const value = Number(readGameSave("snake-best"));
  return Number.isFinite(value) ? value : 0;
}

function draw(canvas: HTMLCanvasElement, game: SnakeGameState) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const cell = canvas.width / game.width;
  context.fillStyle = "#0b1220";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(255,255,255,0.03)";
  for (let y = 0; y < game.height; y += 1) {
    for (let x = y % 2; x < game.width; x += 2) context.fillRect(x * cell, y * cell, cell, cell);
  }
  context.fillStyle = "#f43f5e";
  context.beginPath();
  context.arc((game.food.x + 0.5) * cell, (game.food.y + 0.5) * cell, cell * 0.36, 0, Math.PI * 2);
  context.fill();
  game.body.forEach((point, index) => {
    const shade = Math.max(0.45, 1 - index / (game.body.length * 1.4));
    context.fillStyle = index === 0 ? "#4ade80" : `rgba(34,197,94,${shade})`;
    const inset = index === 0 ? 1 : 2;
    context.beginPath();
    context.roundRect(
      point.x * cell + inset,
      point.y * cell + inset,
      cell - inset * 2,
      cell - inset * 2,
      cell * 0.25,
    );
    context.fill();
  });
}

/** Continuum's own Snake: arrow keys or WASD, Space pauses, best score kept on this device. */
export function SnakeGame({ visible }: { readonly visible: boolean }) {
  const [wrap, setWrap] = useState(false);
  const [game, setGame] = useState(() => newSnake(20, 16, false));
  const [best, setBest] = useState(readBest);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const tick = useEffectEvent(() => {
    setGame((current) => {
      const next = stepSnake(current);
      if (next.status === "over" && next.score > best) {
        writeGameSave("snake-best", String(next.score));
        setBest(next.score);
      }
      return next;
    });
  });

  const tickMs = snakeTickMs(game);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the game loop runs on a timer only while playing and visible
  useEffect(() => {
    if (game.status !== "playing" || !visible) return;
    const timer = window.setInterval(() => tick(), tickMs);
    return () => window.clearInterval(timer);
  }, [game.status, tickMs, visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the canvas, an imperative surface outside React
  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, game);
  }, [game]);

  const restart = (nextWrap = wrap) => setGame(newSnake(20, 16, nextWrap));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === " ") {
      event.preventDefault();
      setGame((current) =>
        current.status === "playing"
          ? { ...current, status: "paused" }
          : current.status === "paused"
            ? { ...current, status: "playing" }
            : current,
      );
      return;
    }
    if (event.key === "Enter" && game.status === "over") {
      restart();
      return;
    }
    const direction = KEYS[event.key];
    if (direction) {
      event.preventDefault();
      setGame((current) => queueTurn(current, direction));
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <div className="flex w-full max-w-xl items-center gap-3 text-sm">
        <span className="font-semibold tabular-nums">Score {game.score}</span>
        <span className="text-muted-foreground tabular-nums">Best {best}</span>
        <label className="ms-auto flex items-center gap-2 text-muted-foreground text-xs">
          Wrap around walls
          <Switch
            checked={wrap}
            onCheckedChange={(checked) => {
              setWrap(checked);
              restart(checked);
            }}
          />
        </label>
      </div>
      <div className="relative w-full max-w-xl">
        <canvas
          ref={canvasRef}
          width={600}
          height={480}
          tabIndex={0}
          role="application"
          aria-label="Snake. Use the arrow keys or W A S D to steer and Space to pause."
          onKeyDown={onKeyDown}
          className="aspect-[5/4] w-full rounded-xl border border-white/10 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        />
        {game.status !== "playing" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/55 text-white">
            <div className="font-semibold text-2xl">
              {game.status === "over" ? "Game over" : game.status === "paused" ? "Paused" : "Snake"}
            </div>
            <div className="text-sm text-white/70">
              {game.status === "over"
                ? `You scored ${game.score}.`
                : "Arrow keys or WASD to move. Space pauses."}
            </div>
            <Button
              onClick={() => {
                if (game.status === "over") restart();
                else setGame((current) => ({ ...current, status: "playing" }));
                canvasRef.current?.focus();
              }}
            >
              {game.status === "over" ? <RotateCcwIcon /> : <PlayIcon />}
              {game.status === "over"
                ? "Play again"
                : game.status === "paused"
                  ? "Resume"
                  : "Start"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        <span />
        <Button
          variant="outline"
          aria-label="Up"
          onClick={() => setGame((g) => queueTurn(g, "up"))}
        >
          ↑
        </Button>
        <span />
        <Button
          variant="outline"
          aria-label="Left"
          onClick={() => setGame((g) => queueTurn(g, "left"))}
        >
          ←
        </Button>
        <Button
          variant="outline"
          aria-label="Pause"
          onClick={() => setGame((g) => (g.status === "playing" ? { ...g, status: "paused" } : g))}
        >
          <PauseIcon />
        </Button>
        <Button
          variant="outline"
          aria-label="Right"
          onClick={() => setGame((g) => queueTurn(g, "right"))}
        >
          →
        </Button>
        <span />
        <Button
          variant="outline"
          aria-label="Down"
          onClick={() => setGame((g) => queueTurn(g, "down"))}
        >
          ↓
        </Button>
      </div>
    </div>
  );
}
