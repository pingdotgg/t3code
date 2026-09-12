/** @jsxImportSource react */
/**
 * The yantra logo, rasterized at runtime. Geometry mirrors
 * website/src/brand/yantra.ts (the brand's source of truth): a downward
 * equilateral triangle inscribed in a circle, bindu at the center. Rendered
 * as braille dots (2x4 subpixels per cell) via signed distance functions, so
 * it scales to any column width.
 */
import { Box, Text } from "../ui/index.ts";
import { useMemo, type JSX } from "react";
import { theme } from "../../CliKit/index.ts";

const CENTER = 12;
const CIRCLE_R = 9.5;
const BINDU_R = 1.1;
const DOT_THRESHOLD = 0.35;
// stroke thickness in braille subpixels, independent of logo size — keeps the
// outline delicate instead of thickening into solid slabs as the logo grows
const STROKE_SUBPIXELS = 2.5;

const trianglePoints = (
  strokeW: number,
): ReadonlyArray<readonly [number, number]> => {
  const triR = CIRCLE_R - strokeW / 4;
  const triDx = triR * Math.cos(Math.PI / 6);
  const triTopY = CENTER - triR * Math.sin(Math.PI / 6);
  const triApexY = CENTER + triR;
  return [
    [CENTER, triApexY],
    [CENTER - triDx, triTopY],
    [CENTER + triDx, triTopY],
  ];
};

const sdCircleRing = (x: number, y: number, strokeW: number) =>
  Math.abs(Math.hypot(x - CENTER, y - CENTER) - CIRCLE_R) - strokeW / 2;

const sdSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(
    0,
    Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)),
  );
  return Math.hypot(apx - t * abx, apy - t * aby);
};

const sdTriangle = (
  x: number,
  y: number,
  pts: ReadonlyArray<readonly [number, number]>,
  strokeW: number,
) => {
  let d = Infinity;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % 3];
    d = Math.min(d, sdSegment(x, y, ax, ay, bx, by));
  }
  return d - strokeW / 2;
};

const sdBindu = (x: number, y: number) =>
  Math.hypot(x - CENTER, y - CENTER) - BINDU_R;

// braille dot bit per (row 0-3, column 0-1) subpixel
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

interface LogoRun {
  text: string;
  color?: string;
}

const rasterizeLogo = (cols: number): LogoRun[][] => {
  const width = cols * 2; // subpixel grid, square (2 wide x 4 tall per cell)
  const rows = Math.ceil(width / 4);
  const scale = 24 / width;
  const strokeW = STROKE_SUBPIXELS * scale;
  const triPts = trianglePoints(strokeW);
  const lines: LogoRun[][] = [];
  for (let r = 0; r < rows; r++) {
    const runs: LogoRun[] = [];
    const push = (text: string, color?: string) => {
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.text += text;
      else runs.push({ text, color });
    };
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      let strokeSum = 0;
      let binduSum = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const x = (c * 2 + sx + 0.5) * scale;
          const y = (r * 4 + sy + 0.5) * scale;
          const dStroke = Math.min(
            sdCircleRing(x, y, strokeW),
            sdTriangle(x, y, triPts, strokeW),
          );
          const strokeCov = Math.min(1, Math.max(0, 0.5 - dStroke / scale));
          const binduCov = Math.min(
            1,
            Math.max(0, 0.5 - sdBindu(x, y) / scale),
          );
          if (Math.max(strokeCov, binduCov) > DOT_THRESHOLD) {
            bits |= BRAILLE_BITS[sy][sx];
            strokeSum += strokeCov;
            binduSum += binduCov;
          }
        }
      }
      if (bits === 0) push(" ");
      else {
        push(
          String.fromCharCode(0x2800 + bits),
          binduSum > strokeSum ? theme.color.brand : theme.color.accent,
        );
      }
    }
    // drop trailing whitespace runs
    while (runs.length > 0) {
      const last = runs[runs.length - 1];
      if (last.color !== undefined || last.text.trim() !== "") break;
      runs.pop();
    }
    lines.push(runs);
  }
  while (lines.length > 0 && lines[0].length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
};

// Braille rasterization is mojibake on non-Unicode terminals — the help
// formatter skips mounting the logo entirely when Unicode is unavailable.
type LogoProps = { cols: number };

export function Logo({ cols }: LogoProps): JSX.Element | null {
  const lines = useMemo(() => rasterizeLogo(cols), [cols]);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((runs, i) => (
        <Text key={i}>
          {runs.length === 0
            ? " "
            : runs.map((run, j) => (
                <Text key={j} color={run.color}>
                  {run.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}
