export type MinesweeperDifficulty = "beginner" | "intermediate" | "expert";

export const MINESWEEPER_LEVELS: Record<
  MinesweeperDifficulty,
  {
    readonly label: string;
    readonly rows: number;
    readonly columns: number;
    readonly mines: number;
  }
> = {
  beginner: { label: "Beginner", rows: 9, columns: 9, mines: 10 },
  intermediate: { label: "Intermediate", rows: 16, columns: 16, mines: 40 },
  expert: { label: "Expert", rows: 16, columns: 30, mines: 99 },
};

export interface MinesweeperCell {
  readonly mine: boolean;
  readonly adjacent: number;
  readonly state: "hidden" | "revealed" | "flagged";
}

export interface MinesweeperGame {
  readonly difficulty: MinesweeperDifficulty;
  readonly rows: number;
  readonly columns: number;
  readonly mines: number;
  /** Empty until the first reveal, so the first click is never a mine. */
  readonly cells: ReadonlyArray<MinesweeperCell>;
  readonly status: "ready" | "playing" | "won" | "lost";
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The mine that ended a lost game. */
  readonly exploded: number | null;
}

export function newMinesweeper(difficulty: MinesweeperDifficulty): MinesweeperGame {
  const level = MINESWEEPER_LEVELS[difficulty];
  return {
    difficulty,
    rows: level.rows,
    columns: level.columns,
    mines: level.mines,
    cells: [],
    status: "ready",
    startedAt: null,
    endedAt: null,
    exploded: null,
  };
}

function neighbors(game: Pick<MinesweeperGame, "rows" | "columns">, index: number): number[] {
  const row = Math.floor(index / game.columns);
  const column = index % game.columns;
  const result: number[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = column + dc;
      if (r >= 0 && r < game.rows && c >= 0 && c < game.columns) result.push(r * game.columns + c);
    }
  }
  return result;
}

/** Places mines away from the first click and its neighbors. `random` returns [0, 1). */
function layMines(
  game: MinesweeperGame,
  safeIndex: number,
  random: () => number,
): MinesweeperCell[] {
  const total = game.rows * game.columns;
  const safe = new Set([safeIndex, ...neighbors(game, safeIndex)]);
  const candidates = Array.from({ length: total }, (_, index) => index).filter(
    (index) => !safe.has(index),
  );
  // Small boards may not fit the full safe area; fall back to protecting only the clicked cell.
  const pool =
    candidates.length >= game.mines
      ? candidates
      : Array.from({ length: total }, (_, index) => index).filter((index) => index !== safeIndex);
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }
  const mines = new Set(pool.slice(0, game.mines));
  return Array.from({ length: total }, (_, index) => ({
    mine: mines.has(index),
    adjacent: neighbors(game, index).filter((neighbor) => mines.has(neighbor)).length,
    state: "hidden" as const,
  }));
}

function finish(game: MinesweeperGame, cells: MinesweeperCell[], now: number): MinesweeperGame {
  const won = cells.every((cell) => cell.mine || cell.state === "revealed");
  if (!won) return { ...game, cells };
  return {
    ...game,
    cells: cells.map((cell) => (cell.mine ? { ...cell, state: "flagged" as const } : cell)),
    status: "won",
    endedAt: now,
  };
}

export function revealCell(
  game: MinesweeperGame,
  index: number,
  now: number,
  random: () => number = Math.random,
): MinesweeperGame {
  if (game.status === "won" || game.status === "lost") return game;
  let current = game;
  if (current.status === "ready") {
    current = {
      ...current,
      cells: layMines(current, index, random),
      status: "playing",
      startedAt: now,
    };
  }
  const target = current.cells[index];
  if (!target || target.state !== "hidden") return current;
  const cells = [...current.cells];
  if (target.mine) {
    return {
      ...current,
      cells: cells.map((cell) =>
        cell.mine && cell.state !== "flagged" ? { ...cell, state: "revealed" as const } : cell,
      ),
      status: "lost",
      endedAt: now,
      exploded: index,
    };
  }
  const queue = [index];
  while (queue.length > 0) {
    const next = queue.pop()!;
    const cell = cells[next]!;
    if (cell.state !== "hidden" || cell.mine) continue;
    cells[next] = { ...cell, state: "revealed" };
    if (cell.adjacent === 0) queue.push(...neighbors(current, next));
  }
  return finish(current, cells, now);
}

export function toggleFlag(game: MinesweeperGame, index: number): MinesweeperGame {
  if (game.status !== "playing") return game;
  const cell = game.cells[index];
  if (!cell || cell.state === "revealed") return game;
  const cells = [...game.cells];
  cells[index] = { ...cell, state: cell.state === "flagged" ? "hidden" : "flagged" };
  return { ...game, cells };
}

/** Reveals a number's neighbors when it already has that many flags around it. */
export function chordCell(game: MinesweeperGame, index: number, now: number): MinesweeperGame {
  const cell = game.cells[index];
  if (game.status !== "playing" || !cell || cell.state !== "revealed" || cell.adjacent === 0) {
    return game;
  }
  const around = neighbors(game, index);
  const flags = around.filter((neighbor) => game.cells[neighbor]?.state === "flagged").length;
  if (flags !== cell.adjacent) return game;
  let next = game;
  for (const neighbor of around) next = revealCell(next, neighbor, now);
  return next;
}

export function minesRemaining(game: MinesweeperGame): number {
  return game.mines - game.cells.filter((cell) => cell.state === "flagged").length;
}

export interface MinesweeperStats {
  readonly played: number;
  readonly won: number;
  /** Best winning time in seconds per difficulty. */
  readonly best: Partial<Record<MinesweeperDifficulty, number>>;
}

export function recordResult(stats: MinesweeperStats, game: MinesweeperGame): MinesweeperStats {
  if (game.status !== "won" && game.status !== "lost") return stats;
  const seconds =
    game.startedAt !== null && game.endedAt !== null
      ? Math.max(1, Math.round((game.endedAt - game.startedAt) / 1000))
      : null;
  const previous = stats.best[game.difficulty];
  return {
    played: stats.played + 1,
    won: stats.won + (game.status === "won" ? 1 : 0),
    best:
      game.status === "won" && seconds !== null && (previous === undefined || seconds < previous)
        ? { ...stats.best, [game.difficulty]: seconds }
        : stats.best,
  };
}
