#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot mirror step beside i18n-check.ts; synchronous Node APIs keep it small.
/**
 * Fork-only. Run on the mirror tree after `fork-rename-codemod.ts --write`: regenerates each app's
 * en.json from the renamed source and moves locale entries to the new keys
 * (scripts/lib/forkI18nRekey.ts). Writes nothing unless every app pairs cleanly.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type Catalog, rekeyForkCatalogs } from "./lib/forkI18nRekey.ts";

const GENERATE: Record<string, readonly [string, ...string[]]> = {
  "apps/web": ["node_modules/.bin/gt", "generate"],
  "apps/mobile": ["node_modules/.bin/gt", "generate"],
  "apps/desktop": [process.execPath, "scripts/i18n-generate.mjs"],
};

const readJson = (file: string): Catalog => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const root = NodePath.resolve(import.meta.dirname, "..");
const writes: Array<readonly [string, string]> = [];
const problems: string[] = [];
let movedCount = 0;

for (const [app, [command, ...args]] of Object.entries(GENERATE)) {
  const appDir = NodePath.join(root, app);
  const config = JSON.parse(NodeFS.readFileSync(NodePath.join(appDir, "gt.config.json"), "utf8"));
  const catalogDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
  const sourceFile = NodePath.join(catalogDir, `${config.defaultLocale}.json`);
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-i18n-rekey-"));
  try {
    const tmpConfig = NodePath.join(tmp, "gt.config.json");
    NodeFS.writeFileSync(
      tmpConfig,
      JSON.stringify({ ...config, locales: [], files: { gt: { output: `${tmp}/[locale].json` } } }),
    );
    const gt = NodeChildProcess.spawnSync(command, [...args, "--config", tmpConfig], {
      cwd: appDir,
      encoding: "utf8",
    });
    if (gt.status !== 0) {
      problems.push(`${app}: gt generate failed\n${gt.stdout}${gt.stderr}`);
      continue;
    }
    const generatedText = NodeFS.readFileSync(
      NodePath.join(tmp, `${config.defaultLocale}.json`),
      "utf8",
    );
    const localeFiles = Object.fromEntries(
      (config.locales as string[]).map((locale) => [
        locale,
        NodePath.join(catalogDir, `${locale}.json`),
      ]),
    );
    const result = rekeyForkCatalogs({
      renamedSource: readJson(sourceFile),
      generatedSource: JSON.parse(generatedText),
      locales: Object.fromEntries(
        Object.entries(localeFiles).map(([locale, file]) => [locale, readJson(file)]),
      ),
    });
    problems.push(...result.problems.map((problem) => `${app}: ${problem}`));
    movedCount += Object.keys(result.moved).length;
    writes.push([sourceFile, `${JSON.stringify(result.source, null, 2)}\n`]);
    for (const [locale, catalog] of Object.entries(result.locales)) {
      writes.push([localeFiles[locale]!, `${JSON.stringify(catalog, null, 2)}\n`]);
    }
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error("\nNo catalog was written. Fix the rename rules so source and catalogs agree.");
  process.exitCode = 1;
} else {
  for (const [file, contents] of writes) NodeFS.writeFileSync(file, contents);
  console.log(
    `Moved ${movedCount} renamed messages to their new keys in ${Object.keys(GENERATE).join(", ")}.`,
  );
}
