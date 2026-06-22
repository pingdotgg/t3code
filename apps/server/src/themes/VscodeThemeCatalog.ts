// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  VscodeThemeCatalogError,
  type VscodeThemeJsonResult,
  type VscodeThemeListResult,
  type VscodeThemeSource,
  type VscodeThemeSummary,
  type VscodeThemeType,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { parse as parseJsonc, type ParseError } from "jsonc-parser";

/**
 * Reads VSCode color themes from the user's machine in real time: built-in
 * themes shipped inside the editor app bundle plus installed extension themes
 * under `~/.vscode/extensions`. Themes are declared by each extension's
 * `package.json#contributes.themes`; theme files are JSONC and may use
 * `include` to inherit from a parent theme, which we resolve and merge.
 *
 * Nothing is cached across calls so newly installed themes appear without a
 * restart. `resolveTheme` re-enumerates and matches the requested id against a
 * known catalog entry, so the client can never make us read an arbitrary path.
 */
export class VscodeThemeCatalog extends Context.Service<
  VscodeThemeCatalog,
  {
    readonly listThemes: Effect.Effect<VscodeThemeListResult, VscodeThemeCatalogError>;
    readonly resolveTheme: (
      id: string,
    ) => Effect.Effect<VscodeThemeJsonResult, VscodeThemeCatalogError>;
  }
>()("t3/themes/VscodeThemeCatalog") {}

export interface ThemeRecord {
  readonly id: string;
  readonly label: string;
  readonly type: VscodeThemeType;
  readonly source: VscodeThemeSource;
  readonly absPath: string;
}

export interface ThemeRoot {
  readonly dir: string;
  readonly source: VscodeThemeSource;
}

const MAX_INCLUDE_DEPTH = 10;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsoncSafe(text: string): unknown {
  const errors: ParseError[] = [];
  return parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
}

export function uiThemeToType(uiTheme: unknown): VscodeThemeType {
  // `vs` and `hc-light` are light; `vs-dark`, `hc-black`, and anything else dark.
  return uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
}

function builtinRoots(platform: NodeJS.Platform): string[] {
  const home = NodeOS.homedir();
  if (platform === "darwin") {
    return [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
      NodePath.join(home, "Applications/Visual Studio Code.app/Contents/Resources/app/extensions"),
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions",
      "/Applications/VSCodium.app/Contents/Resources/app/extensions",
    ];
  }
  if (platform === "win32") {
    const roots: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    if (localAppData) {
      roots.push(
        NodePath.join(localAppData, "Programs/Microsoft VS Code/resources/app/extensions"),
      );
    }
    if (programFiles) {
      roots.push(NodePath.join(programFiles, "Microsoft VS Code/resources/app/extensions"));
    }
    return roots;
  }
  // Linux and other Unix-likes.
  return [
    "/usr/share/code/resources/app/extensions",
    "/usr/lib/code/resources/app/extensions",
    "/snap/code/current/resources/app/extensions",
    "/opt/visual-studio-code/resources/app/extensions",
    "/usr/share/codium/resources/app/extensions",
  ];
}

function extensionRoots(): string[] {
  const home = NodeOS.homedir();
  return [
    NodePath.join(home, ".vscode/extensions"),
    NodePath.join(home, ".vscode-insiders/extensions"),
    NodePath.join(home, ".vscode-oss/extensions"),
  ];
}

async function readNls(extDir: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await NodeFSP.readFile(NodePath.join(extDir, "package.nls.json"), "utf8");
    return asRecord(parseJsoncSafe(text));
  } catch {
    return null;
  }
}

export function resolveNlsLabel(rawLabel: string, nls: Record<string, unknown> | null): string {
  const match = /^%(.+)%$/.exec(rawLabel);
  const key = match?.[1];
  if (!key) {
    return rawLabel;
  }
  const value = nls?.[key];
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  const message = record ? asString(record.message) : undefined;
  return message ?? key;
}

async function readExtensionThemes(
  extDir: string,
  extDirName: string,
  source: VscodeThemeSource,
): Promise<ThemeRecord[]> {
  let pkgText: string;
  try {
    pkgText = await NodeFSP.readFile(NodePath.join(extDir, "package.json"), "utf8");
  } catch {
    return [];
  }

  const pkg = asRecord(parseJsoncSafe(pkgText));
  const contributes = pkg ? asRecord(pkg.contributes) : null;
  const themes = contributes?.themes;
  if (!Array.isArray(themes)) {
    return [];
  }

  const nls = await readNls(extDir);
  const records: ThemeRecord[] = [];
  for (const entry of themes) {
    const theme = asRecord(entry);
    const relPath = theme ? asString(theme.path) : undefined;
    if (!theme || !relPath) {
      continue;
    }
    const rawLabel = asString(theme.label) ?? asString(theme.id) ?? NodePath.basename(relPath);
    const label = resolveNlsLabel(rawLabel, nls).trim() || NodePath.basename(relPath);
    records.push({
      id: `${source}::${extDirName}::${relPath}`,
      label,
      type: uiThemeToType(theme.uiTheme),
      source,
      absPath: NodePath.resolve(extDir, relPath),
    });
  }
  return records;
}

