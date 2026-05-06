import type { PreflightReport } from "../result";

export const renderMarkdownReport = (report: PreflightReport): string => {
  const lines = [
    "# Preflight Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.errors} error(s), ${report.summary.warns} warn(s), ${report.summary.infos} info, ${report.summary.skipped} skipped.`,
    "",
    "| ID | Status | Duration | Hint |",
    "|---|---|---:|---|",
  ];

  if (report.checks.length === 0) {
    lines.push("| _none_ | info | 0ms | no checks configured |");
  } else {
    for (const check of report.checks) {
      lines.push(`| ${check.id} | ${check.status} | ${check.durationMs}ms | ${check.hint ?? ""} |`);
    }
  }

  return `${lines.join("\n")}\n`;
};
