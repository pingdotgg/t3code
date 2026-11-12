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
  STALE_TODO_LIVE_ROWS,
  STALE_TODO_SETTLED_RUNS,
  STALE_TODO_SUBAGENTS_PER_RUN,
} from "./TransferBudgetV2Fixture.integration.ts";

export interface WebSocketCatchUpMeasurement extends WebSocketTransferTotals {
  readonly mode: "replay" | "snapshot";
}

export interface TimelineHttpMeasurement {
  readonly http: HttpTransferMeasurement;
  readonly rows: number;
}

const STALE_TODO_RECORD_KINDS = [
  "nodes",
  "subagents",
  "plans",
  "providerTurns",
  "checkpoints",
] as const;
type StaleTodoRecordCounts = Readonly<Record<(typeof STALE_TODO_RECORD_KINDS)[number], number>>;

/** One new socket, read from the subscribe call until the subscription caught up. */
export interface SocketOpenMeasurement {
  readonly totals: WebSocketTransferTotals;
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
  /** A thread resumed from the cursor it held before one ordinary turn. */
  readonly shortTurnResume: SocketOpenMeasurement;
  /** The long-turn thread while its last turn runs: the bounded snapshot, then one older page. */
  readonly longTurnRunningColdOpen: TimelineHttpMeasurement;
  readonly longTurnRunningHistoryPage: TimelineHttpMeasurement;
  /** The same reads as an older client that only sends `compactTurnItems`, to show the savings. */
  readonly longTurnRunningColdOpenLegacy: TimelineHttpMeasurement;
  readonly longTurnRunningHistoryPageLegacy: TimelineHttpMeasurement;
  /** The same thread once the turn finished, over HTTP (web) and over the socket alone (mobile). */
  readonly longTurnColdOpen: TimelineHttpMeasurement;
  readonly longTurnSocketColdOpen: SocketOpenMeasurement & { readonly rows: number };
  /** The first page of the finished turn's deferred work, loaded when its group is expanded. */
  readonly longTurnWorkPage: TimelineHttpMeasurement;
  /** A thread resumed from the cursor of its own last event. */
  readonly idleThreadResume: SocketOpenMeasurement;
  /** The cold-connect shell snapshot after the settled-thread fleet is written. */
  readonly fleetShell: TimelineHttpMeasurement;
  readonly fleetShellLegacy: TimelineHttpMeasurement;
  /** The shell subscription a cold connect opens from that snapshot's cursor. */
  readonly fleetShellSubscribe: SocketOpenMeasurement;
  /** A client that holds that snapshot's rows asks the HTTP route whether they still resume. */
  readonly fleetShellResume: TimelineHttpMeasurement;
  /** The same question from a cursor too old to replay: the route answers with the snapshot. */
  readonly staleShellReload: TimelineHttpMeasurement;
  /** A shell resumed over the socket from that old cursor, by a client that reloads over HTTP. */
  readonly staleShellResume: SocketOpenMeasurement;
  /**
   * The compact bounded snapshot of the long thread whose finished runs left todo lists open,
   * with the count of each record kind that rides along with its rows.
   */
  readonly staleTodoColdOpen: TimelineHttpMeasurement & {
    readonly records: StaleTodoRecordCounts;
  };
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

// Decoded bytes, not wire bytes: phones parse and keep the decoded JSON. About 15% above the
// observed 95 KB history page, so a page without the ID table (130 KB) or row budgets fails.
// Kept apart from TRANSFER_BUDGET because the PR comment validates its keys.
const LONG_TURN_PAGE_BUDGET = {
  decodedBytes: 110_000,
  rows: 75,
};

// About 7% above the observed 290 KB. The window holds 75 rows, but every message of a running
// turn rides along with it: 196 KB here. Without body dedupe or the ID table it is 354 KB.
const LONG_TURN_RUNNING_BUDGET = {
  decodedBytes: 310_000,
  rows: 75,
};

// About 7% above the observed 393 KB. A finished turn defers its 770 work rows and stays whole:
// 151 rows of messages, checkpoints and subagents, on both transports.
const LONG_TURN_FINISHED_BUDGET = {
  decodedBytes: 420_000,
  rows: 151,
};

// About 6% above the observed 193 KB: one older page of work, twice the cold-open row budget.
const LONG_TURN_WORK_PAGE_BUDGET = {
  decodedBytes: 205_000,
  rows: 150,
};

const SOCKET_BUDGETS = {
  // One ordinary turn replays in 11 KB. With its tool bodies it is over 900 KB.
  shortTurnResume: { decodedBytes: 13_000, messages: 2 },
  longTurnColdOpen: { decodedBytes: LONG_TURN_FINISHED_BUDGET.decodedBytes, messages: 2 },
  // These three send no rows. A snapshot in their place is 393 KB for the thread, 42 KB for the shell.
  idleThreadResume: { decodedBytes: 200, messages: 1 },
  // A subscribe that does not name the snapshot's project identities gets the project again: 851 B.
  fleetShellSubscribe: { decodedBytes: 200, messages: 1 },
  staleShellResume: { decodedBytes: 400, messages: 2 },
};

// About 30% above the observed 42 KB. Without the shell opt-ins it carries all 142 rows (217 KB).
const FLEET_SHELL_BUDGET = {
  decodedBytes: 55_000,
  rows: 27,
};

// The answer is `{"resumable":true}`. A snapshot in its place is 42 KB.
const FLEET_SHELL_RESUME_BUDGET = {
  decodedBytes: 100,
  rows: 0,
};

// About 14% above the observed 75 KB. The window holds the working run only: 2 nodes, 2 subagents,
// 1 plan, 1 provider turn and the last finished turn's checkpoint. When finished runs ride along
// it holds 82 nodes, 82 subagents, 41 plans, 41 provider turns, 40 checkpoints and 740 KB.
// The working run's ready handoff ships without its 256 KB history; with it the open is 339 KB.
const STALE_TODO_BUDGET = {
  decodedBytes: 85_000,
  rows: 75,
  records: {
    nodes: 4,
    subagents: 4,
    plans: 2,
    providerTurns: 2,
    checkpoints: 2,
  } satisfies StaleTodoRecordCounts,
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

interface ScenarioRow {
  readonly phase: string;
  readonly metric: string;
  readonly unit: "bytes" | "count";
  readonly observed: number;
  /** Absent on figures that only inform: wire bytes, and what an older client receives. */
  readonly maximum: number | undefined;
}

function httpRows(
  phase: string,
  measured: TimelineHttpMeasurement,
  budget?: { readonly decodedBytes: number; readonly rows: number },
): ScenarioRow[] {
  return [
    {
      phase,
      metric: "HTTP wire",
      unit: "bytes",
      observed: measured.http.wireBytes,
      maximum: undefined,
    },
    {
      phase,
      metric: "HTTP decoded",
      unit: "bytes",
      observed: measured.http.decodedBodyBytes,
      maximum: budget?.decodedBytes,
    },
    { phase, metric: "rows", unit: "count", observed: measured.rows, maximum: budget?.rows },
  ];
}

function socketRows(
  phase: string,
  { totals }: SocketOpenMeasurement,
  budget: { readonly decodedBytes: number; readonly messages: number },
): ScenarioRow[] {
  return [
    {
      phase,
      metric: "WebSocket wire",
      unit: "bytes",
      observed: totals.wireBytes,
      maximum: undefined,
    },
    {
      phase,
      metric: "WebSocket decoded",
      unit: "bytes",
      observed: totals.decodedBytes,
      maximum: budget.decodedBytes,
    },
    {
      phase,
      metric: "WebSocket messages",
      unit: "count",
      observed: totals.messages,
      maximum: budget.messages,
    },
  ];
}

/**
 * Every scenario figure beyond the thread totals. The violations, the report table and the PR
 * comment's scenario file all read this list, so a row added here reaches all three. The PR
 * comment only accepts letters, digits, spaces, commas and hyphens in `phase` and `metric`.
 */
function scenarioRows(run: TransferBudgetRun): ScenarioRow[] {
  return [
    ...socketRows("short turn resume", run.shortTurnResume, SOCKET_BUDGETS.shortTurnResume),
    ...httpRows(
      "long turn running, cold open",
      run.longTurnRunningColdOpen,
      LONG_TURN_RUNNING_BUDGET,
    ),
    ...httpRows("long turn running, cold open, older client", run.longTurnRunningColdOpenLegacy),
    ...httpRows(
      "long turn running, history page",
      run.longTurnRunningHistoryPage,
      LONG_TURN_PAGE_BUDGET,
    ),
    ...httpRows(
      "long turn running, history page, older client",
      run.longTurnRunningHistoryPageLegacy,
    ),
    ...httpRows("long turn finished, cold open", run.longTurnColdOpen, LONG_TURN_FINISHED_BUDGET),
    ...socketRows(
      "long turn finished, socket cold open",
      run.longTurnSocketColdOpen,
      SOCKET_BUDGETS.longTurnColdOpen,
    ),
    {
      phase: "long turn finished, socket cold open",
      metric: "rows",
      unit: "count",
      observed: run.longTurnSocketColdOpen.rows,
      maximum: LONG_TURN_FINISHED_BUDGET.rows,
    },
    ...httpRows("long turn finished, work page", run.longTurnWorkPage, LONG_TURN_WORK_PAGE_BUDGET),
    ...socketRows("idle thread resume", run.idleThreadResume, SOCKET_BUDGETS.idleThreadResume),
    ...httpRows("fleet shell snapshot", run.fleetShell, FLEET_SHELL_BUDGET),
    ...httpRows("fleet shell snapshot, older client", run.fleetShellLegacy),
    ...socketRows(
      "fleet shell subscribe",
      run.fleetShellSubscribe,
      SOCKET_BUDGETS.fleetShellSubscribe,
    ),
    ...httpRows("fleet shell resume check", run.fleetShellResume, FLEET_SHELL_RESUME_BUDGET),
    ...httpRows("stale shell reload", run.staleShellReload, FLEET_SHELL_BUDGET),
    ...socketRows("stale shell resume", run.staleShellResume, SOCKET_BUDGETS.staleShellResume),
    ...httpRows("stale todo list cold open", run.staleTodoColdOpen, STALE_TODO_BUDGET),
    ...STALE_TODO_RECORD_KINDS.map((kind): ScenarioRow => ({
      phase: "stale todo list cold open",
      metric: kind,
      unit: "count",
      observed: run.staleTodoColdOpen.records[kind],
      maximum: STALE_TODO_BUDGET.records[kind],
    })),
  ];
}

/** The budgeted scenario figures, for the PR comment to compare with `main`. */
export function formatTransferBudgetScenarios(runs: ReadonlyArray<TransferBudgetRun>): string {
  const providers = Object.fromEntries(
    runs.map((run) => [
      run.provider,
      scenarioRows(run).flatMap(({ maximum, ...row }) =>
        maximum === undefined ? [] : [{ ...row, ceiling: maximum }],
      ),
    ]),
  );
  return `${JSON.stringify({ schemaVersion: 1, providers }, null, 2)}\n`;
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
      ...scenarioRows(run).flatMap(({ phase, metric, observed, maximum }) =>
        maximum === undefined ? [] : [[`${phase} ${metric}`, observed, maximum] as const],
      ),
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
    `The long turn rows read a second thread whose last user turn holds ${LONG_TURN_WORK_ROWS} rows of reasoning, commands, file changes, MCP calls, progress messages, checkpoints, and subagents. While that turn runs, web and mobile load the compact bounded snapshot and then one older page. Once it finishes, its work is deferred: the cold open is read over HTTP as web does and over the socket alone as mobile does, then the first page of the deferred work is loaded as an expanded work group does.`,
    "The resume rows open a new socket from a cursor the client already holds: the first thread after one more ordinary turn, the long-turn thread with nothing new, and the shell from a cursor too old to replay. A client that holds shell rows first names their cursor to the HTTP shell route: the resume check row is the answer that keeps the rows, and the stale shell reload row is the snapshot that replaces them.",
    `The fleet shell rows read the cold-connect shell after ${SHELL_SETTLED_THREADS} settled threads and ${SHELL_IDLE_SUBAGENTS} idle subagent children are added, then subscribe from that snapshot's cursor and name its project identities, so the project's repository identity is not sent again. Budgeted reads send the opt-ins current clients send; "older client" rows show the same read without the opt-ins added since row budgets.`,
    `The stale todo list rows open a third thread the same way: ${STALE_TODO_SETTLED_RUNS} finished runs, then one run still at work with ${STALE_TODO_LIVE_ROWS} rows. Every run left its todo list open and has ${STALE_TODO_SUBAGENTS_PER_RUN} finished subagents, a provider turn and, once finished, a checkpoint. The record counts must not grow with the number of finished runs.`,
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
      ...scenarioRows(run).map(({ phase, metric, unit, observed, maximum }) => {
        const format = unit === "bytes" ? formatBytes : String;
        return maximum === undefined
          ? infoRow(run.provider, phase, metric, observed, format)
          : row(run.provider, phase, metric, observed, maximum, format);
      }),
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
