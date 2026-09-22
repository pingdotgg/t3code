#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - one-shot CI gate over a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// `shadcn/no-restyle` stays a warning while the existing className overrides on
// components/ui exports are migrated to variants (see vite.config.ts). This gate keeps the
// count from growing: CI fails when findings exceed the ceiling. Lower the ceiling when you
// migrate a file, and delete this script when the rule becomes an error.
export const RESTYLE_CEILING = 812;

const RULE = "shadcn(no-restyle)";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

interface LintReport {
  readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
}

export function countRestyleFindings(report: LintReport): number {
  return report.diagnostics.filter((diagnostic) => diagnostic.code === RULE).length;
}

export function evaluateCeiling(
  count: number,
  ceiling: number,
): { readonly ok: boolean; readonly message: string } {
  if (count > ceiling) {
    return {
      ok: false,
      message:
        `${RULE}: ${count} findings exceed the ceiling of ${ceiling}. ` +
        "Use a variant or size on the components/ui export instead of a className override " +
        "(run `vp lint apps/web/src` for the list).",
    };
  }
  const slack = ceiling - count;
  return {
    ok: true,
    message:
      slack === 0
        ? `${RULE}: ${count} findings, at the ceiling.`
        : `${RULE}: ${count} findings, ${slack} below the ceiling of ${ceiling}. Lower RESTYLE_CEILING in scripts/lint-restyle-ceiling.ts to ${count}.`,
  };
}

function main() {
  const result = NodeChildProcess.spawnSync("vp", ["lint", "--format", "json", "apps/web/src"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout) as LintReport;
  const verdict = evaluateCeiling(countRestyleFindings(report), RESTYLE_CEILING);
  process.stdout.write(`${verdict.message}\n`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
