// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side evidence driver retains raw wire evidence and owns deadline timers.
// Runtime evidence for withdrawn Claude AskUserQuestion requests. Starts a real
// server from --worktree against an isolated --home, backs the claudeAgent
// instance with testFixtures/claudeQuestionMockCli.mjs, and records what the
// database, the subscribeThread stream and the fixture saw for each row:
//   node apps/server/scripts/claude-question-withdrawal-evidence.ts \
//     --worktree <tree> --home /tmp/<rev>/home --out /tmp/<rev> --row all
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

const ROWS = ["A1", "A2", "A3", "A4", "B", "C"] as const;
type Row = (typeof ROWS)[number];
const { values } = NodeUtil.parseArgs({
  options: {
    worktree: { type: "string" },
    home: { type: "string" },
    out: { type: "string" },
    row: { type: "string", default: "all" },
    timeout: { type: "string", default: "60" },
  },
});
NodeAssert.ok(
  values.worktree && values.home && values.out,
  "--worktree, --home and --out are required",
);
const worktree = NodePath.resolve(values.worktree);
const home = NodePath.resolve(values.home);
const out = NodePath.resolve(values.out);
NodeAssert.ok(
  !home.startsWith(NodePath.join(NodeOS.homedir(), ".t3")),
  "--home must not point at the live T3 home",
);
const rows: ReadonlyArray<Row> =
  values.row === "all"
    ? ROWS
    : [ROWS.find((row) => row === values.row) ?? NodeAssert.fail("bad --row")];
const timeoutMs = Number(values.timeout) * 1000;
const fixture = NodePath.resolve(
  import.meta.dirname,
  "../src/provider/testFixtures/claudeQuestionMockCli.mjs",
);
const traces = NodePath.join(out, "traces");

NodeFS.rmSync(home, { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(home, "claude-home"), { recursive: true });
NodeFS.mkdirSync(traces, { recursive: true });
for (const row of rows) {
  for (const name of NodeFS.readdirSync(traces)) {
    if (name.startsWith(`${row}-`) || name.startsWith(`${row}.`)) {
      NodeFS.rmSync(NodePath.join(traces, name));
    }
  }
}
NodeFS.writeFileSync(
  NodePath.join(home, "userdata", "settings.json"),
  JSON.stringify({
    providerInstances: {
      claudeAgent: {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: fixture, homePath: NodePath.join(home, "claude-home") },
      },
    },
  }),
);
const project = NodePath.join(home, "project");
NodeFS.mkdirSync(project);
NodeChildProcess.execFileSync("git", ["init", "-q", project]);
NodeChildProcess.execFileSync("git", [
  "-C",
  project,
  "-c",
  "user.name=Evidence",
  "-c",
  "user.email=evidence@localhost",
  "commit",
  "--allow-empty",
  "-qm",
  "initial",
]);
const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
const manifest = {
  worktree,
  revision: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]),
  fixture,
  fixtureSha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(fixture)).digest("hex"),
  driverSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(import.meta.filename))
    .digest("hex"),
  node: process.version,
  startedAt: new Date().toISOString(),
};
NodeFS.writeFileSync(NodePath.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
const serverLog = NodePath.join(out, "server.log");
NodeFS.writeFileSync(serverLog, "");
const server = NodeChildProcess.spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "start",
    "--bootstrap-fd",
    "3",
    "--base-dir",
    home,
    "--log-level",
    "debug",
  ],
  {
    cwd: worktree,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    // An ambient T3CODE_HOME outranks the bootstrap t3Home and would point the
    // server at the live install; --base-dir pins the isolated home instead.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("T3CODE_")),
    ),
  },
);
console.log(`server pid ${server.pid} port ${port} cwd ${worktree}`);
NodeFS.appendFileSync(NodePath.join(out, "pids.txt"), `server ${server.pid} port ${port}\n`);
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const ready = Promise.withResolvers<void>();
let recentOutput = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(serverLog, text);
    recentOutput = (recentOutput + text).slice(-8192);
    if (recentOutput.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  60_000,
);

const db = () =>
  new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
