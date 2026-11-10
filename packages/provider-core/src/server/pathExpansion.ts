// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// Spawned processes lack shell expansion and would treat literal ~/ paths as relative.
export function expandHomePath(value: string, home: string): string {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(home, value.slice(2));
  }
  return value;
}
