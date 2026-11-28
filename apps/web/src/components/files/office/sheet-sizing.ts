export const maximumColumnWidth = 255;
export const maximumRowHeight = (409.5 * 4) / 3;
export const minimumTrackSize = 16;

// BetterOffice's screen geometry uses these digit advances at 96 DPI. Its
// workbook API exposes widths in characters and cell rectangles in pixels.
const digitAdvances = new Map([
  ["arial", 0.5562],
  ["helvetica", 0.5562],
  ["liberation sans", 0.5562],
  ["arimo", 0.5562],
  ["times new roman", 0.5],
  ["liberation serif", 0.5],
  ["tinos", 0.5],
  ["courier new", 0.6001],
  ["liberation mono", 0.6001],
  ["cousine", 0.6001],
  ["cambria", 0.554],
  ["caladea", 0.554],
  ["aptos", 0.534],
  ["verdana", 0.6362],
  ["tahoma", 0.5464],
  ["trebuchet ms", 0.524],
  ["century gothic", 0.554],
  ["arial narrow", 0.456],
  ["consolas", 0.5498],
]);

export function columnDigitWidth(family = "", points = 11) {
  const advance = digitAdvances.get(family.trim().toLowerCase()) ?? 1038 / 2048;
  const size = Number.isFinite(points) && points > 0 ? points : 11;
  return Math.max(1, Math.round(advance * size * (4 / 3)));
}
