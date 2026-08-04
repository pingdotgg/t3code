import type { ProviderDriverKind } from "@t3tools/contracts";

import type {
  HttpTransferMeasurement,
  WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";

export interface TransferBudgetRun {
  readonly provider: ProviderDriverKind;
  readonly document: HttpTransferMeasurement;
  readonly shellSnapshot: HttpTransferMeasurement;
  readonly threadSnapshot: HttpTransferMeasurement;
  readonly coldOpenWebSocket: WebSocketTransferTotals;
  readonly measuredTurnWebSocket: WebSocketTransferTotals;
}

interface ProviderTransferBudget {
  readonly totalWireBytes: number;
  readonly documentWireBytes: number;
  readonly shellSnapshotWireBytes: number;
  readonly threadSnapshotWireBytes: number;
  readonly coldOpenWebSocketWireBytes: number;
  readonly measuredTurnWebSocketWireBytes: number;
  readonly measuredTurnWebSocketDecodedBytes: number;
  readonly measuredTurnWebSocketMessages: number;
}

// These caps leave roughly 30% headroom above the deterministic fixture. The
// CI report preserves the exact values so intentional protocol growth can be
// reviewed and the caps raised explicitly.
export const TRANSFER_BUDGETS: Readonly<Record<string, ProviderTransferBudget>> = {
  codex: {
    totalWireBytes: 13_000,
    documentWireBytes: 4_000,
    shellSnapshotWireBytes: 1_000,
    threadSnapshotWireBytes: 3_000,
    coldOpenWebSocketWireBytes: 1_600,
    measuredTurnWebSocketWireBytes: 3_400,
    measuredTurnWebSocketDecodedBytes: 18_000,
    measuredTurnWebSocketMessages: 14,
  },
  claudeAgent: {
    totalWireBytes: 13_000,
    documentWireBytes: 4_000,
    shellSnapshotWireBytes: 1_000,
    threadSnapshotWireBytes: 3_000,
    coldOpenWebSocketWireBytes: 1_600,
    measuredTurnWebSocketWireBytes: 3_400,
    measuredTurnWebSocketDecodedBytes: 18_000,
    measuredTurnWebSocketMessages: 14,
  },
};

function totalWireBytes(run: TransferBudgetRun): number {
  return (
    run.document.wireBytes +
    run.shellSnapshot.wireBytes +
    run.threadSnapshot.wireBytes +
    run.coldOpenWebSocket.wireBytes +
    run.measuredTurnWebSocket.wireBytes
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB (${bytes.toLocaleString("en-US")} B)`;
}

function row(
  provider: ProviderDriverKind,
  phase: string,
  metric: string,
  observed: number,
  maximum: number,
  format: (value: number) => string = formatBytes,
): string {
  const status = observed <= maximum ? "PASS" : "FAIL";
  return `| ${provider} | ${phase} | ${metric} | ${format(observed)} | ${format(maximum)} | ${status} |`;
}

export function transferBudgetViolations(runs: ReadonlyArray<TransferBudgetRun>): string[] {
  const violations: string[] = [];
  for (const run of runs) {
    const budget = TRANSFER_BUDGETS[run.provider];
    if (!budget) {
      violations.push(`${run.provider}: no transfer budget is configured`);
      continue;
    }
    const checks = [
      ["total client-bound wire bytes", totalWireBytes(run), budget.totalWireBytes],
      ["document wire bytes", run.document.wireBytes, budget.documentWireBytes],
      ["shell snapshot wire bytes", run.shellSnapshot.wireBytes, budget.shellSnapshotWireBytes],
      ["thread snapshot wire bytes", run.threadSnapshot.wireBytes, budget.threadSnapshotWireBytes],
      [
        "cold-open WebSocket wire bytes",
        run.coldOpenWebSocket.wireBytes,
        budget.coldOpenWebSocketWireBytes,
      ],
      [
        "measured-turn WebSocket wire bytes",
        run.measuredTurnWebSocket.wireBytes,
        budget.measuredTurnWebSocketWireBytes,
      ],
      [
        "measured-turn WebSocket decoded bytes",
        run.measuredTurnWebSocket.decodedBytes,
        budget.measuredTurnWebSocketDecodedBytes,
      ],
      [
        "measured-turn WebSocket messages",
        run.measuredTurnWebSocket.messages,
        budget.measuredTurnWebSocketMessages,
      ],
    ] as const;
    for (const [metric, observed, maximum] of checks) {
      if (observed > maximum) {
        violations.push(`${run.provider}: ${metric} was ${observed}, maximum ${maximum}`);
      }
    }
  }
  return violations;
}

export function formatTransferBudgetReport(runs: ReadonlyArray<TransferBudgetRun>): string {
  const lines = [
    "# T3 Code basic-use transfer budget",
    "",
    "Wire values are client-bound bytes read from local HTTP and WebSocket sockets. They include HTTP response headers and the WebSocket upgrade, but exclude TCP/IP and TLS framing. WebSocket permessage-deflate is negotiated.",
    "",
    "| Provider | Total client-bound wire | Budget | Result |",
    "| --- | ---: | ---: | --- |",
    ...runs.flatMap((run) => {
      const budget = TRANSFER_BUDGETS[run.provider];
      if (!budget) return [];
      const observed = totalWireBytes(run);
      return [
        `| ${run.provider} | ${formatBytes(observed)} | ${formatBytes(budget.totalWireBytes)} | ${observed <= budget.totalWireBytes ? "PASS" : "FAIL"} |`,
      ];
    }),
    "",
    "## Detailed measurements",
    "",
    "| Provider | Phase | Metric | Observed | Budget | Result |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];

  for (const run of runs) {
    const budget = TRANSFER_BUDGETS[run.provider];
    if (!budget) continue;
    lines.push(
      row(run.provider, "document", "HTTP wire", run.document.wireBytes, budget.documentWireBytes),
      row(
        run.provider,
        "shell snapshot",
        "HTTP wire",
        run.shellSnapshot.wireBytes,
        budget.shellSnapshotWireBytes,
      ),
      row(
        run.provider,
        "thread snapshot",
        "HTTP wire",
        run.threadSnapshot.wireBytes,
        budget.threadSnapshotWireBytes,
      ),
      row(
        run.provider,
        "cold open",
        "WebSocket wire",
        run.coldOpenWebSocket.wireBytes,
        budget.coldOpenWebSocketWireBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket wire",
        run.measuredTurnWebSocket.wireBytes,
        budget.measuredTurnWebSocketWireBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket decoded",
        run.measuredTurnWebSocket.decodedBytes,
        budget.measuredTurnWebSocketDecodedBytes,
      ),
      row(
        run.provider,
        "measured turn",
        "WebSocket messages",
        run.measuredTurnWebSocket.messages,
        budget.measuredTurnWebSocketMessages,
        String,
      ),
    );
  }

  lines.push("", "## Compression diagnostics", "");
  for (const run of runs) {
    lines.push(
      `- ${run.provider}: document body ${formatBytes(run.document.encodedBodyBytes)}; shell ${formatBytes(run.shellSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.shellSnapshot.encodedBodyBytes)} gzip; thread ${formatBytes(run.threadSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.threadSnapshot.encodedBodyBytes)} gzip.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