function dbCapture(threadId: string) {
  const handle = db();
  try {
    return {
      events: handle
        .prepare(
          `SELECT sequence, event_type, command_id,
                  json_extract(metadata_json,'$.driver') driver,
                  json_extract(payload_json,'$.id') id,
                  json_extract(payload_json,'$.status') status,
                  json_extract(payload_json,'$.kind') kind,
                  json_extract(payload_json,'$.type') item_type,
                  json_extract(payload_json,'$.nativeRequestRef.nativeId') native_id,
                  json_extract(payload_json,'$.resolvedAt') resolved_at,
                  occurred_at
           FROM orchestration_events
           WHERE stream_id = ? AND event_type IN
             ('runtime-request.updated','node.updated','turn-item.updated','provider-turn.updated','run.updated')
           ORDER BY sequence`,
        )
        .all(threadId),
      runtimeRequests: handle
        .prepare(
          `SELECT runtime_request_id id, kind, status, resolved_at,
                  json_extract(payload_json,'$.nativeRequestRef.nativeId') native_id
           FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ?`,
        )
        .all(threadId),
    };
  } finally {
    handle.close();
  }
}

type RequestState = { id: string; nativeId: string | null; kind: string; status: string };
class RowStream {
  readonly items: Array<OrchestrationV2ThreadStreamItem> = [];
  readonly requests = new Map<string, RequestState>();
  readonly runs = new Map<string, string>();
  readonly log: Array<string> = [];
  private listeners = new Set<() => void>();
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  push(item: OrchestrationV2ThreadStreamItem) {
    this.items.push(item);
    NodeFS.appendFileSync(this.file, JSON.stringify(item) + "\n");
    if (item.kind === "snapshot") {
      for (const request of item.projection.runtimeRequests) this.setRequest(request);
      for (const run of item.projection.runs) this.runs.set(run.id, run.status);
      this.log.push(
        `snapshot@${item.snapshotSequence} requests=${JSON.stringify([...this.requests.values()].map((r) => ({ ...r, id: short(r.id) })))} runs=${JSON.stringify([...this.runs])}`,
      );
    } else if (item.kind === "event") {
      const event = item.event;
      const payload: Record<string, unknown> =
        "payload" in event && typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      if (event.type === "runtime-request.updated") this.setRequest(payload);
      if (event.type === "run.updated") this.runs.set(String(payload.id), String(payload.status));
      if (
        [
          "runtime-request.updated",
          "node.updated",
          "turn-item.updated",
          "provider-turn.updated",
          "run.updated",
        ].includes(event.type)
      ) {
        this.log.push(
          `event seq=${item.sequence} ${event.type} id=${short(payload.id)} status=${String(payload.status)}${
            payload.kind ? ` kind=${String(payload.kind)}` : ""
          }${payload.type ? ` type=${String(payload.type)}` : ""}${
            event.type === "runtime-request.updated" ? ` native=${nativeIdOf(payload)}` : ""
          }`,
        );
      }
    }
    for (const listener of this.listeners) listener();
  }
  private setRequest(payload: Record<string, unknown> | RequestState | object) {
    const record = payload as Record<string, unknown>;
    this.requests.set(String(record.id), {
      id: String(record.id),
      nativeId: nativeIdOf(record),
      kind: String(record.kind),
      status: String(record.status),
    });
  }
  pending() {
    return [...this.requests.values()].filter(
      (request) => request.kind === "user_input" && request.status === "pending",
    );
  }
  request(nativeId: string) {
    return [...this.requests.values()].find((request) => request.nativeId === nativeId);
  }
  waitFor(label: string, predicate: () => boolean) {
    return Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const check = () => {
            if (!predicate()) return;
            this.listeners.delete(check);
            clearTimeout(deadline);
            resolve();
          };
          const deadline = setTimeout(() => {
            this.listeners.delete(check);
            reject(new Error(`Timed out waiting for ${label}`));
          }, timeoutMs);
          this.listeners.add(check);
          check();
        }),
    );
  }
}
// Ids embed the whole thread/turn path; keep the head and the distinguishing tail.
const short = (value: unknown) => {
  const text = String(value ?? "-");
  return text.length > 72 ? `${text.slice(0, 28)}…${text.slice(-40)}` : text;
};
function nativeIdOf(record: Record<string, unknown>) {
  const ref = record.nativeRequestRef;
  return typeof ref === "object" && ref !== null && "nativeId" in ref
    ? String((ref as { nativeId: unknown }).nativeId)
    : null;
}
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const isoNow = () => new Date().toISOString();
const sleep = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));
const touch = (path: string) => Effect.sync(() => NodeFS.writeFileSync(path, ""));
function readTraces(row: Row) {
  return NodeFS.readdirSync(traces)
    .filter((name) => name.startsWith(`${row}-`) && name.endsWith(".ndjson"))
    .flatMap((name) =>
      NodeFS.readFileSync(NodePath.join(traces, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ file: name, ...JSON.parse(line) })),
    );
}
function summarizeTrace(row: Row) {
  return readTraces(row).map((entry) => {
    if (entry.event) return `${entry.file} ${entry.event} code=${entry.code}`;
    const frame = entry.frame ?? {};
    const request = frame.request ?? {};
    const response = frame.response ?? {};
    const toolUse = frame.message?.content?.find?.(
      (part: { type?: string }) => part.type === "tool_use" || part.type === "tool_result",
    );
    return [
      entry.dir,
      frame.type,
      request.subtype ?? frame.subtype ?? "",
      frame.request_id ?? response.request_id ?? "",
      request.tool_use_id ?? toolUse?.id ?? toolUse?.tool_use_id ?? "",
      response.response?.behavior ? `behavior=${response.response.behavior}` : "",
      response.response?.message ? `message=${JSON.stringify(response.response.message)}` : "",
      response.response?.updatedInput?.answers
        ? `answers=${JSON.stringify(response.response.updatedInput.answers)}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
}

const results: Array<Record<string, unknown>> = [];
try {
  await ready.promise;
  clearTimeout(startupDeadline);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Question withdrawal evidence",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);

  for (const row of rows) {
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers,
    });
    NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
    const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
      await ticketResponse.json(),
    );
    const layerProtocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
        ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    const streamFile = NodePath.join(out, `${row}.stream.ndjson`);
    NodeFS.writeFileSync(streamFile, "");
    const stream = new RowStream(streamFile);
    const checkpoints: Array<Record<string, unknown>> = [];
    const checkpoint = (label: string) =>
      Effect.sync(() => {
        const snapshot = {
          label,
          at: isoNow(),
          streamPending: stream.pending(),
          streamRequests: [...stream.requests.values()],
          streamRuns: Object.fromEntries(stream.runs),
          db: dbCapture(threadId),
        };
        checkpoints.push(snapshot);
        stream.log.push(
          `-- checkpoint ${label}: stream pending=${JSON.stringify(snapshot.streamPending.map((r) => r.nativeId))}`,
        );
      });
    const program = Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const dispatch = (
        command: Parameters<(typeof client)["orchestration.dispatchCommand"]>[0],
      ) => {
        stream.log.push(`-> dispatch ${command.type}`);
        return client["orchestration.dispatchCommand"](command);
      };
      yield* client["orchestration.launchThread"]({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId,
        title: `Question withdrawal ${row}`,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: `ROW:${row} TRACE:${traces} Ask me Red or Blue.`, attachments: [] },
      });
      // Subscribing before the launch commits finds no thread and ends the stream.
      yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEach((item) => Effect.sync(() => stream.push(item))),
        Effect.catchCause((cause) =>
          Effect.sync(() => stream.log.push(`stream ended: ${String(cause)}`)),
        ),
        Effect.forkScoped,
      );
      yield* stream.waitFor(
        "Q1 pending on the stream",
        () => stream.request("toolu_q1")?.status === "pending",
      );
      yield* checkpoint("Q1 pending (before action)");
      const q1 = stream.request("toolu_q1")!;
      const activeRun = () =>
        [...stream.runs].find(([, status]) => !TERMINAL_RUN.has(status))?.[0] ??
        NodeAssert.fail("no active run");
      const answer = (requestId: string) =>
        dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          requestId: RuntimeRequestId.make(requestId),
          answers: { "Red or Blue?": "Blue" },
        });
      switch (row) {
        case "A1":
          yield* dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            runId: RunId.make(activeRun()),
            reason: "evidence A1",
          });
          break;
        case "A2":
          yield* dispatch({
            type: "thread.stop",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            reason: "evidence A2",
          });
          break;
        case "A3":
          stream.log.push("-> touch A3.die (fixture exits 1)");
          yield* touch(NodePath.join(traces, "A3.die"));
          break;
        case "A4":
          stream.log.push("-> touch A4.cancel (fixture sends control_cancel_request cu_q1)");
          yield* touch(NodePath.join(traces, "A4.cancel"));
          yield* stream.waitFor(
            "Q2 pending on the stream",
            () => stream.request("toolu_q2")?.status === "pending",
          );
          yield* checkpoint("K: Q2 pending, turn alive");
          yield* answer(stream.request("toolu_q2")!.id);
          break;
        case "B":
        case "C":
          yield* answer(q1.id);
          break;
      }
      yield* stream.waitFor(
        "run terminal",
        () =>
          stream.runs.size > 0 &&
          [...stream.runs.values()].every((status) => TERMINAL_RUN.has(status)),
      );
      // Late provider events (the adapter's own cancellation racing the
      // terminal cleanup) land within this window.
      yield* sleep(1500);
      yield* checkpoint("final");
      return yield* client["orchestration.getThreadProjection"]({ threadId });
    }).pipe(Effect.scoped, Effect.provide(layerProtocol));
    let projection: unknown = null;
    let error: string | null = null;
    try {
      projection = await Effect.runPromise(program);
    } catch (cause) {
      error = String(cause);
      console.error(`${row}: ${error}`);
    }
    // A1–A3 end the fixture process; wait briefly for its exit record.
    for (let attempt = 0; attempt < 40 && ["A1", "A2", "A3"].includes(row); attempt++) {
      if (readTraces(row).some((entry) => entry.event === "exit")) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    const final = dbCapture(threadId);
    const q1Events = (final.events as Array<Record<string, unknown>>).filter(
      (event) => event.event_type === "runtime-request.updated" && event.native_id === "toolu_q1",
    );
    const kPoint = checkpoints.find((point) => String(point.label).startsWith("K"));
    const q2PendingSeq = (final.events as Array<Record<string, unknown>>).find(
      (event) =>
        event.event_type === "runtime-request.updated" &&
        event.native_id === "toolu_q2" &&
        event.status === "pending",
    )?.sequence;
    const q1CancelSeqs = q1Events
      .filter((event) => event.status === "cancelled")
      .map((event) => event.sequence);
    const summary = {
      row,
      threadId,
      error,
      q1Statuses: q1Events.map((event) => `${String(event.sequence)}:${String(event.status)}`),
      q1CancelledCount: q1CancelSeqs.length,
      q1Resolved: q1Events.some((event) => event.status === "resolved"),
      runs: Object.fromEntries(stream.runs),
      ...(row === "A4"
        ? {
            atK_streamPending: (kPoint?.streamPending as Array<RequestState> | undefined)?.map(
              (r) => r.nativeId,
            ),
            atK_dbPending: (
              (kPoint?.db as ReturnType<typeof dbCapture> | undefined)?.runtimeRequests as
                | Array<Record<string, unknown>>
                | undefined
            )
              ?.filter((r) => r.status === "pending")
              .map((r) => r.native_id),
            q2PendingSeq,
            q1CancelledBeforeQ2: q1CancelSeqs.some((seq) => Number(seq) < Number(q2PendingSeq)),
          }
        : {}),
    };
    results.push(summary);
    NodeFS.writeFileSync(
      NodePath.join(out, `${row}.db.json`),
      JSON.stringify({ checkpoints, final, projection }, null, 2),
    );
    const table = (records: ReadonlyArray<Record<string, unknown>>) =>
      records.map((record) => Object.values(record).map(short).join(" | "));
    NodeFS.writeFileSync(
      NodePath.join(out, `${row}.txt`),
      [
        `# Row ${row} — fixture: claudeQuestionMockCli`,
        `revision ${manifest.revision} (${worktree})`,
        `fixture sha256 ${manifest.fixtureSha256}  driver sha256 ${manifest.driverSha256}`,
        `thread ${threadId}  server port ${port} pid ${server.pid}`,
        "",
        "## Summary",
        JSON.stringify(summary, null, 2),
        "",
        "## Client stream (orchestration.subscribeThread), relevant items in arrival order",
        ...stream.log,
        "",
        "## Persisted events (orchestration_events, stream_id = thread)",
        "sequence | event_type | command_id | driver | id | status | kind | item_type | native_id | resolved_at | occurred_at",
        ...table(final.events as Array<Record<string, unknown>>),
        "",
        "## Checkpoint projection rows (orchestration_v2_projection_runtime_requests)",
        ...checkpoints.flatMap((point) => [
          `-- ${String(point.label)}`,
          ...table(
            (point.db as ReturnType<typeof dbCapture>).runtimeRequests as Array<
              Record<string, unknown>
            >,
          ),
        ]),
        "-- after row",
        ...table(final.runtimeRequests as Array<Record<string, unknown>>),
        "",
        "## Fixture trace (dir type subtype request_id tool_use_id ...)",
        ...summarizeTrace(row),
        "",
      ].join("\n"),
    );
    console.log(JSON.stringify(summary));
  }
} finally {
  NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(results, null, 2));
  await stopServer();
}

async function stopServer() {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  if (server.pid) {
    try {
      // The server and the fixture processes it spawned share this process group.
      process.kill(-server.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
