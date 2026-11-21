import { icons, type IconNode } from "lucide";

import { parseSvgPath, serializePath, type PathCommand } from "./svgPath.ts";

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const registry = new Map(Object.entries(icons).map(([name, icon]) => [normalizeName(name), icon]));

/** Lucide's full geometry registry, including aliases, without a DOM or icon font. */
function elementPath([tag, attributes]: IconNode[number]): string | null {
  const n = (key: string, fallback = 0) => Number(attributes[key] ?? fallback);
  switch (tag) {
    case "path":
      return String(attributes.d ?? "");
    case "line":
      return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
    case "polyline":
    case "polygon": {
      const points = String(attributes.points ?? "")
        .trim()
        .split(/[\s,]+/);
      return `M${points.slice(0, 2).join(" ")}L${points.slice(2).join(" ")}${tag === "polygon" ? "Z" : ""}`;
    }
    case "circle":
    case "ellipse": {
      const cx = n("cx");
      const cy = n("cy");
      const rx = n(tag === "circle" ? "r" : "rx");
      const ry = n(tag === "circle" ? "r" : "ry");
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}Z`;
    }
    case "rect": {
      const x = n("x");
      const y = n("y");
      const w = n("width");
      const h = n("height");
      const rx = Math.min(w / 2, n("rx", n("ry")));
      const ry = Math.min(h / 2, n("ry", n("rx")));
      if (!rx || !ry) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    default:
      return null;
  }
}

/** Repeated component instances share conversion work; caches live for one import. */
export class LucidePaths {
  private readonly commands = new Map<string, PathCommand[] | null>();
  private readonly paths = new Map<string, string>();

  get(name: string, width: number, height: number, flipX: boolean, flipY: boolean): string | null {
    const normalized = normalizeName(name);
    const key = `${normalized}:${width}:${height}:${flipX}:${flipY}`;
    const cached = this.paths.get(key);
    if (cached !== undefined) return cached;
    let commands = this.commands.get(normalized);
    if (commands === undefined) {
      const icon = registry.get(normalized);
      if (!icon) return null;
      // Each SVG element has its own origin, including relative initial moves.
      const parts = icon.map((element) => {
        const path = elementPath(element);
        return path === null ? null : parseSvgPath(path);
      });
      commands = parts.some((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
      this.commands.set(normalized, commands);
    }
    if (!commands) return null;
    // SVG's default xMidYMid meet keeps non-square icon boxes undistorted.
    const scale = Math.min(width, height) / 24;
    const offsetX = (width - 24 * scale) / 2;
    const offsetY = (height - 24 * scale) / 2;
    const path = serializePath(commands, (x, y) => [
      offsetX + (flipX ? 24 - x : x) * scale,
      offsetY + (flipY ? 24 - y : y) * scale,
    ]);
    this.paths.set(key, path);
    return path;
  }
}
