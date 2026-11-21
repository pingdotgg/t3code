/**
 * Fork-only. GT catalogs key each message by a hash of its English text, so the Lathe rename
 * changes the key of every message it rewrites. Given the renamed source catalog (old keys, renamed
 * text) and the catalog `gt generate` writes from the renamed source, this moves every locale entry
 * to its message's new key. Pairs by text and refuses anything it cannot pair exactly.
 */

export type Catalog = Readonly<Record<string, unknown>>;

export interface ForkCatalogRekeyInput {
  readonly renamedSource: Catalog;
  readonly generatedSource: Catalog;
  readonly locales: Readonly<Record<string, Catalog>>;
  /**
   * The rename as shared code applies it, for catalogs whose own text is kept (mobile) while they
   * collect messages from renamed shared packages. Gets and returns JSON text.
   */
  readonly renameSharedText?: (json: string) => string;
}

export interface ForkCatalogRekeyResult {
  readonly source: Catalog;
  readonly moved: Readonly<Record<string, string>>;
  readonly locales: Readonly<Record<string, Catalog>>;
  readonly problems: ReadonlyArray<string>;
}

const text = (value: unknown) => JSON.stringify(value);

export function rekeyForkCatalogs(input: ForkCatalogRekeyInput): ForkCatalogRekeyResult {
  const { renamedSource, generatedSource } = input;
  const problems: string[] = [];
  const added = new Map<string, string[]>();
  for (const [key, value] of Object.entries(generatedSource)) {
    if (Object.hasOwn(renamedSource, key)) {
      if (text(renamedSource[key]) !== text(value)) {
        problems.push(
          `${key}: catalog says ${text(renamedSource[key])}, source says ${text(value)}`,
        );
      }
      continue;
    }
    added.set(text(value), [...(added.get(text(value)) ?? []), key]);
  }

  const moved: Record<string, string> = {};
  const paired = new Set<string>();
  for (const [key, value] of Object.entries(renamedSource)) {
    if (Object.hasOwn(generatedSource, key)) continue;
    const exact = added.get(text(value)) ?? [];
    const candidates =
      exact.length === 0 && input.renameSharedText
        ? (added.get(input.renameSharedText(text(value))) ?? [])
        : exact;
    if (candidates.length === 0) {
      problems.push(`${key} ${text(value)} has no new key`);
    } else if (candidates.length > 1) {
      problems.push(
        `${key} ${text(value)} matches ${candidates.length} new keys (${candidates.join(", ")}); pair them by hand`,
      );
      for (const candidate of candidates) paired.add(candidate);
    } else {
      moved[key] = candidates[0]!;
      paired.add(candidates[0]!);
    }
  }
  for (const keys of added.values()) {
    for (const key of keys) {
      if (!paired.has(key)) {
        problems.push(`${key} ${text(generatedSource[key])} is new in the source, not a rename`);
      }
    }
  }

  // Renaming in place keeps upstream's entry order, so the mirror diff shows only moved keys.
  const rekey = (catalog: Catalog) =>
    Object.fromEntries(Object.entries(catalog).map(([key, value]) => [moved[key] ?? key, value]));
  const locales = Object.fromEntries(
    Object.entries(input.locales).map(([locale, catalog]) => [locale, rekey(catalog)]),
  );
  const source = Object.fromEntries(
    Object.entries(renamedSource).map(([key, value]) =>
      moved[key] ? [moved[key], generatedSource[moved[key]]] : [key, value],
    ),
  );
  return { source, moved, locales, problems };
}
