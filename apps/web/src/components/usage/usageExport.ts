import { USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@t3tools/contracts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(values: readonly (string | number)[]): string {
  return values.map(csvCell).join(",");
}

/** Creates a spreadsheet-friendly export without exposing raw transcripts. */
export function usageToCsv(usage: MergedUsage, input: UsageSummaryInput): string {
  const rows: string[] = [
    csvRow(["T3 Code usage export"]),
    csvRow(["Since", input.sinceDay]),
    csvRow(["Until", input.untilDay]),
    csvRow(["Time zone", input.timeZone]),
    csvRow(["Contract version", USAGE_CONTRACT_VERSION]),
    "",
    csvRow(["Provider", "Model", "Tokens", "Cost (USD)", "Records", "Cost share"]),
  ];

  for (const model of usage.models) {
    rows.push(
      csvRow([
        model.provider,
        model.model,
        model.totalTokens,
        model.costUsd,
        model.records,
        model.costShare,
      ]),
    );
  }

  rows.push(
    "",
    csvRow(["Total tokens", usage.totalTokens]),
    csvRow(["Total cost (USD)", usage.costUsd]),
    csvRow(["Sessions", usage.sessions]),
  );
  if (usage.accountUsage !== null) {
    rows.push(
      "",
      csvRow(["Devin account usage status", usage.accountUsage.status]),
      csvRow(["Devin account ACUs", usage.accountUsage.totalAcus]),
      csvRow(["Devin account source", usage.accountUsage.source]),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}

/** JSON export counterpart for scripts and issue reports. */
export function usageToJson(usage: MergedUsage, input: UsageSummaryInput): string {
  const serializePeriods = (periods: readonly (typeof usage.daily)[number][]) =>
    periods.map((period) => ({
      ...period,
      byProvider: Object.fromEntries(period.byProvider),
    }));

  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      window: input,
      totals: {
        costUsd: usage.costUsd,
        totalTokens: usage.totalTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        records: usage.records,
        sessions: usage.sessions,
      },
      providers: usage.providers,
      models: usage.models,
      daily: serializePeriods(usage.daily),
      hourly: serializePeriods(usage.hourly),
      costQuality: usage.costQuality,
      accountUsage: usage.accountUsage,
    },
    null,
    2,
  );
}
