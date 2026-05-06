import type { PreflightReport } from "../result";

export const renderTerminalReport = (report: PreflightReport): string => {
  if (report.checks.length === 0) {
    return "Preflight: no checks configured\n";
  }

  const lines = ["Preflight checks:"];

  for (const check of report.checks) {
    const hint = check.hint === undefined ? "" : ` - ${check.hint}`;
    lines.push(`- ${check.status.toUpperCase()} ${check.id} (${check.durationMs}ms)${hint}`);
  }

  return `${lines.join("\n")}\n`;
};
