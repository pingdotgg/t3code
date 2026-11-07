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
import {
  LONG_TURN_WORK_ROWS,
  SHELL_IDLE_SUBAGENTS,
  SHELL_SETTLED_THREADS,
} from "./TransferBudgetV2Fixture.integration.ts";

export interface WebSocketCatchUpMeasurement extends WebSocketTransferTotals {
  readonly mode: "replay" | "snapshot";
}

export interface TimelineHttpMeasurement {
  readonly http: HttpTransferMeasurement;
  readonly rows: number;
}

export interface TransferBudgetRun {
  readonly provider: ProviderDriverKind;
  readonly threadSnapshot: HttpTransferMeasurement;
  readonly measuredTurnWebSocket: WebSocketTransferTotals;
  readonly shellSnapshot: HttpTransferMeasurement;
  readonly measuredTurnShellWebSocket: WebSocketTransferTotals;
  readonly measuredTurnSecondClientWebSocket: WebSocketTransferTotals;
  readonly reconnectThread: WebSocketCatchUpMeasurement;
  readonly reconnectShell: WebSocketCatchUpMeasurement;
  readonly measuredTurnSqlStatements: number;
  readonly reconnectSqlStatements: number;
  /** The compact bounded snapshot web and mobile load when the long-turn thread opens. */
  readonly longTurnColdOpen: TimelineHttpMeasurement;
  readonly longTurnHistoryPage: TimelineHttpMeasurement;
  /** The same reads as an older client that only sends `compactTurnItems`, to show the savings. */
  readonly longTurnColdOpenLegacy: TimelineHttpMeasurement;
  readonly longTurnHistoryPageLegacy: TimelineHttpMeasurement;
  /** The cold-connect shell snapshot after the settled-thread fleet is written. */
  readonly fleetShell: TimelineHttpMeasurement;
  readonly fleetShellLegacy: TimelineHttpMeasurement;
}

interface ProviderTransferBudget {
  readonly totalWireBytes: number;
  readonly threadSnapshotWireBytes: number;
  readonly measuredTurnWebSocketWireBytes: number;
  readonly measuredTurnWebSocketDecodedBytes: number;
  readonly measuredTurnWebSocketMessages: number;
}

// The measured turn decodes to about 22 KB; without live body dedupe its repeated answer makes it 26 KB.
const TRANSFER_BUDGET = {
  totalWireBytes: 7_000,
  threadSnapshotWireBytes: 5_000,
  measuredTurnWebSocketWireBytes: 2_000,
  measuredTurnWebSocketDecodedBytes: 25_000,
  measuredTurnWebSocketMessages: 8,
} satisfies ProviderTransferBudget;

const TRANSFER_BUDGETS: Readonly<Record<string, ProviderTransferBudget>> = {
  codex: TRANSFER_BUDGET,
  claudeAgent: TRANSFER_BUDGET,
};

// Decoded bytes, not wire bytes: phones parse and keep the decoded JSON. About 7% above the
// observed 103 KB, so a cold open without body dedupe (117 KB), the ID table, or row budgets
// (all 920 rows) fails. Kept apart from TRANSFER_BUDGET because the PR comment validates its keys.
const LONG_TURN_BUDGET = {
  decodedBytes: 110_000,
  rows: 75,
};

// About 30% above the observed 42 KB. Without the shell opt-ins it carries all 142 rows (217 KB).
const FLEET_SHELL_BUDGET = {
  decodedBytes: 55_000,
  rows: 27,
};

function totalWireBytes(run: TransferBudgetRun): number {
  return run.threadSnapshot.wireBytes + run.measuredTurnWebSocket.wireBytes;
}

