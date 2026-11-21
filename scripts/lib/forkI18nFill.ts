/**
 * Fork-only. Lathe's own copy is English only, so after a sync the catalogs follow the source
 * without translating: stale messages leave every catalog, and messages the fork added reach every
 * locale in English. Existing entries keep their order so upstream's next catalog edits merge.
 */
import type { Catalog } from "./forkI18nRekey.ts";

export interface ForkCatalogFillInput {
  readonly source: Catalog;
  readonly generatedSource: Catalog;
  readonly locales: Readonly<Record<string, Catalog>>;
}

export interface ForkCatalogFillResult {
  readonly source: Catalog;
  readonly locales: Readonly<Record<string, Catalog>>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export function fillForkCatalogs(input: ForkCatalogFillInput): ForkCatalogFillResult {
  const { generatedSource } = input;
  const added = Object.keys(generatedSource).filter((key) => !Object.hasOwn(input.source, key));
  const removed = Object.keys(input.source).filter((key) => !Object.hasOwn(generatedSource, key));
  const follow = (catalog: Catalog, fallback: (key: string) => unknown) =>
    Object.fromEntries([
      ...Object.entries(catalog).flatMap(([key, value]) =>
        Object.hasOwn(generatedSource, key) ? [[key, fallback(key) ?? value] as const] : [],
      ),
      ...added.map((key) => [key, generatedSource[key]] as const),
    ]);
  return {
    source: follow(input.source, (key) => generatedSource[key]),
    locales: Object.fromEntries(
      Object.entries(input.locales).map(([locale, catalog]) => [
        locale,
        follow(catalog, () => undefined),
      ]),
    ),
    added,
    removed,
  };
}
