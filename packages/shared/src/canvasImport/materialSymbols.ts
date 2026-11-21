import { isRecord } from "./common.ts";
import { parseSvgPath, serializePath, type PathCommand } from "./svgPath.ts";

type SymbolRegistry = (typeof import("@iconify-json/material-symbols"))["icons"];

export class MaterialSymbolsPaths {
  private readonly commands = new Map<string, PathCommand[] | null>();
  private readonly paths = new Map<string, string>();
  private readonly registry: SymbolRegistry;

  constructor(registry: SymbolRegistry) {
    this.registry = registry;
  }

  get(name: string, width: number, height: number, flipX: boolean, flipY: boolean): string | null {
    const normalized = `${name.toLowerCase().replaceAll("_", "-")}-outline-rounded`;
    const key = `${normalized}:${width}:${height}:${flipX}:${flipY}`;
    const cached = this.paths.get(key);
    if (cached !== undefined) return cached;
    let commands = this.commands.get(normalized);
    if (commands === undefined) {
      let id = normalized;
      const visited = new Set<string>();
      while (this.registry.aliases?.[id]) {
        if (visited.has(id)) return null;
        visited.add(id);
        id = this.registry.aliases[id]!.parent;
      }
      const icon = this.registry.icons[id];
      // This collection uses a single filled path for each rounded symbol.
      const geometry = icon && /^<path fill="currentColor" d="([^"]+)"\/>$/.exec(icon.body)?.[1];
      commands = geometry ? parseSvgPath(geometry) : null;
      this.commands.set(normalized, commands);
    }
    if (!commands) return null;
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

/** Keep the large geometry registry out of imports that do not use this family. */
export async function loadMaterialSymbols(document: unknown): Promise<MaterialSymbolsPaths | null> {
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.toLowerCase() === "material symbols rounded") {
      const { icons } = await import("@iconify-json/material-symbols");
      return new MaterialSymbolsPaths(icons);
    }
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return null;
}
