import { FlagIcon, RotateCcwIcon, TimerIcon, TrophyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../../ui/toggle-group";
import { readGameSave, writeGameSave } from "../entertainmentStore";
import {
  chordCell,
  MINESWEEPER_LEVELS,
  type MinesweeperDifficulty,
  type MinesweeperGame as Game,
  type MinesweeperStats,
  minesRemaining,
  newMinesweeper,
  recordResult,
  revealCell,
  toggleFlag,
} from "./minesweeper.logic";

const NUMBER_COLORS = [
  "",
  "text-sky-400",
  "text-green-400",
  "text-arcade-danger",
  "text-indigo-400",
  "text-amber-500",
  "text-teal-400",
  "text-foreground",
  "text-muted-foreground",
];

function readStats(): MinesweeperStats {
  try {
    const parsed = JSON.parse(readGameSave("minesweeper-stats") ?? "") as MinesweeperStats;
    if (typeof parsed.played === "number" && typeof parsed.won === "number") return parsed;
  } catch {
    // No stats yet.
  }
  return { played: 0, won: 0, best: {} };
}

/** Minesweeper: left click reveals, right click flags, clicking a number with its flags placed clears around it. */
export function MinesweeperGame() {
  const [game, setGame] = useState(() => newMinesweeper("beginner"));
  const [stats, setStats] = useState(readStats);
  const [now, setNow] = useState(() => Date.now());
  const [flagMode, setFlagMode] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the timer display ticks once a second while a game is running
  useEffect(() => {
    if (game.status !== "playing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [game.status]);

  const apply = (next: Game) => {
    if ((next.status === "won" || next.status === "lost") && next.status !== game.status) {
      const updated = recordResult(stats, next);
      setStats(updated);
      writeGameSave("minesweeper-stats", JSON.stringify(updated));
    }
    setGame(next);
  };
  const elapsed =
    game.startedAt === null
      ? 0
      : Math.floor(((game.endedAt ?? Math.max(now, game.startedAt)) - game.startedAt) / 1000);
  const columns = game.columns;
  const cells = game.cells.length > 0 ? game.cells : null;

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <div className="flex w-full max-w-3xl flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Difficulty"
          variant="segmented"
          value={[game.difficulty]}
          onValueChange={(next) => {
            const difficulty = next[0] as MinesweeperDifficulty | undefined;
            if (difficulty && difficulty in MINESWEEPER_LEVELS) setGame(newMinesweeper(difficulty));
          }}
        >
          {(Object.keys(MINESWEEPER_LEVELS) as MinesweeperDifficulty[]).map((difficulty) => (
            <ToggleGroupItem key={difficulty} value={difficulty} size="xs">
              {MINESWEEPER_LEVELS[difficulty].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="flex items-center gap-1 font-mono text-sm tabular-nums">
          <FlagIcon className="size-3.5 text-arcade-danger" /> {minesRemaining(game)}
        </span>
        <span className="flex items-center gap-1 font-mono text-sm tabular-nums">
          <TimerIcon className="size-3.5" /> {elapsed}s
        </span>
        <Button
          size="xs"
          variant={flagMode ? "secondary" : "ghost"}
          aria-pressed={flagMode}
          onClick={() => setFlagMode((value) => !value)}
        >
          <FlagIcon /> Flag mode
        </Button>
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          onClick={() => setGame(newMinesweeper(game.difficulty))}
        >
          <RotateCcwIcon /> New game
        </Button>
      </div>
      <div className="max-w-full overflow-auto rounded-xl border border-white/10 bg-black/40 p-2 shadow-2xl">
        <div
          role="grid"
          aria-label={`Minesweeper, ${MINESWEEPER_LEVELS[game.difficulty].label}`}
          className="grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${columns}, 1.75rem)` }}
        >
          {Array.from({ length: game.rows * game.columns }, (_, index) => {
            const cell = cells?.[index];
            const revealed = cell?.state === "revealed";
            const flagged = cell?.state === "flagged";
            const label = revealed
              ? cell?.mine
                ? "Mine"
                : cell?.adjacent
                  ? String(cell.adjacent)
                  : "Empty"
              : flagged
                ? "Flagged"
                : "Hidden";
            return (
              <button
                key={index}
                type="button"
                role="gridcell"
                aria-label={`Row ${Math.floor(index / columns) + 1}, column ${(index % columns) + 1}: ${label}`}
                className={cn(
                  "flex size-7 items-center justify-center rounded-sm font-bold text-sm transition-colors",
                  revealed
                    ? cell?.mine
                      ? index === game.exploded
                        ? "bg-arcade-mine"
                        : "bg-arcade-mine-dark"
                      : "bg-white/5"
                    : "bg-arcade-tile hover:bg-arcade-tile-hover",
                  revealed && cell && !cell.mine && NUMBER_COLORS[cell.adjacent],
                )}
                onClick={(event) => {
                  const now = Date.now();
                  if (flagMode || event.shiftKey) apply(toggleFlag(game, index));
                  else if (revealed) apply(chordCell(game, index, now));
                  else apply(revealCell(game, index, now));
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  apply(toggleFlag(game, index));
                }}
              >
                {revealed ? (cell?.mine ? "✹" : cell?.adjacent || "") : flagged ? "⚑" : ""}
              </button>
            );
          })}
        </div>
      </div>
      <div className="text-sm" aria-live="polite">
        {game.status === "won"
          ? `Cleared in ${elapsed} seconds!`
          : game.status === "lost"
            ? "Boom. Try again?"
            : "Right click (or Shift+click) to flag."}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-4 text-muted-foreground text-xs">
        <span>
          Played {stats.played} · Won {stats.won}
          {stats.played > 0 ? ` (${Math.round((stats.won / stats.played) * 100)}%)` : ""}
        </span>
        {(Object.keys(MINESWEEPER_LEVELS) as MinesweeperDifficulty[]).map((difficulty) =>
          stats.best[difficulty] !== undefined ? (
            <span key={difficulty} className="flex items-center gap-1">
              <TrophyIcon className="size-3" /> {MINESWEEPER_LEVELS[difficulty].label}{" "}
              {stats.best[difficulty]}s
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
