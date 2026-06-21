// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "./hostProcess.ts";

export function readAdvertisementFilenames(dir: string): string[] {
  try {
    return NodeFS.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function writeAdvertisementJson(input: {
  readonly dir: string;
  readonly targetPath: string;
  readonly id: string;
  readonly value: unknown;
}): void {
  NodeFS.mkdirSync(input.dir, { recursive: true });
  const tempPath = NodePath.join(
    input.dir,
    `.${input.id}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(input.value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  NodeFS.renameSync(tempPath, input.targetPath);
}

export function readAdvertisementJson<A>(
  filePath: string,
  decode: (value: unknown) => A,
): { readonly _tag: "ok"; readonly value: A } | { readonly _tag: "missing" | "invalid" } {
  try {
    return { _tag: "ok", value: decode(JSON.parse(NodeFS.readFileSync(filePath, "utf8"))) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { _tag: "missing" };
    }
    return { _tag: "invalid" };
  }
}

export function sanitizeAdvertisementId(input: {
  readonly id: string;
  readonly pattern: RegExp;
  readonly label: string;
}): string {
  const trimmed = input.id.trim();
  if (!trimmed || !input.pattern.test(trimmed)) {
    throw new Error(`${input.label} must contain only letters, numbers, '.', '_', or '-'.`);
  }
  return trimmed;
}

export function workspaceRootsMatch(left: string, right: string): boolean {
  return normalizeWorkspaceRootForMatch(left) === normalizeWorkspaceRootForMatch(right);
}

function normalizeWorkspaceRootForMatch(value: string): string {
  const normalized = NodePath.normalize(value.trim());
  return Effect.runSync(HostProcessPlatform) === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
