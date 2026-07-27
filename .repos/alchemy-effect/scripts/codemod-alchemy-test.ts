#!/usr/bin/env bun
/**
 * Codemod: migrate the test suite from vitest to the alchemy-test harness.
 *
 * Rewrites, in every `packages/alchemy/test/**\/*.ts(x)` file:
 *
 *   1. `from "@/Test/Vitest"`   -> `from "@/Test/Alchemy"`
 *   2. `from "@effect/vitest"`  -> `from "alchemy-test"`
 *   3. `from "vitest"`          -> `from "alchemy-test"`
 *   4. `from "node:test"`       -> `from "alchemy-test"` (stray auto-imports;
 *      node:test's describe/it throw outside the node/bun test runner)
 *   5. merges duplicate `import { ... } from "alchemy-test"` statements that
 *      steps 2-4 can produce in the same file.
 *
 * Idempotent: re-running on an already-migrated (or partially migrated) tree
 * is a no-op, so it can be re-applied on other branches after merging.
 *
 * Usage:
 *   bun scripts/codemod-alchemy-test.ts [--dry-run]
 */
import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "packages", "alchemy", "test");
const DRY_RUN = process.argv.includes("--dry-run");

/** Rewrite a module specifier wherever it appears in import/export syntax. */
const rewriteSpecifier = (source: string, from: string, to: string): string => {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches: from "x" | from 'x' | import("x") | import "x" | require("x")
  return source
    .replace(
      new RegExp(`(from\\s*)(["'])${escaped}\\2`, "g"),
      (_m, prefix, quote) => `${prefix}${quote}${to}${quote}`,
    )
    .replace(
      new RegExp(`(import\\s*\\(\\s*)(["'])${escaped}\\2`, "g"),
      (_m, prefix, quote) => `${prefix}${quote}${to}${quote}`,
    )
    .replace(
      new RegExp(`(^|\\n)(import\\s+)(["'])${escaped}\\3`, "g"),
      (_m, lead, prefix, quote) => `${lead}${prefix}${quote}${to}${quote}`,
    );
};

/**
 * Merge multiple `import { a } from "alchemy-test"` statements into one.
 * Keeps `import type { ... }` statements separate from value imports.
 */
const mergeDuplicateImports = (source: string, specifier: string): string => {
  const pattern = new RegExp(
    `^import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${specifier}["'];?\\s*$`,
    "gm",
  );
  const matches = [...source.matchAll(pattern)];
  const merge = (typeOnly: boolean): void => {
    const group = matches.filter((m) => Boolean(m[1]) === typeOnly);
    if (group.length < 2) return;
    const names = new Set<string>();
    for (const m of group) {
      for (const name of m[2]!.split(",")) {
        const trimmed = name.trim();
        if (trimmed !== "") names.add(trimmed);
      }
    }
    const sorted = [...names].sort((a, b) =>
      a.replace(/^type\s+/, "").localeCompare(b.replace(/^type\s+/, "")),
    );
    const merged = `import ${typeOnly ? "type " : ""}{ ${sorted.join(", ")} } from "${specifier}";`;
    let first = true;
    for (const m of group) {
      if (first) {
        source = source.replace(m[0]!, merged);
        first = false;
      } else {
        // Remove the statement and its trailing newline.
        source = source.replace(new RegExp(`${escapeRegExp(m[0]!)}\\n?`), "");
      }
    }
  };
  merge(false);
  merge(true);
  return source;
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const migrate = (source: string): string => {
  let out = source;
  out = rewriteSpecifier(out, "@/Test/Vitest", "@/Test/Alchemy");
  out = rewriteSpecifier(out, "@/Test/Vitest.ts", "@/Test/Alchemy.ts");
  out = rewriteSpecifier(out, "@effect/vitest", "alchemy-test");
  out = rewriteSpecifier(out, "vitest", "alchemy-test");
  out = rewriteSpecifier(out, "node:test", "alchemy-test");
  out = mergeDuplicateImports(out, "alchemy-test");
  return out;
};

const glob = new Glob("**/*.{ts,tsx}");
let changed = 0;
let scanned = 0;

for await (const relative of glob.scan({ cwd: TEST_DIR })) {
  const file = path.join(TEST_DIR, relative);
  scanned++;
  const source = await Bun.file(file).text();
  const migrated = migrate(source);
  if (migrated !== source) {
    changed++;
    if (DRY_RUN) {
      console.log(`[dry-run] would update ${path.relative(ROOT, file)}`);
    } else {
      await Bun.write(file, migrated);
      console.log(`updated ${path.relative(ROOT, file)}`);
    }
  }
}

console.log(
  `${DRY_RUN ? "[dry-run] " : ""}codemod complete: ${changed}/${scanned} files ${DRY_RUN ? "would be " : ""}updated`,
);
