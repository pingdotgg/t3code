const PRIVATE_WORKSPACE_IMPORT = /(?:from\s+|import\(|require\()\s*["'](@t3tools\/[^"']+)["']/u;
const OPAQUE_PACKAGE_REQUIRE = /createRequire\([^)]*\)\(\s*["']((?:@[^/"']+\/)?[^/"']+)["']\s*\)/u;

/** Find a package lookup that Bun left unresolved in the staged TUI bundle. */
export function findUnresolvedTuiBundleImport(source: string): string | null {
  return (
    source.match(PRIVATE_WORKSPACE_IMPORT)?.[1] ?? source.match(OPAQUE_PACKAGE_REQUIRE)?.[1] ?? null
  );
}
