import { describe, expect, it } from "vite-plus/test";

import {
  buyBuilding,
  buyUpgrade,
  clickCore,
  cyclesPerSecond,
  newClicker,
  parseClickerSave,
  tickClicker,
} from "./circuitClicker.logic";
import {
  chordCell,
  minesRemaining,
  newMinesweeper,
  recordResult,
  revealCell,
  toggleFlag,
} from "./minesweeper.logic";
import { newSnake, queueTurn, stepSnake } from "./snake.logic";

/** Deterministic random numbers for repeatable boards. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe("minesweeper", () => {
  it("never puts a mine under or next to the first click", () => {
    for (let seed = 1; seed < 30; seed += 1) {
      const game = revealCell(newMinesweeper("expert"), 0, 0, seeded(seed));
      expect(game.cells[0]?.mine).toBe(false);
      expect(game.cells[1]?.mine).toBe(false);
      expect(game.cells[30]?.mine).toBe(false);
      expect(game.cells.filter((cell) => cell.mine)).toHaveLength(99);
      expect(game.status).toBe("playing");
    }
  });

  it("flood-fills empty areas, flags, chords, and loses on a mine", () => {
    let game = revealCell(newMinesweeper("beginner"), 40, 0, seeded(7));
    expect(game.cells[40]?.state).toBe("revealed");
    expect(game.cells[40]?.adjacent).toBe(0);
    expect(game.cells.filter((cell) => cell.state === "revealed").length).toBeGreaterThan(1);

    const mine = game.cells.findIndex((cell) => cell.mine);
    game = toggleFlag(game, mine);
    expect(minesRemaining(game)).toBe(9);
    expect(revealCell(game, mine, 1).status).toBe("playing");

    const unflagged = game.cells.findIndex((cell, index) => cell.mine && index !== mine);
    const lost = revealCell(game, unflagged, 5_000);
    expect(lost.status).toBe("lost");
    expect(lost.exploded).toBe(unflagged);
    expect(chordCell(lost, 40, 6_000)).toBe(lost);
  });

  it("wins when every safe cell is revealed and records the best time", () => {
    let game = revealCell(newMinesweeper("beginner"), 0, 1_000, seeded(3));
    game.cells.forEach((cell, index) => {
      if (!cell.mine) game = revealCell(game, index, 31_000);
    });
    expect(game.status).toBe("won");
    expect(minesRemaining(game)).toBe(0);
    const stats = recordResult({ played: 0, won: 0, best: {} }, game);
    expect(stats).toEqual({ played: 1, won: 1, best: { beginner: 30 } });
  });
});

describe("snake", () => {
  it("moves, grows on food, and ends at a wall", () => {
    let game = newSnake(10, 10, false, () => 0);
    game = { ...game, food: { x: 5, y: 5 } };
    game = queueTurn(game, "right");
    expect(game.status).toBe("playing");
    game = stepSnake(game, () => 0);
    expect(game.body[0]).toEqual({ x: 5, y: 5 });
    expect(game.score).toBe(1);
    expect(game.body).toHaveLength(4);
    for (let step = 0; step < 10; step += 1) game = stepSnake(game, () => 0.99);
    expect(game.status).toBe("over");
  });

  it("ignores reversing into itself and wraps when asked", () => {
    let game = queueTurn(
      newSnake(10, 10, true, () => 0),
      "left",
    );
    expect(game.pending).toEqual([]);
    game = {
      ...game,
      body: [
        { x: 9, y: 5 },
        { x: 8, y: 5 },
        { x: 7, y: 5 },
      ],
      food: { x: 0, y: 0 },
    };
    game = stepSnake(game);
    expect(game.body[0]).toEqual({ x: 0, y: 5 });
    expect(game.status).toBe("playing");
  });
});

describe("circuit clicker", () => {
  it("clicks, buys, produces, upgrades, and earns achievements", () => {
    let state = newClicker(0);
    for (let click = 0; click < 30; click += 1) state = clickCore(state);
    expect(state.cycles).toBe(30);
    expect(state.achievements).toContain("hello-world");

    state = buyBuilding(state, "script");
    expect(state.owned.script).toBe(1);
    expect(state.cycles).toBe(15);
    expect(buyBuilding(state, "compiler")).toBe(state);

    state = tickClicker(state, 10_000);
    expect(state.cycles).toBeCloseTo(16);

    state = { ...state, cycles: 500 };
    state = buyUpgrade(state, "mech-keyboard");
    expect(state.upgrades).toEqual(["mech-keyboard"]);
    expect(clickCore(state).cycles - state.cycles).toBeCloseTo(2 + cyclesPerSecond(state) * 0.01);
  });

  it("caps offline progress at eight hours and round-trips saves", () => {
    const state = { ...newClicker(0), owned: { compiler: 1 } };
    expect(tickClicker(state, 24 * 3600 * 1000).cycles).toBe(8 * 3600);
    expect(parseClickerSave(JSON.stringify(state))).toEqual(state);
    expect(parseClickerSave("{bad")).toBeNull();
    expect(parseClickerSave(JSON.stringify({ version: 2 }))).toBeNull();
  });
});
