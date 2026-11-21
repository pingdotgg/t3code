/**
 * Small SVG path normalizer: parses path data into absolute M/L/C/Q/Z
 * commands (arcs become cubics), so imported geometry can be measured and
 * mapped into a node's local box.
 */

export type PathCommand =
  | { type: "M" | "L"; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Q"; x1: number; y1: number; x: number; y: number }
  | { type: "Z" };

type Point = { x: number; y: number };
type CubicCommand = Extract<PathCommand, { type: "C" }>;

const ARG_COUNTS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

/** Cursor over path data; flags are read one character at a time ("a1 1 0 011 1"). */
class PathReader {
  index = 0;
  readonly d: string;
  constructor(d: string) {
    this.d = d;
  }

  private skip(): void {
    while (this.index < this.d.length && /[\s,]/.test(this.d[this.index]!)) this.index++;
  }

  done(): boolean {
    this.skip();
    return this.index >= this.d.length;
  }

  command(): string | null {
    this.skip();
    const char = this.d[this.index];
    if (char && /[MLHVCSQTAZ]/i.test(char)) {
      this.index++;
      return char;
    }
    return null;
  }

  number(): number | null {
    this.skip();
    const match = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
    match.lastIndex = this.index;
    const result = match.exec(this.d);
    if (!result) return null;
    this.index = match.lastIndex;
    return Number(result[0]);
  }

  flag(): number | null {
    this.skip();
    const char = this.d[this.index];
    if (char !== "0" && char !== "1") return null;
    this.index++;
    return char === "1" ? 1 : 0;
  }
}

function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angle: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
): PathCommand[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ type: "L", x: x2, y: y2 }];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const vectorAngle = (ux: number, uy: number, vx: number, vy: number) => {
    const value = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return value;
  };
  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = vectorAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (theta: number) => ({
    x: cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    y: cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  });
  const derivative = (theta: number) => ({
    x: -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    y: -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos,
  });
  const result: PathCommand[] = [];
  let theta = theta1;
  for (let i = 0; i < segments; i++) {
    const next = theta + step;
    const start = point(theta);
    const end = point(next);
    const d1 = derivative(theta);
    const d2 = derivative(next);
    result.push({
      type: "C",
      x1: start.x + k * d1.x,
      y1: start.y + k * d1.y,
      x2: end.x - k * d2.x,
      y2: end.y - k * d2.y,
      x: i === segments - 1 ? x2 : end.x,
      y: i === segments - 1 ? y2 : end.y,
    });
    theta = next;
  }
  return result;
}

