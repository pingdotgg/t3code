import type { ProviderDriverKind } from "@t3tools/contracts";

import type {
  HttpTransferMeasurement,
  WebSocketTransferTotals,
} from "./NetworkTransferMeasurement.integration.ts";
import {
  TRANSFER_HISTORY_MCP_RESULT_BYTES,
  TRANSFER_HISTORY_TOOLS_PER_TURN,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_MEASURED_MCP_RESULT_BYTES,
  TRANSFER_MEASURED_TOOLS,
} from "./fixtures/transferBudget.ts";

export interface TransferBudgetRun {
  readonly provider: ProviderDriverKind;
  readonly threadSnapshot: HttpTransferMeasurement;
  readonly measuredTurnWebSocket: WebSocketTransferTotals;
}

interface ProviderTransferBudget {
  readonly totalWireBytes: number;
  readonly threadSnapshotWireBytes: number;
  readonly measuredTurnWebSocketWireBytes: number;
  readonly measuredTurnWebSocketDecodedBytes: number;
  readonly measuredTurnWebSocketMessages: number;
}

// These caps leave roughly 30% headroom above the client projection of the
// deterministic 9 MB retained-result fixture. Full MCP results stay in
// persistence, so accidentally shipping them again exceeds these caps by
// orders of magnitude. The CI report preserves exact values for review.
const TRANSFER_BUDGET = {
  totalWireBytes: 15_500,
  threadSnapshotWireBytes: 7_500,
  measuredTurnWebSocketWireBytes: 8_000,
  measuredTurnWebSocketDecodedBytes: 68_000,
  measuredTurnWebSocketMessages: 21,
} satisfies ProviderTransferBudget;

export const TRANSFER_BUDGETS: Readonly<Record<string, ProviderTransferBudget>> = {
  codex: TRANSFER_BUDGET,
  claudeAgent: TRANSFER_BUDGET,
};

function totalWireBytes(run: TransferBudgetRun): number {
  return run.threadSnapshot.wireBytes + run.measuredTurnWebSocket.wireBytes;
}

function observedTransfer(run: TransferBudgetRun) {
  return {
    totalWireBytes: totalWireBytes(run),
    threadSnapshotWireBytes: run.threadSnapshot.wireBytes,
    threadSnapshotDecodedBytes: run.threadSnapshot.decodedBodyBytes,
    measuredTurnWebSocketWireBytes: run.measuredTurnWebSocket.wireBytes,
    measuredTurnWebSocketDecodedBytes: run.measuredTurnWebSocket.decodedBytes,
    measuredTurnWebSocketMessages: run.measuredTurnWebSocket.messages,
  };
}

/** Machine-readable input for the trusted PR comment publisher. */
export function formatTransferBudgetResult(runs: ReadonlyArray<TransferBudgetRun>): string {
  const providers = Object.fromEntries(
    runs.flatMap((run) => {
      const ceiling = TRANSFER_BUDGETS[run.provider];
      return ceiling ? [[run.provider, { observed: observedTransfer(run), ceiling }]] : [];
    }),
  );

  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scenario: {
        id: "thread-transfer-v1",
        historyTurns: TRANSFER_HISTORY_TURN_COUNT,
        historyCommandToolsPerTurn: TRANSFER_HISTORY_TOOLS_PER_TURN,
        historyMcpResultBytes: TRANSFER_HISTORY_MCP_RESULT_BYTES,
        measuredCommandTools: TRANSFER_MEASURED_TOOLS,
        measuredMcpResultBytes: TRANSFER_MEASURED_MCP_RESULT_BYTES,
      },
      providers,
    },
    null,
    2,
  )}\n`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes >= 1_024 * 1_024) {
    return `${(bytes / 1_024 / 1_024).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} B)`;
  }
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
      ["total thread wire bytes", totalWireBytes(run), budget.totalWireBytes],
      ["thread snapshot wire bytes", run.threadSnapshot.wireBytes, budget.threadSnapshotWireBytes],
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
    "# T3 Code thread transfer budget",
    "",
    "Wire values are thread data bytes read from local HTTP and WebSocket sockets. HTTP includes response headers; WebSocket measurement starts after the resumed thread subscription synchronizes. TCP/IP, TLS framing, and the WebSocket upgrade are excluded. WebSocket permessage-deflate is negotiated.",
    `Scenario: ${TRANSFER_HISTORY_TURN_COUNT} historical turns with ${TRANSFER_HISTORY_TOOLS_PER_TURN} command tools and one retained ${formatBytes(TRANSFER_HISTORY_MCP_RESULT_BYTES)} MCP result each, followed by one measured turn with ${TRANSFER_MEASURED_TOOLS} command tools and a retained ${formatBytes(TRANSFER_MEASURED_MCP_RESULT_BYTES)} MCP result. Payload sizes are calibrated from heavy local Codex and Claude histories and contain no user data.`,
    "",
    "| Provider | Total thread wire | Budget | Result |",
    "| --- | ---: | ---: | --- |",
    ...runs.flatMap((run) => {
      const budget = TRANSFER_BUDGETS[run.provider];
      if (!budget) return [];
      const observed = observedTransfer(run).totalWireBytes;
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
      row(
        run.provider,
        "thread snapshot",
        "HTTP wire",
        run.threadSnapshot.wireBytes,
        budget.threadSnapshotWireBytes,
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
      `- ${run.provider}: thread snapshot ${formatBytes(run.threadSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.threadSnapshot.encodedBodyBytes)} gzip.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
