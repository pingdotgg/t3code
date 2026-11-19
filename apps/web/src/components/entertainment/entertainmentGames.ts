interface EntertainmentGame {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly script: string;
}

export const ARCADE_GAMES = [
  {
    id: "signal-weave",
    title: "Signal Weave",
    description: "Flip a tile and its neighbors to switch every light off.",
    script: `
      const tiles = Array.from({ length: 25 }, (_, index) => ({
        row: Math.floor(index / 5),
        column: index % 5,
        lit: false,
      }));
      let moves = 0;
      function toggle(index) {
        const selected = tiles[index];
        for (const tile of tiles) {
          if (Math.abs(tile.row - selected.row) + Math.abs(tile.column - selected.column) <= 1) tile.lit = !tile.lit;
        }
      }
      function start() {
        for (const tile of tiles) tile.lit = false;
        for (const index of [1, 7, 13, 15, 22]) toggle(index);
        moves = 0;
        draw();
      }
      function draw() {
        const won = tiles.every(tile => !tile.lit);
        status.textContent = won ? 'Signal cleared in ' + moves + ' moves.' : 'Moves: ' + moves;
        board.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
        tiles.forEach((tile, index) => {
          const button = board.children[index] ?? board.appendChild(document.createElement('button'));
          button.textContent = tile.lit ? '●' : '○';
          button.setAttribute('aria-label', 'Row ' + (tile.row + 1) + ', column ' + (tile.column + 1));
          button.setAttribute('aria-pressed', String(tile.lit));
          button.disabled = won;
          button.onclick = () => { toggle(index); moves += 1; draw(); };
        });
      }
      reset.onclick = start;
      start();
    `,
  },
  {
    id: "orbit-freight",
    title: "Orbit Freight",
    description: "Collect all three cargo crates and reach the depot before fuel runs out.",
    script: `
      const cargo = new Set([2, 7, 20]);
      const debris = new Set([6, 8, 11, 18]);
      let position, fuel, remaining;
      function start() {
        position = 0;
        fuel = 16;
        remaining = new Set(cargo);
        draw();
      }
      function canMove(index) {
        return !debris.has(index) && Math.abs(Math.floor(index / 5) - Math.floor(position / 5)) + Math.abs(index % 5 - position % 5) === 1;
      }
      function draw() {
        const won = position === 24 && remaining.size === 0;
        status.textContent = won ? 'Delivery complete!' : fuel === 0 ? 'Out of fuel. Try another route.' : 'Fuel: ' + fuel + ' · Cargo left: ' + remaining.size;
        board.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
        for (let index = 0; index < 25; index++) {
          const button = board.children[index] ?? board.appendChild(document.createElement('button'));
          const tile = index === position ? 'Ship' : index === 24 ? 'Depot' : remaining.has(index) ? 'Crate' : debris.has(index) ? 'Debris' : 'Space';
          button.textContent = { Ship: '◆', Depot: '⌂', Crate: '▣', Debris: '×', Space: '·' }[tile];
          button.setAttribute('aria-label', tile + ', row ' + (Math.floor(index / 5) + 1) + ', column ' + (index % 5 + 1));
          button.disabled = won || fuel === 0 || !canMove(index);
          button.setAttribute('aria-current', String(index === position));
          button.onclick = () => { position = index; fuel -= 1; remaining.delete(index); draw(); };
        }
      }
      reset.onclick = start;
      start();
    `,
  },
  {
    id: "tempo-relay",
    title: "Tempo Relay",
    description: "Hit the highlighted beat ten times in a row. A wrong beat breaks the streak.",
    script: `
      let target = 0;
      let count = 0;
      let started = 0;
      function start() {
        target = Math.floor(Math.random() * 9);
        count = 0;
        started = 0;
        draw('');
      }
      function draw(message) {
        status.textContent = message || 'Streak: ' + count + ' / 10';
        board.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
        for (let index = 0; index < 9; index++) {
          const button = board.children[index] ?? board.appendChild(document.createElement('button'));
          button.textContent = String(index + 1);
          button.setAttribute('aria-pressed', String(index === target && count < 10));
          button.disabled = count === 10;
          button.onclick = () => {
            if (index !== target) { start(); draw('Missed beat. Streak reset.'); return; }
            if (count === 0) started = performance.now();
            count += 1;
            target = (index + Math.floor(Math.random() * 8) + 1) % 9;
            draw(count === 10 ? 'Ten beats in ' + ((performance.now() - started) / 1000).toFixed(2) + ' seconds.' : '');
          };
        }
      }
      reset.onclick = start;
      start();
    `,
  },
] as const satisfies ReadonlyArray<EntertainmentGame>;

export function gameDocument(game: EntertainmentGame): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${game.title}</title>
<style>
  :root{color-scheme:light dark;font:14px system-ui,sans-serif}
  body{margin:0;padding:16px;background:Canvas;color:CanvasText}
  h1{margin:0;font-size:1.2rem} p{margin:8px 0} #board{display:grid;gap:4px;margin:12px 0;max-width:28rem}
  button{border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;cursor:pointer;padding:.45rem}
  #board button{aspect-ratio:1;min-height:var(--size,32px);font-size:1.1rem}
  button[aria-pressed=true],button[aria-current=true]{background:#2666dc;color:white}
  button:disabled:not([aria-current=true]){opacity:.5;cursor:default}
  button:focus-visible{outline:2px solid #3074f2;outline-offset:1px}
</style>
</head>
<body>
  <h1>${game.title}</h1>
  <p>${game.description}</p>
  <p id="status" aria-live="polite"></p>
  <section id="board" aria-label="Game board"></section>
  <button id="reset" type="button">Restart</button>
  <script>
    const status = document.getElementById('status');
    const board = document.getElementById('board');
    const reset = document.getElementById('reset');
    ${game.script}
  </script>
</body>
</html>`;
}