/** Parses SVG path data into absolute commands, or null when it is malformed. */
export function parseSvgPath(d: string): PathCommand[] | null {
  const reader = new PathReader(d);
  const commands: PathCommand[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl: Point | null = null;
  let lastType = "";
  let command = "";
  while (!reader.done()) {
    const next = reader.command();
    if (next) {
      command = next;
      if (command === "Z" || command === "z") {
        commands.push({ type: "Z" });
        x = startX;
        y = startY;
        lastType = "Z";
        lastControl = null;
        continue;
      }
    } else if (!command || command === "Z" || command === "z") {
      return null;
    }
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const count = ARG_COUNTS[upper];
    if (count === undefined) return null;
    const args: number[] = [];
    for (let i = 0; i < count; i++) {
      const value = upper === "A" && (i === 3 || i === 4) ? reader.flag() : reader.number();
      if (value === null) return null;
      args.push(value);
    }
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (upper) {
      case "M":
        x = args[0]! + ox;
        y = args[1]! + oy;
        startX = x;
        startY = y;
        commands.push({ type: "M", x, y });
        // Extra coordinate pairs after a moveto are linetos.
        command = relative ? "l" : "L";
        lastControl = null;
        break;
      case "L":
        x = args[0]! + ox;
        y = args[1]! + oy;
        commands.push({ type: "L", x, y });
        lastControl = null;
        break;
      case "H":
        x = args[0]! + ox;
        commands.push({ type: "L", x, y });
        lastControl = null;
        break;
      case "V":
        y = args[0]! + oy;
        commands.push({ type: "L", x, y });
        lastControl = null;
        break;
      case "C": {
        const c = {
          type: "C" as const,
          x1: args[0]! + ox,
          y1: args[1]! + oy,
          x2: args[2]! + ox,
          y2: args[3]! + oy,
          x: args[4]! + ox,
          y: args[5]! + oy,
        };
        commands.push(c);
        lastControl = { x: c.x2, y: c.y2 };
        x = c.x;
        y = c.y;
        break;
      }
      case "S": {
        const reflected: Point =
          lastControl && (lastType === "C" || lastType === "S")
            ? { x: 2 * x - lastControl.x, y: 2 * y - lastControl.y }
            : { x, y };
        const c: CubicCommand = {
          type: "C",
          x1: reflected.x,
          y1: reflected.y,
          x2: args[0]! + ox,
          y2: args[1]! + oy,
          x: args[2]! + ox,
          y: args[3]! + oy,
        };
        commands.push(c);
        lastControl = { x: c.x2, y: c.y2 };
        x = c.x;
        y = c.y;
        break;
      }
      case "Q": {
        const q = {
          type: "Q" as const,
          x1: args[0]! + ox,
          y1: args[1]! + oy,
          x: args[2]! + ox,
          y: args[3]! + oy,
        };
        commands.push(q);
        lastControl = { x: q.x1, y: q.y1 };
        x = q.x;
        y = q.y;
        break;
      }
      case "T": {
        const control: Point =
          lastControl && (lastType === "Q" || lastType === "T")
            ? { x: 2 * x - lastControl.x, y: 2 * y - lastControl.y }
            : { x, y };
        const q = {
          type: "Q" as const,
          x1: control.x,
          y1: control.y,
          x: args[0]! + ox,
          y: args[1]! + oy,
        };
        commands.push(q);
        lastControl = control;
        x = q.x;
        y = q.y;
        break;
      }
      case "A": {
        const endX = args[5]! + ox;
        const endY = args[6]! + oy;
        commands.push(
          ...arcToCubics(x, y, args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, endX, endY),
        );
        x = endX;
        y = endY;
        lastControl = null;
        break;
      }
    }
    lastType = upper;
  }
  return commands;
}

/** Bounds of all points including control points (a close upper bound of the curve). */
export function pathBounds(commands: ReadonlyArray<PathCommand>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const command of commands) {
    if (command.type === "Z") continue;
    add(command.x, command.y);
    if (command.type === "C") {
      add(command.x1, command.y1);
      add(command.x2, command.y2);
    } else if (command.type === "Q") {
      add(command.x1, command.y1);
    }
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

const fmt = (value: number) => String(Math.round(value * 100) / 100);

/** Serializes commands after mapping each point through `map`. */
export function serializePath(
  commands: ReadonlyArray<PathCommand>,
  map: (x: number, y: number) => [number, number] = (x, y) => [x, y],
): string {
  const point = (x: number, y: number) => {
    const [px, py] = map(x, y);
    return `${fmt(px)} ${fmt(py)}`;
  };
  return commands
    .map((command) => {
      switch (command.type) {
        case "Z":
          return "Z";
        case "M":
        case "L":
          return `${command.type}${point(command.x, command.y)}`;
        case "C":
          return `C${point(command.x1, command.y1)} ${point(command.x2, command.y2)} ${point(command.x, command.y)}`;
        case "Q":
          return `Q${point(command.x1, command.y1)} ${point(command.x, command.y)}`;
      }
    })
    .join("");
}

type SubPath = { commands: PathCommand[]; closed: boolean };

function splitSubPaths(commands: ReadonlyArray<PathCommand>): SubPath[] {
  const result: SubPath[] = [];
  let current: SubPath | null = null;
  for (const command of commands) {
    if (command.type === "M") {
      current = { commands: [command], closed: false };
      result.push(current);
    } else if (command.type === "Z") {
      if (current) current.closed = true;
      current = null;
    } else {
      if (!current) {
        // Drawing after Z continues from the subpath start; keep it as its own subpath.
        const last = result.at(-1)?.commands[0];
        current = { commands: [last ?? { type: "M", x: 0, y: 0 }], closed: false };
        result.push(current);
      }
      current.commands.push(command);
    }
  }
  return result;
}

/** Endpoints plus curve midpoints, enough for orientation and containment tests. */
function outline(subPath: SubPath): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  for (const command of subPath.commands) {
    if (command.type === "Z") continue;
    if (command.type === "C") {
      const t = 0.5;
      const mt = 1 - t;
      points.push([
        mt ** 3 * x +
          3 * mt * mt * t * command.x1 +
          3 * mt * t * t * command.x2 +
          t ** 3 * command.x,
        mt ** 3 * y +
          3 * mt * mt * t * command.y1 +
          3 * mt * t * t * command.y2 +
          t ** 3 * command.y,
      ]);
    } else if (command.type === "Q") {
      points.push([
        0.25 * x + 0.5 * command.x1 + 0.25 * command.x,
        0.25 * y + 0.5 * command.y1 + 0.25 * command.y,
      ]);
    }
    points.push([command.x, command.y]);
    x = command.x;
    y = command.y;
  }
  return points;
}

const signedArea = (points: ReadonlyArray<[number, number]>) => {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
};

function contains(polygon: ReadonlyArray<[number, number]>, [px, py]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function reverseSubPath(subPath: SubPath): PathCommand[] {
  const commands = subPath.commands;
  const points = commands.map((command) =>
    command.type === "Z" ? null : { x: command.x, y: command.y },
  );
  const last = points.at(-1)!;
  const reversed: PathCommand[] = [{ type: "M", x: last.x, y: last.y }];
  for (let i = commands.length - 1; i >= 1; i--) {
    const command = commands[i]!;
    const previous = points[i - 1]!;
    if (command.type === "C") {
      reversed.push({
        type: "C",
        x1: command.x2,
        y1: command.y2,
        x2: command.x1,
        y2: command.y1,
        x: previous.x,
        y: previous.y,
      });
    } else if (command.type === "Q") {
      reversed.push({ type: "Q", x1: command.x1, y1: command.y1, x: previous.x, y: previous.y });
    } else {
      reversed.push({ type: "L", x: previous.x, y: previous.y });
    }
  }
  if (subPath.closed) reversed.push({ type: "Z" });
  return reversed;
}

/**
 * Rewrites an even-odd path so it fills the same under the nonzero rule:
 * each subpath gets an orientation that alternates with its nesting depth.
 * Exact for nested, non-intersecting subpaths (icons, outlines, rings).
 */
export function evenOddToNonzero(commands: ReadonlyArray<PathCommand>): PathCommand[] {
  const subPaths = splitSubPaths(commands);
  if (subPaths.length < 2) return [...commands];
  const outlines = subPaths.map(outline);
  const result: PathCommand[] = [];
  subPaths.forEach((subPath, index) => {
    const own = outlines[index]!;
    const probe = own[0];
    let depth = 0;
    if (probe) {
      outlines.forEach((other, otherIndex) => {
        if (otherIndex !== index && other.length > 2 && contains(other, probe)) depth++;
      });
    }
    const clockwise = signedArea(own) > 0;
    const wantClockwise = depth % 2 === 0;
    if (clockwise === wantClockwise || own.length < 3) {
      result.push(...subPath.commands);
      if (subPath.closed) result.push({ type: "Z" });
    } else {
      result.push(...reverseSubPath(subPath));
    }
  });
  return result;
}