async function safeReaddir(dir: string) {
  try {
    return await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory not present (ENOENT) or unreadable — treat as empty.
    return [];
  }
}

function computeThemeRoots(platform: NodeJS.Platform): ThemeRoot[] {
  return [
    ...builtinRoots(platform).map((dir) => ({ dir, source: "builtin" as const })),
    ...extensionRoots().map((dir) => ({ dir, source: "extension" as const })),
  ];
}

export async function collectThemesFromRoots(roots: ReadonlyArray<ThemeRoot>): Promise<ThemeRecord[]> {
  const records: ThemeRecord[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const dirents = await safeReaddir(root.dir);
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
        continue;
      }
      const extDir = NodePath.join(root.dir, dirent.name);
      const extThemes = await readExtensionThemes(extDir, dirent.name, root.source).catch(() => []);
      for (const record of extThemes) {
        if (seen.has(record.id)) {
          continue;
        }
        seen.add(record.id);
        records.push(record);
      }
    }
  }
  return records;
}

function enumerateThemes(platform: NodeJS.Platform): Promise<ThemeRecord[]> {
  return collectThemesFromRoots(computeThemeRoots(platform));
}

export function mergeTheme(
  base: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...child };

  const baseColors = asRecord(base.colors) ?? {};
  const childColors = asRecord(child.colors) ?? {};
  merged.colors = { ...baseColors, ...childColors };

  const baseTokens = Array.isArray(base.tokenColors) ? base.tokenColors : [];
  const childTokens = Array.isArray(child.tokenColors) ? child.tokenColors : [];
  merged.tokenColors = [...baseTokens, ...childTokens];

  const baseSemantic = asRecord(base.semanticTokenColors);
  const childSemantic = asRecord(child.semanticTokenColors);
  if (baseSemantic || childSemantic) {
    merged.semanticTokenColors = { ...baseSemantic, ...childSemantic };
  }

  delete merged.include;
  return merged;
}

export async function loadAndMergeTheme(
  absPath: string,
  visited: Set<string> = new Set<string>(),
  depth = 0,
): Promise<Record<string, unknown>> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`theme include chain exceeded ${MAX_INCLUDE_DEPTH} levels`);
  }
  const real = NodePath.resolve(absPath);
  if (visited.has(real)) {
    throw new Error(`theme include cycle detected at ${real}`);
  }
  visited.add(real);

  const text = await NodeFSP.readFile(real, "utf8");
  const parsed = asRecord(parseJsoncSafe(text));
  if (!parsed) {
    throw new Error(`invalid theme JSON at ${real}`);
  }

  const include = asString(parsed.include);
  const base = include
    ? await loadAndMergeTheme(NodePath.resolve(NodePath.dirname(real), include), visited, depth + 1)
    : {};
  return mergeTheme(base, parsed);
}

async function resolveThemeById(
  platform: NodeJS.Platform,
  id: string,
): Promise<VscodeThemeJsonResult | null> {
  const record = (await enumerateThemes(platform)).find((candidate) => candidate.id === id);
  if (!record) {
    return null;
  }

  const merged = await loadAndMergeTheme(record.absPath, new Set<string>(), 0);
  // Shiki keys loaded themes by their `name`; force it to match the id so the
  // client can register and reference the theme by the same string.
  merged.name = id;
  const colors = asRecord(merged.colors);

  return {
    id,
    name: id,
    type: record.type,
    background: colors ? asString(colors["editor.background"]) : undefined,
    foreground: colors ? asString(colors["editor.foreground"]) : undefined,
    theme: merged,
  };
}

function toSummary(record: ThemeRecord): VscodeThemeSummary {
  return { id: record.id, label: record.label, type: record.type, source: record.source };
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;

  const listThemes: VscodeThemeCatalog["Service"]["listThemes"] = Effect.tryPromise({
    try: () => enumerateThemes(platform),
    catch: (cause) =>
      new VscodeThemeCatalogError({
        operation: "list",
        message: `Failed to enumerate VSCode themes: ${errorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.map((records) => ({
      themes: records
        .map(toSummary)
        .sort(
          (left, right) =>
            left.source.localeCompare(right.source) || left.label.localeCompare(right.label),
        ),
    })),
  );

  const resolveTheme: VscodeThemeCatalog["Service"]["resolveTheme"] = (id) =>
    Effect.tryPromise({
      try: () => resolveThemeById(platform, id),
      catch: (cause) =>
        new VscodeThemeCatalogError({
          operation: "resolve",
          message: `Failed to resolve VSCode theme '${id}': ${errorMessage(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((result) =>
        result
          ? Effect.succeed(result)
          : new VscodeThemeCatalogError({
              operation: "resolve",
              message: `VSCode theme '${id}' was not found.`,
            }),
      ),
    );

  return VscodeThemeCatalog.of({ listThemes, resolveTheme });
});

export const layer = Layer.effect(VscodeThemeCatalog, make);
