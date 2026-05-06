import type { PreflightReport } from "../result";

export const renderJsonReport = (report: PreflightReport): string =>
  JSON.stringify(report, null, 2);
