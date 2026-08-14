/**
 * Serializes Cursor usage events to CSV for export.
 *
 * @module CursorUsageCsv
 */
import type { CursorUsageEvent } from "@t3tools/contracts";

const COLUMNS = [
  "Date",
  "Provider",
  "Type",
  "Model",
  "Input Tokens",
  "Output Tokens",
  "Cache Write Tokens",
  "Cache Read Tokens",
  "Total Tokens",
  "Raw Cost",
  "Charged Cost",
] as const;

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function centsToUsd(cents: number | undefined): string {
  return cents === undefined ? "" : (cents / 100).toFixed(4);
}

export function cursorUsageEventsToCsv(events: readonly CursorUsageEvent[]): string {
  const lines = [COLUMNS.join(",")];
  for (const event of events) {
    lines.push(
      [
        csvField(event.occurredAt),
        csvField("cursor"),
        csvField(event.usageType),
        csvField(event.model),
        csvField(event.inputTokens ?? ""),
        csvField(event.outputTokens ?? ""),
        csvField(event.cacheWriteTokens ?? ""),
        csvField(event.cacheReadTokens ?? ""),
        csvField(event.totalTokens ?? ""),
        csvField(centsToUsd(event.rawCostCents)),
        csvField(centsToUsd(event.chargedCents)),
      ].join(","),
    );
  }
  return lines.join("\n");
}
