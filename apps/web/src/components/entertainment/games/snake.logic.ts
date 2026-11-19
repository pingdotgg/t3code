export type SnakeDirection = "up" | "down" | "left" | "right";

export interface SnakePoint {
  readonly x: number;
  readonly y: number;
}

export interface SnakeGame {
  readonly width: number;
  readonly height: number;
  /** Head first. */
  readonly body: ReadonlyArray<SnakePoint>;
  readonly direction: SnakeDirection;
  /** Turns queued between ticks, so fast double taps both count. */
  readonly pending: ReadonlyArray<SnakeDirection>;
  readonly food: SnakePoint;
  readonly score: number;
  readonly status: "ready" | "playing" | "paused" | "over";
  /** Walls end the game; with `wrap` the snake comes out the other side. */
  readonly wrap: boolean;
}

const DELTAS: Record<SnakeDirection, SnakePoint> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

function placeFood(
  width: number,
  height: number,
  body: ReadonlyArray<SnakePoint>,
  random: () => number,
): SnakePoint {
  const occupied = new Set(body.map((point) => `${point.x},${point.y}`));
  const free: SnakePoint[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  return free[Math.floor(random() * free.length)] ?? { x: 0, y: 0 };
}

export function newSnake(
  width = 20,
  height = 16,
  wrap = false,
  random: () => number = Math.random,
): SnakeGame {
  const y = Math.floor(height / 2);
  const body = [
    { x: 4, y },
    { x: 3, y },
    { x: 2, y },
  ];
  return {
    width,
    height,
    body,
    direction: "right",
    pending: [],
    food: placeFood(width, height, body, random),
    score: 0,
    status: "ready",
    wrap,
  };
}

export function queueTurn(game: SnakeGame, direction: SnakeDirection): SnakeGame {
  if (game.status === "over") return game;
  const last = game.pending.at(-1) ?? game.direction;
  if (direction === last || direction === OPPOSITE[last] || game.pending.length >= 2) {
    return game.status === "ready" ? { ...game, status: "playing" } : game;
  }
  return {
    ...game,
    pending: [...game.pending, direction],
    status: game.status === "ready" ? "playing" : game.status,
  };
}

export function stepSnake(game: SnakeGame, random: () => number = Math.random): SnakeGame {
  if (game.status !== "playing") return game;
  const [next, ...rest] = game.pending;
  const direction = next ?? game.direction;
  const delta = DELTAS[direction];
  const head = game.body[0]!;
  let target = { x: head.x + delta.x, y: head.y + delta.y };
  if (game.wrap) {
    target = {
      x: (target.x + game.width) % game.width,
      y: (target.y + game.height) % game.height,
    };
  } else if (target.x < 0 || target.y < 0 || target.x >= game.width || target.y >= game.height) {
    return { ...game, direction, pending: rest, status: "over" };
  }
  const eats = target.x === game.food.x && target.y === game.food.y;
  // The tail moves away this tick unless the snake grows, so stepping onto it is allowed.
  const body = eats ? game.body : game.body.slice(0, -1);
  if (body.some((point) => point.x === target.x && point.y === target.y)) {
    return { ...game, direction, pending: rest, status: "over" };
  }
  const grown = [target, ...body];
  return {
    ...game,
    body: grown,
    direction,
    pending: rest,
    food: eats ? placeFood(game.width, game.height, grown, random) : game.food,
    score: eats ? game.score + 1 : game.score,
  };
}

/** Milliseconds per move; the snake speeds up as it grows. */
export function snakeTickMs(game: SnakeGame): number {
  return Math.max(60, 140 - game.score * 3);
}
