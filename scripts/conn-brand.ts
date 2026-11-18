// @effect-diagnostics nodeBuiltinImport:off
// Conn: the GT catalogs name the app only through `{appName}`. See FORK.md, "i18n and the app name".
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const CATALOG_APPS = ["apps/web", "apps/mobile", "apps/desktop"] as const;

// German writes the name as part of a compound ("T3-Code-Server").
const APP_NAME_SPELLINGS = ["T3 Code", "T3-Code"] as const;

export interface CatalogBrandHit {
  readonly file: string;
  readonly key: string;
  readonly text: string;
}

const strings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

/** Every entry of one catalog whose text, at any depth of a JSX entry, names the app literally. */
export function catalogBrandHits(file: string, catalog: Record<string, unknown>) {
  const hits: CatalogBrandHit[] = [];
  for (const [key, value] of Object.entries(catalog)) {
    const text = strings(value).find((part) =>
      APP_NAME_SPELLINGS.some((name) => part.includes(name)),
    );
    if (text !== undefined) hits.push({ file, key, text });
  }
  return hits;
}

export function catalogFiles(root: string): ReadonlyArray<string> {
  return CATALOG_APPS.flatMap((app) => {
    const dir = NodePath.join(root, app, "src/i18n/translations");
    return NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => NodePath.join(dir, name));
  });
}
