"use strict";

function createControlSymbol(svg) {
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  if (paths.length === 0) throw new Error("The T3 widget mark has no symbol paths.");
  const sizes = [
    ["S", 696],
    ["M", 1326],
    ["L", 1956],
  ];
  const guides = sizes
    .flatMap(([size, baseline]) =>
      [
        ["Baseline", baseline],
        ["Capline", baseline - 71],
      ].map(([name, y]) => `<line id="${name}-${size}" x1="0" y1="${y}" x2="3300" y2="${y}"/>`),
    )
    .join("");
  const symbols = sizes
    .map(
      ([size, baseline]) =>
        `<g id="Regular-${size}" transform="translate(1393 ${baseline})">${paths
          // Align the mark's ink bounds to the symbol cap height and baseline.
          .map((d) => `<path d="${d}" transform="matrix(1.25 0 0 1.25 -19.413625 -117.45)"/>`)
          .join("")}</g>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="3300" height="2200" viewBox="0 0 3300 2200"><g id="Notes"><text id="template-version">2.0</text></g><g id="Guides">${guides}</g><g id="Symbols">${symbols}</g></svg>\n`;
}

module.exports = { createControlSymbol };