function serverEgressWireBytes(run: TransferBudgetRun): number {
  return (
    run.measuredTurnWebSocket.wireBytes +
    run.measuredTurnShellWebSocket.wireBytes +
    run.measuredTurnSecondClientWebSocket.wireBytes
  );
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
        id: "thread-transfer-v2",
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

// The 50 ms shell batching makes transfer, reconnect and SQL figures timing-dependent.
function infoRow(
  provider: ProviderDriverKind,
  phase: string,
  metric: string,
  observed: number,
  format: (value: number) => string = formatBytes,
): string {
  return `| ${provider} | ${phase} | ${metric} | ${format(observed)} | none | INFO |`;
}

function webSocketRows(
  provider: ProviderDriverKind,
  phase: string,
  totals: WebSocketTransferTotals,
): string[] {
  return [
    infoRow(provider, phase, "WebSocket wire", totals.wireBytes),
    infoRow(provider, phase, "WebSocket decoded", totals.decodedBytes),
    infoRow(provider, phase, "WebSocket messages", totals.messages, String),
  ];
}

function timelineRows(
  provider: ProviderDriverKind,
  phase: string,
  measured: TimelineHttpMeasurement,
  budget: { readonly decodedBytes: number; readonly rows: number },
): string[] {
  return [
    infoRow(provider, phase, "HTTP wire", measured.http.wireBytes),
    row(provider, phase, "HTTP decoded", measured.http.decodedBodyBytes, budget.decodedBytes),
    row(provider, phase, "rows", measured.rows, budget.rows, String),
  ];
}

function legacyRows(
  provider: ProviderDriverKind,
  phase: string,
  measured: TimelineHttpMeasurement,
): string[] {
  return [
    infoRow(provider, `${phase}, older client`, "HTTP wire", measured.http.wireBytes),
    infoRow(provider, `${phase}, older client`, "HTTP decoded", measured.http.decodedBodyBytes),
    infoRow(provider, `${phase}, older client`, "rows", measured.rows, String),
  ];
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
      [
        "long-turn cold open decoded bytes",
        run.longTurnColdOpen.http.decodedBodyBytes,
        LONG_TURN_BUDGET.decodedBytes,
      ],
      ["long-turn cold open rows", run.longTurnColdOpen.rows, LONG_TURN_BUDGET.rows],
      [
        "long-turn history page decoded bytes",
        run.longTurnHistoryPage.http.decodedBodyBytes,
        LONG_TURN_BUDGET.decodedBytes,
      ],
      ["long-turn history page rows", run.longTurnHistoryPage.rows, LONG_TURN_BUDGET.rows],
      [
        "fleet shell snapshot decoded bytes",
        run.fleetShell.http.decodedBodyBytes,
        FLEET_SHELL_BUDGET.decodedBytes,
      ],
      ["fleet shell snapshot rows", run.fleetShell.rows, FLEET_SHELL_BUDGET.rows],
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
    "The measured turn is observed on three sockets at once: one with only the thread subscription (the capped rows), one with only the shell subscription, and a second client holding both. Server egress is the sum of the three. After the turn the second client disconnects and new sockets resubscribe from the cursor it held before the turn, which is the cursor a backgrounded phone would hold. SQL statements are the SQL client's per-statement spans, counted across V2 persistence and the HTTP/WebSocket handlers.",
    `Scenario: ${TRANSFER_HISTORY_TURN_COUNT} historical turns with ${TRANSFER_HISTORY_TOOLS_PER_TURN} command tools and one retained ${formatBytes(TRANSFER_HISTORY_MCP_RESULT_BYTES)} MCP result each, followed by one measured turn with ${TRANSFER_MEASURED_TOOLS} command tools and a retained ${formatBytes(TRANSFER_MEASURED_MCP_RESULT_BYTES)} MCP result. Synthetic V2 domain events exercise persistence, wire projection, and production HTTP/subscription handlers; this does not measure provider adapter ingestion. Payloads contain no user data.`,
    `The long-turn rows open a second thread through the compact bounded snapshot web and mobile use, then load one older page. Its last user turn holds ${LONG_TURN_WORK_ROWS} rows of reasoning, commands, file changes, MCP calls, progress messages, checkpoints, and subagents.`,
    `The fleet shell rows read the cold-connect shell after ${SHELL_SETTLED_THREADS} settled threads and ${SHELL_IDLE_SUBAGENTS} idle subagent children are added. Budgeted reads send the opt-ins current clients send; "older client" rows show the same read without the opt-ins added since row budgets.`,
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
      infoRow(run.provider, "shell snapshot", "HTTP wire", run.shellSnapshot.wireBytes),
      ...webSocketRows(run.provider, "measured turn, shell", run.measuredTurnShellWebSocket),
      ...webSocketRows(
        run.provider,
        "measured turn, second client",
        run.measuredTurnSecondClientWebSocket,
      ),
      infoRow(run.provider, "measured turn", "server egress wire", serverEgressWireBytes(run)),
      infoRow(
        run.provider,
        "measured turn",
        "SQL statements",
        run.measuredTurnSqlStatements,
        String,
      ),
      ...webSocketRows(
        run.provider,
        `reconnect, thread (${run.reconnectThread.mode})`,
        run.reconnectThread,
      ),
      ...webSocketRows(
        run.provider,
        `reconnect, shell (${run.reconnectShell.mode})`,
        run.reconnectShell,
      ),
      infoRow(run.provider, "reconnect", "SQL statements", run.reconnectSqlStatements, String),
      ...timelineRows(run.provider, "long-turn cold open", run.longTurnColdOpen, LONG_TURN_BUDGET),
      ...legacyRows(run.provider, "long-turn cold open", run.longTurnColdOpenLegacy),
      ...timelineRows(
        run.provider,
        "long-turn history page",
        run.longTurnHistoryPage,
        LONG_TURN_BUDGET,
      ),
      ...legacyRows(run.provider, "long-turn history page", run.longTurnHistoryPageLegacy),
      ...timelineRows(run.provider, "fleet shell snapshot", run.fleetShell, FLEET_SHELL_BUDGET),
      ...legacyRows(run.provider, "fleet shell snapshot", run.fleetShellLegacy),
    );
  }

  lines.push("", "## Compression diagnostics", "");
  for (const run of runs) {
    lines.push(
      `- ${run.provider}: thread snapshot ${formatBytes(run.threadSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.threadSnapshot.encodedBodyBytes)} gzip.`,
      `- ${run.provider}: shell snapshot ${formatBytes(run.shellSnapshot.decodedBodyBytes)} decoded to ${formatBytes(run.shellSnapshot.encodedBodyBytes)} gzip.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
