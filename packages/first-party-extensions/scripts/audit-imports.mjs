#!/usr/bin/env node
/**
 * Private-import audit for first-party extension packages.
 *
 * Scans a package's source tree and its built .t3-extension bundle and FAILS
 * on any binding to app-private modules:
 *   - `~/` specifiers (apps/web path alias)
 *   - `apps/*` package internals (web/server/desktop/mobile/marketing)
 *   - `@t3tools/client-runtime` and `client-runtime` internals (state atoms,
 *     the atom/RPC transport the SDK facade owns)
 *   - relative imports that escape the package root
 *   - private WS RPC method names (see PRIVATE_RPC_NAMES)
 *   - bare specifiers outside the public allowlist
 *
 * Usage: node audit-imports.mjs <package-dir> [--allow <specifier-prefix>]...
 *   [--allow-relative <path>]...
 * `--allow-relative` exempts one exact file outside the package root, resolved
 * from <package-dir>; use it only for test-time tooling the bundle never
 * reaches, such as ../scripts/check-bundles.mjs.
 * Exit 0 = clean. Findings print as JSON lines to stderr and the process
 * exits 1. Shared by every first-party panel package.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const PUBLIC_SPECIFIER_PREFIXES = [
  "node:",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@t3tools/extension-sdk",
  "@t3tools/contracts",
  "@t3tools/shared",
];

/** WS RPC names that remain host-private wire methods, not public contracts. */
const PRIVATE_RPC_NAMES = [
  "projectsListEntries",
  "projectsReadFile",
  "projectsWriteFile",
  "projectsSearchEntries",
  "projectsSearchContents",
  "shellOpenInEditor",
  // Asset minting is t3.resources/lease on the broker, never this wire method.
  "assetsCreateUrl",
];

/** Content patterns banned in both source and the shipped bundle. */
const BANNED_CONTENT = [
  { pattern: /(^|[^\w./-])~\//, label: "~/ app-alias import" },
  { pattern: /apps\/web\//, label: "apps/web internal path" },
  { pattern: /apps\/server\//, label: "apps/server internal path" },
  { pattern: /apps\/desktop\//, label: "apps/desktop internal path" },
  { pattern: /apps\/mobile\//, label: "apps/mobile internal path" },
  { pattern: /@t3tools\/client-runtime/, label: "client-runtime import" },
  { pattern: /client-runtime\/src\//, label: "client-runtime internal path" },
  { pattern: /packages\/client-runtime/, label: "client-runtime package path" },
];

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

async function* walk(dir) {
  for (const item of await NodeFSP.readdir(dir, { withFileTypes: true })) {
    const path = NodePath.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === "node_modules" || item.name.startsWith(".t3-extension-build-")) continue;
      yield* walk(path);
    } else if (SOURCE_EXT.has(NodePath.extname(item.name)) || item.name === "t3-extension.json") {
      yield path;
    }
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

async function main() {
  const args = process.argv.slice(2);
  const extraAllowed = [];
  const allowedRelative = [];
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--allow") extraAllowed.push(args[++i]);
    else if (args[i] === "--allow-relative") allowedRelative.push(args[++i]);
    else positional.push(args[i]);
  }
  const root = NodePath.resolve(positional[0] ?? ".");
  const allowedOutside = new Set(allowedRelative.map((path) => NodePath.resolve(root, path)));
  const allowed = [...PUBLIC_SPECIFIER_PREFIXES, ...extraAllowed];
  const findings = [];

  for await (const file of walk(root)) {
    const text = await NodeFSP.readFile(file, "utf8");
    const rel = NodePath.relative(root, file);

    for (const { pattern, label } of BANNED_CONTENT) {
      for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
        findings.push({ file: rel, line: lineOf(text, match.index), label });
      }
    }
    for (const name of PRIVATE_RPC_NAMES) {
      const pattern = new RegExp(`[^\\w]${name}[^\\w]|^${name}[^\\w]`);
      for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
        findings.push({
          file: rel,
          line: lineOf(text, match.index),
          label: `private RPC name "${name}"`,
        });
      }
    }

    if (!SOURCE_EXT.has(NodePath.extname(file))) continue;
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) {
        const resolved = NodePath.resolve(NodePath.dirname(file), specifier);
        if (
          !resolved.startsWith(root + NodePath.sep) &&
          resolved !== root &&
          !allowedOutside.has(resolved)
        )
          findings.push({
            file: rel,
            line: lineOf(text, match.index),
            label: `relative import escapes package root: "${specifier}"`,
          });
        continue;
      }
      if (
        !allowed.some(
          (prefix) =>
            specifier === prefix ||
            specifier.startsWith(prefix + "/") ||
            (prefix.endsWith(":") && specifier.startsWith(prefix)),
        )
      )
        findings.push({
          file: rel,
          line: lineOf(text, match.index),
          label: `non-public specifier: "${specifier}"`,
        });
    }
  }

  if (findings.length) {
    for (const finding of findings) console.error(JSON.stringify(finding));
    console.error(`audit-imports: ${findings.length} private binding(s) in ${root}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ kind: "import-audit", root, findings: 0 }));
}

await main();
