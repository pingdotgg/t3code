// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off globalDate:off globalRandom:off - a standalone benchmark driver around one server process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const HELP = `Usage:
  node scripts/server-metrics.ts run [--out <file>] [--checkout <dir>] [--repeat <k>] [run options]
  node scripts/server-metrics.ts ab <checkoutA> <checkoutB> [--rounds <k>] [--out-dir <dir>] [run options]
  node scripts/server-metrics.ts compare <before.json> <after.json> [--threshold <percent>]

run      Starts a checkout's server (default: this one) against a temp base dir, a temp HOME, a
         temp git project and a fake Anthropic Messages API, drives the real \`claude\` CLI
         through it, and writes one JSON object of measurements. Each scenario gets a fresh
         server. A full run takes about 8 minutes. --repeat runs it k times into one file.
ab       Runs two checkouts alternately (A B, then B A, ... for --rounds, default 3) on this
         machine, writes a.json and b.json, prints the comparison and exits 1 on a regression.
         Each checkout needs its dependencies installed; the server code comes from it, the
         harness from this script, so an old release works too.

Scenarios (--only startup,rest,firstWord,quiet,streaming; soak runs only with --soak):
  startup    spawn to the first HTTP answer, in ms.
  rest       30 s idle: server CPU %, wakeups/s, RSS peak and after GC, heap after a forced GC.
  firstWord  --runs (default 5) sequential \`thread start\` runs in the project folder and in a
             new worktree: ms until the fake API receives the agent's request, and until the
             reply finished. Median and p90.
  quiet      Claude threads that answered and stay open, measured at --threads (default
             0,5,10,20) for 30 s each. \`quiet\` is the last point; \`scaling\` is the
             least-squares cost per open thread (fitted from 1 thread up, since the first loads
             the provider once): MB of heap and RSS, CPU points, wakeups/s.
  streaming  5 threads streaming a 2,000-word reply at 50 ms a word, 60 s window.
  soak       --soak <minutes> (alone unless --only names more): 10 threads, a short turn to one of them every 30 s, heap after GC
             and RSS every 2 minutes; reports MB/hour slopes and writes the constructors whose
             heap grew most between a snapshot after warmup and one at the end.
After the quiet and streaming windows a separate 20 s window records a CPU profile and a
sampling allocation profile; the top functions go in the JSON, the full profiles next to --out.

--no-agent-scope (alias --mac-path), Linux only: starts the server without XDG_RUNTIME_DIR, so
it has no agent scope and takes the per-process path macOS and Windows always take.
Wakeups: Linux sums the server's voluntary and involuntary context switches (/proc); macOS
uses \`top\`'s context-switch count; Windows sums its threads' context switches (CIM).
Only the server process is measured, not the agent CLIs.

compare  Prints a markdown table of every metric (lower is better). With two or more runs on each
         side a metric is worse only when the 95% bootstrap interval of the median difference
         lies above both --threshold percent (default 10) and its noise floor: 1 point of CPU,
         20 wakeups/s, 15 MB, 300 ms, 2 MB per thread, 0.2 CPU points per thread. With one run
         on a side it compares the two values against the same limits. Exits 1 on a regression.`;

const harnessRoot = NodePath.resolve(import.meta.dirname, "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const platform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const architecture = NodeOS.arch();
const MODEL = "claude-haiku-4-5";
const SLOW_MARKER = "[[stream-slowly]]";

interface Window {
  readonly cpuPct: number;
  readonly wakeupsPerSec: number | null;
  readonly rssPeakMB: number;
  readonly rssMB: number;
  readonly heapAfterGcMB: number;
}
interface Spread {
  readonly median: number;
  readonly p90: number;
}
interface FirstWord {
  readonly toRequestMs: Spread;
  readonly toDoneMs: Spread;
}
interface Scaling {
  readonly heapMBPerThread: number;
  readonly rssMBPerThread: number;
  readonly cpuPctPerThread: number;
  readonly wakeupsPerThread: number | null;
  /** Each measured point as [threads, cpuPct, wakeupsPerSec, rssMB, heapAfterGcMB]; not compared. */
  readonly points: ReadonlyArray<ReadonlyArray<number | null>>;
}
interface Soak {
  readonly minutes: number;
  readonly heapMBPerHour: number;
  readonly rssMBPerHour: number;
}
/** One pass over the scenarios. */
export interface Measured {
  readonly startup?: { readonly readyMs: number };
  readonly rest?: Window;
  readonly firstWord?: { readonly inPlace: FirstWord; readonly worktree: FirstWord };
  readonly quiet?: Window;
  readonly scaling?: Scaling;
  readonly streaming?: Window;
  readonly soak?: Soak;
}
interface Hotspot {
  readonly frame: string;
  readonly value: number;
}
export interface ServerMetrics {
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
  readonly runs: ReadonlyArray<Measured>;
  /** Top CPU self time (ms) and allocated bytes (MB) by function, from the last run. */
  readonly profiles?: Readonly<Record<string, { cpuMs: Hotspot[]; allocatedMB: Hotspot[] }>>;
  readonly soakHeapGrowth?: ReadonlyArray<{ constructor: string; count: number; MB: number }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function spread(values: ReadonlyArray<number>): Spread {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { median: Math.round(at(0.5) ?? 0), p90: Math.round(at(0.9) ?? 0) };
}

/** Least-squares slope of y over x. */
export function slope(points: ReadonlyArray<readonly [number, number]>) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((sum, [x]) => sum + x, 0) / n;
  const my = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - mx) * (y - my);
    denominator += (x - mx) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

interface ApiRequest {
  readonly at: number;
  readonly stream: boolean;
  readonly agent: boolean;
  readonly marker: string | undefined;
}

/** Streams a canned reply to every Messages request; a prompt holding SLOW_MARKER streams slowly. */
function startFakeAnthropic() {
  const requests: ApiRequest[] = [];
  const server = NodeHttp.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk));
    request.on("end", async () => {
      const url = request.url ?? "";
      if (url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ input_tokens: 100 }));
      }
      if (!url.startsWith("/v1/messages")) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));
      }
      let body: { stream?: boolean; model?: string; tools?: unknown[] } = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const slow = raw.includes(SLOW_MARKER);
      requests.push({
        at: performance.now(),
        stream: body.stream === true,
        // Title and branch-name jobs carry only their structured-output tool; the agent carries many.
        agent: body.stream === true && (body.tools?.length ?? 0) > 1,
        marker: /bench-run-(\d+)/.exec(raw)?.[0],
      });
      const model = body.model ?? MODEL;
      const id = `msg_bench_${requests.length}`;
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: "Bench reply" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        );
      }
      const event = (name: string, data: object) =>
        response.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      event("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      const words = slow ? 2_000 : 40;
      for (let word = 0; word < words && !response.destroyed; word++) {
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: `${word ? " " : ""}word${word}` },
        });
        await sleep(slow ? 50 : 5);
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: words },
      });
      event("message_stop", {});
      response.end();
    });
  });
  return new Promise<{ port: number; requests: ApiRequest[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve({
        port: address.port,
        requests,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    }),
  );
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const commandOutput = (command: string, args: ReadonlyArray<string>, cwd = harnessRoot) => {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const powershell = (script: string) =>
  commandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** CPU seconds and RSS bytes of one process. */
function sample(pid: number): { cpuSeconds: number; rss: number } {
  if (platform === "linux") {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    const status = NodeFS.readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      cpuSeconds: (Number(stat[11]) + Number(stat[12])) / 100,
      rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
    };
  }
  if (platform === "win32") {
    const [cpu = "0", rss = "0"] = (
      powershell(
        `$p = Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`,
      ) ?? ""
    ).split(/\s+/);
    return { cpuSeconds: Number(cpu), rss: Number(rss) };
  }
  const [rss = "0", time = "0:0"] = (
    commandOutput("ps", ["-o", "rss=,time=", "-p", `${pid}`]) ?? ""
  )
    .split(/\s+/)
    .filter(Boolean);
  const cpuSeconds = time
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
  return { cpuSeconds, rss: Number(rss) * 1024 };
}

/** Context switches of one process since it started, or null when this platform cannot tell. */
function contextSwitches(pid: number): number | null {
  if (platform === "linux") {
    let switches = 0;
    for (const task of NodeFS.readdirSync(`/proc/${pid}/task`)) {
      try {
        const status = NodeFS.readFileSync(`/proc/${pid}/task/${task}/status`, "utf8");
        for (const match of status.matchAll(/ctxt_switches:\s+(\d+)/g))
          switches += Number(match[1]);
      } catch {}
    }
    return switches;
  }
  if (platform === "win32") {
    const total = powershell(
      `(Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Filter "IDProcess=${pid}" | Measure-Object ContextSwitchesPersec -Sum).Sum`,
    );
    return total === null || total === "" ? null : Number(total);
  }
  if (platform === "darwin") {
    const table = commandOutput("top", ["-l", "1", "-pid", `${pid}`, "-stats", "pid,csw"]);
    const row = table
      ?.split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([first]) => first === `${pid}`);
    const value = Number(row?.[1]?.replace(/\+$/, ""));
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Every process below `pid`, read once. */
function descendantsOf(pid: number): number[] {
  const children = new Map<number, number[]>();
  const add = (child: number, parent: number) =>
    children.set(parent, [...(children.get(parent) ?? []), child]);
  if (platform === "linux") {
    for (const entry of NodeFS.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = NodeFS.readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ");
        add(Number(entry), Number(stat[1]));
      } catch {}
    }
  } else if (platform === "darwin") {
    for (const line of (commandOutput("ps", ["-A", "-o", "pid=,ppid="]) ?? "").split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent) add(child, parent);
    }
  } else return [];
  const found: number[] = [];
  const pending = [pid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

/** One Chrome DevTools Protocol session on the server's inspector. */
async function inspect(webSocketUrl: string) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, (result: unknown) => void>();
  let chunks: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      method?: string;
      params?: { chunk?: string };
    };
    if (message.id !== undefined) pending.get(message.id)?.(message.result);
    else if (message.method === "HeapProfiler.addHeapSnapshotChunk")
      chunks.push(message.params?.chunk ?? "");
  });
  const send = (method: string, params: object = {}) =>
    new Promise<unknown>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    heapAfterGc: async () => {
      await send("HeapProfiler.collectGarbage");
      await send("HeapProfiler.collectGarbage");
      const { usedSize } = (await send("Runtime.getHeapUsage")) as { usedSize: number };
      return usedSize;
    },
    profile: async (seconds: number) => {
      await send("Profiler.enable");
      await send("Profiler.setSamplingInterval", { interval: 1_000 });
      await send("Profiler.start");
      await send("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await sleep(seconds * 1_000);
      const { profile: heap } = (await send("HeapProfiler.stopSampling")) as { profile: object };
      const { profile: cpu } = (await send("Profiler.stop")) as { profile: object };
      await send("Profiler.disable");
      return { cpu, heap };
    },
    snapshot: async () => {
      chunks = [];
      await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      const json = chunks.join("");
      chunks = [];
      return json;
    },
    close: () => socket.close(),
  };
}

const shortUrl = (url: string) =>
  url
    .replace(/^file:\/\//, "")
    .split(/[\\/]/)
    .slice(-3)
    .join("/");

interface CpuProfile {
  readonly nodes: ReadonlyArray<{
    id: number;
    hitCount?: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }>;
  readonly samples?: ReadonlyArray<number>;
  readonly startTime: number;
  readonly endTime: number;
}
interface HeapProfileNode {
  readonly callFrame: { functionName: string; url: string; lineNumber: number };
  readonly selfSize: number;
  readonly children: ReadonlyArray<HeapProfileNode>;
}

const frameName = (frame: { functionName: string; url: string; lineNumber: number }) =>
  `${frame.functionName || "(anonymous)"} ${frame.url ? `${shortUrl(frame.url)}:${frame.lineNumber + 1}` : ""}`.trim();

const top = (totals: Map<string, number>, digits: number): Hotspot[] =>
  [...totals]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([frame, value]) => ({ frame, value: round(value, digits) }));

/** Top CPU self time in ms and allocated MB, by function. */
export function summarizeProfiles(cpu: CpuProfile, heap: { head: HeapProfileNode }) {
  const perSampleMs = (cpu.endTime - cpu.startTime) / 1_000 / Math.max(1, cpu.samples?.length ?? 1);
  const cpuTotals = new Map<string, number>();
  for (const node of cpu.nodes) {
    if (!node.hitCount || node.callFrame.functionName === "(idle)") continue;
    const name = frameName(node.callFrame);
    cpuTotals.set(name, (cpuTotals.get(name) ?? 0) + node.hitCount * perSampleMs);
  }
  const allocations = new Map<string, number>();
  const visit = (node: HeapProfileNode) => {
    const name = frameName(node.callFrame);
    allocations.set(name, (allocations.get(name) ?? 0) + node.selfSize / 1e6);
    for (const child of node.children) visit(child);
  };
  visit(heap.head);
  return { cpuMs: top(cpuTotals, 0), allocatedMB: top(allocations, 1) };
}

/** Self size by constructor from a V8 heap snapshot. */
export function heapByConstructor(json: string) {
  const snapshot = JSON.parse(json) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const typeAt = fields.indexOf("type");
  const nameAt = fields.indexOf("name");
  const sizeAt = fields.indexOf("self_size");
  const totals = new Map<string, { count: number; bytes: number }>();
  for (let index = 0; index < snapshot.nodes.length; index += fields.length) {
    const type = types[snapshot.nodes[index + typeAt]!]!;
    const name =
      type === "object"
        ? snapshot.strings[snapshot.nodes[index + nameAt]!]!.slice(0, 80)
        : type === "closure"
          ? `(closure) ${snapshot.strings[snapshot.nodes[index + nameAt]!]!.slice(0, 60)}`
          : `(${type.replace(/^(concatenated|sliced) /, "")})`;
    const entry = totals.get(name) ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += snapshot.nodes[index + sizeAt]!;
    totals.set(name, entry);
  }
  return totals;
}

interface Environment {
  readonly home: string;
  readonly api: Awaited<ReturnType<typeof startFakeAnthropic>>;
  readonly noAgentScope: boolean;
  readonly serverDir: string;
}

async function startServer(environment: Environment, name: string) {
  const directory = NodeFS.mkdtempSync(NodePath.join(environment.home, `${name}-`));
  const project = NodePath.join(directory, "project");
  NodeFS.mkdirSync(project);
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# bench\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.email=bench@t3.codes", "-c", "user.name=bench", "commit", "-qm", "init"],
  ]) {
    NodeChildProcess.execFileSync("git", args, { cwd: project });
  }
  const baseDir = NodePath.join(directory, "base");
  // Branch names come from Claude too, so a worktree launch's naming call reaches the fake API.
  NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(baseDir, "userdata/settings.json"),
    JSON.stringify({ textGenerationModelSelection: { instanceId: "claudeAgent", model: MODEL } }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: environment.home,
    USERPROFILE: environment.home,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.api.port}`,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OTEL_SDK_DISABLED: "true",
    T3CODE_DEV_SEED: "0",
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.T3CODE_HOME;
  if (environment.noAgentScope) delete env.XDG_RUNTIME_DIR;
  const port = await freePort();
  const started = performance.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--inspect=127.0.0.1:0",
      "src/bin.ts",
      "serve",
      "--base-dir",
      baseDir,
      "--port",
      `${port}`,
      "--host",
      "127.0.0.1",
      project,
    ],
    { cwd: environment.serverDir, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const pid = child.pid!;
  let inspector = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
    inspector ||= /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)?.[0] ?? "";
  });
  let readyMs: number | undefined;
  for (let attempt = 0; attempt < 600 && readyMs === undefined; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${stderr}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      readyMs = Math.round(performance.now() - started);
    } catch {
      await sleep(100);
    }
  }
  if (readyMs === undefined || !inspector) throw new Error(`server never answered:\n${stderr}`);
  const devtools = await inspect(inspector);
  const cli = (args: ReadonlyArray<string>) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const command = NodeChildProcess.spawn(
        process.execPath,
        ["src/bin.ts", ...args, "--base-dir", baseDir],
        { cwd: environment.serverDir, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      command.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      command.on("exit", (code) => resolve({ code, stdout }));
    });
  const added = await cli(["project", "add", project]);
  if (added.code !== 0) throw new Error(`project add failed: ${added.stdout}`);

  // Spawning PowerShell for each sample costs a few hundred ms of the machine's CPU.
  const sampleEveryMs = platform === "win32" ? 5_000 : 1_000;
  const measure = async (seconds: number): Promise<Window> => {
    const firstSwitches = contextSwitches(pid);
    const first = sample(pid);
    let rssPeak = first.rss;
    const start = performance.now();
    while (performance.now() - start < seconds * 1_000) {
      await sleep(sampleEveryMs);
      rssPeak = Math.max(rssPeak, sample(pid).rss);
    }
    const last = sample(pid);
    const lastSwitches = contextSwitches(pid);
    const elapsed = (performance.now() - start) / 1_000;
    const heap = await devtools.heapAfterGc();
    return {
      cpuPct: round(((last.cpuSeconds - first.cpuSeconds) / elapsed) * 100),
      wakeupsPerSec:
        firstSwitches === null || lastSwitches === null
          ? null
          : round((lastSwitches - firstSwitches) / elapsed),
      rssPeakMB: Math.round(rssPeak / 1e6),
      rssMB: Math.round(sample(pid).rss / 1e6),
      heapAfterGcMB: round(heap / 1e6),
    };
  };

  const threadStart = (message: string, extra: ReadonlyArray<string> = []) =>
    cli([
      "thread",
      "start",
      "--provider",
      "claudeAgent",
      "--model",
      MODEL,
      ...extra,
      project,
      message,
    ]);
  const threadSend = (threadId: string, message: string) =>
    cli(["thread", "send", "--wait", threadId, message]);

  const stop = async () => {
    devtools.close();
    const spawned = descendantsOf(pid);
    if (platform === "win32") commandOutput("taskkill", ["/PID", `${pid}`, "/T", "/F"]);
    else child.kill("SIGTERM");
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await sleep(100);
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const leftover of spawned) {
      try {
        process.kill(leftover, "SIGKILL");
      } catch {}
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        NodeFS.rmSync(directory, { recursive: true, force: true });
        break;
      } catch {
        // Windows keeps a file locked for a moment after its process exits.
        await sleep(500);
      }
    }
  };

  return {
    readyMs,
    measure,
    threadStart,
    threadSend,
    profile: devtools.profile,
    snapshot: devtools.snapshot,
    stop,
  };
}

type Server = Awaited<ReturnType<typeof startServer>>;

async function firstWord(
  environment: Environment,
  server: Server,
  runs: number,
  worktree: boolean,
): Promise<FirstWord> {
  const toRequest: number[] = [];
  const toDone: number[] = [];
  for (let run = 0; run < runs; run++) {
    const marker = `bench-run-${worktree ? 1000 + run : run}`;
    const started = performance.now();
    const result = await server.threadStart(`Say hello. ${marker}`, [
      "--wait",
      ...(worktree ? ["--worktree", "main"] : []),
    ]);
    const done = performance.now() - started;
    if (result.code !== 0) throw new Error(`thread start failed: ${result.stdout}`);
    const request = environment.api.requests.find(
      (entry) => entry.agent && entry.marker === marker && entry.at >= started,
    );
    if (!request) throw new Error(`the agent request for ${marker} never reached the fake API`);
    toRequest.push(request.at - started);
    toDone.push(done);
  }
  return { toRequestMs: spread(toRequest), toDoneMs: spread(toDone) };
}

/** Starts threads that each answer once, and returns their ids. */
async function openThreads(server: Server, from: number, count: number) {
  const answers = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      server.threadStart(`Say hello ${from + index}.`, ["--wait"]),
    ),
  );
  const failed = answers.filter((answer) => answer.code !== 0).length;
  if (failed) throw new Error(`${failed} of ${count} threads failed`);
  return answers.map((answer) => /Thread (\S+)/.exec(answer.stdout)?.[1] ?? "");
}

const SCENARIOS = ["startup", "rest", "firstWord", "quiet", "streaming"] as const;

interface RunOptions {
  readonly checkout: string;
  readonly noAgentScope: boolean;
  readonly runs: number;
  readonly threads: ReadonlyArray<number>;
  readonly only: ReadonlyArray<string>;
  readonly soakMinutes: number;
  /** Where full CPU and allocation profiles go; none are written without it. */
  readonly profileDir: string | undefined;
}

export async function runOnce(options: RunOptions) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-metrics-"));
  const api = await startFakeAnthropic();
  const environment: Environment = {
    home,
    api,
    noAgentScope: options.noAgentScope,
    serverDir: NodePath.join(options.checkout, "apps/server"),
  };
  const wanted = (scenario: string) => options.only.length === 0 || options.only.includes(scenario);
  const measured: { -readonly [K in keyof Measured]: Measured[K] } = {};
  const profiles: Record<string, ReturnType<typeof summarizeProfiles>> = {};
  let soakHeapGrowth: ServerMetrics["soakHeapGrowth"];
  const profile = async (server: Server, name: string) => {
    const { cpu, heap } = await server.profile(20);
    profiles[name] = summarizeProfiles(cpu as CpuProfile, heap as { head: HeapProfileNode });
    if (options.profileDir) {
      NodeFS.mkdirSync(options.profileDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(options.profileDir, `${name}.cpuprofile`),
        JSON.stringify(cpu),
      );
      NodeFS.writeFileSync(
        NodePath.join(options.profileDir, `${name}.heapprofile`),
        JSON.stringify(heap),
      );
    }
  };
  const withServer = async (name: string, body: (server: Server) => Promise<void>) => {
    const server = await startServer(environment, name);
    try {
      await body(server);
    } finally {
      await server.stop();
    }
  };
  try {
    if (wanted("startup") || wanted("rest") || wanted("firstWord")) {
      await withServer("rest", async (server) => {
        measured.startup = { readyMs: server.readyMs };
        if (wanted("rest")) {
          await sleep(15_000);
          measured.rest = await server.measure(30);
        }
        if (wanted("firstWord")) {
          measured.firstWord = {
            inPlace: await firstWord(environment, server, options.runs, false),
            worktree: await firstWord(environment, server, options.runs, true),
          };
        }
      });
    }
    if (wanted("quiet")) {
      await withServer("quiet", async (server) => {
        const points: Array<{ threads: number; window: Window }> = [];
        let open = 0;
        for (const threads of options.threads) {
          if (threads > open) await openThreads(server, open, threads - open);
          open = Math.max(open, threads);
          await sleep(15_000);
          points.push({ threads, window: await server.measure(30) });
        }
        measured.quiet = points.at(-1)!.window;
        // The first thread also loads the provider's modules once, so the fit leaves out 0 threads.
        const withThreads = points.filter(({ threads }) => threads > 0);
        const fitted = withThreads.length >= 2 ? withThreads : points;
        const fit = (pick: (window: Window) => number) =>
          round(slope(fitted.map(({ threads, window }) => [threads, pick(window)])), 3);
        measured.scaling = {
          heapMBPerThread: fit((window) => window.heapAfterGcMB),
          rssMBPerThread: fit((window) => window.rssMB),
          cpuPctPerThread: fit((window) => window.cpuPct),
          wakeupsPerThread: points.every(({ window }) => window.wakeupsPerSec !== null)
            ? fit((window) => window.wakeupsPerSec!)
            : null,
          points: points.map(({ threads, window }) => [
            threads,
            window.cpuPct,
            window.wakeupsPerSec,
            window.rssMB,
            window.heapAfterGcMB,
          ]),
        };
        await profile(server, "quiet");
      });
    }
    if (wanted("streaming")) {
      await withServer("streaming", async (server) => {
        const started = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            server.threadStart(`Write a long answer ${index}. ${SLOW_MARKER}`),
          ),
        );
        if (started.some((answer) => answer.code !== 0)) throw new Error("streaming start failed");
        for (let attempt = 0; attempt < 300; attempt++) {
          if (api.requests.filter((request) => request.agent && request.stream).length >= 5) break;
          await sleep(100);
        }
        await sleep(5_000);
        measured.streaming = await server.measure(60);
        await profile(server, "streaming");
      });
    }
    if (options.soakMinutes > 0) {
      await withServer("soak", async (server) => {
        const threads = await openThreads(server, 0, 10);
        await sleep(60_000);
        // The snapshot inflates RSS once, so the slopes start after it.
        const before = heapByConstructor(await server.snapshot());
        const samples: Array<{ hours: number; window: Window }> = [];
        const start = performance.now();
        let nextSample = 0;
        for (let turn = 0; performance.now() - start < options.soakMinutes * 60_000; turn++) {
          const elapsed = performance.now() - start;
          if (elapsed >= nextSample) {
            samples.push({ hours: elapsed / 3_600_000, window: await server.measure(5) });
            nextSample += 120_000;
          }
          const threadId = threads[Math.floor(Math.random() * threads.length)]!;
          await server.threadSend(threadId, `Short reply ${turn}.`);
          await sleep(Math.max(0, start + (turn + 1) * 30_000 - performance.now()));
        }
        samples.push({
          hours: (performance.now() - start) / 3_600_000,
          window: await server.measure(5),
        });
        measured.soak = {
          minutes: options.soakMinutes,
          heapMBPerHour: round(
            slope(samples.map(({ hours, window }) => [hours, window.heapAfterGcMB])),
          ),
          rssMBPerHour: round(slope(samples.map(({ hours, window }) => [hours, window.rssMB]))),
        };
        const after = heapByConstructor(await server.snapshot());
        soakHeapGrowth = [...after]
          .map(([name, { count, bytes }]) => ({
            constructor: name,
            count: count - (before.get(name)?.count ?? 0),
            MB: round((bytes - (before.get(name)?.bytes ?? 0)) / 1e6, 2),
          }))
          .toSorted((a, b) => b.MB - a.MB)
          .slice(0, 25);
      });
    }
  } finally {
    api.close();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
  return { measured: measured as Measured, profiles, soakHeapGrowth };
}

function machineLoad() {
  if (platform === "win32")
    return powershell(
      "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
    );
  return NodeOS.loadavg()
    .map((value) => value.toFixed(2))
    .join(" ");
}

function metaFor(options: RunOptions) {
  const claude = commandOutput("claude", ["--version"]);
  if (claude === null) throw new Error("The real `claude` CLI must be on PATH.");
  if (options.noAgentScope && platform !== "linux")
    throw new Error("--no-agent-scope is Linux only; other platforms never have an agent scope.");
  return {
    platform: `${platform}-${architecture}`,
    cpus: NodeOS.cpus().length,
    node: process.version,
    claude,
    commit: commandOutput("git", ["rev-parse", "--short=12", "HEAD"], options.checkout),
    noAgentScope: options.noAgentScope,
    agentScope:
      platform === "linux" &&
      !options.noAgentScope &&
      !!process.env.XDG_RUNTIME_DIR &&
      commandOutput("sh", ["-c", "command -v systemd-run"]) !== null,
    loadBefore: machineLoad(),
    measuredAt: new Date().toISOString(),
  };
}

async function runMany(options: RunOptions, repeat: number): Promise<ServerMetrics> {
  const meta = metaFor(options);
  const runs: Measured[] = [];
  let last: Awaited<ReturnType<typeof runOnce>> | undefined;
  for (let index = 0; index < repeat; index++) {
    last = await runOnce(options);
    runs.push(last.measured);
  }
  return {
    meta: { ...meta, loadAfter: machineLoad() },
    runs,
    ...(last ? { profiles: last.profiles } : {}),
    ...(last?.soakHeapGrowth ? { soakHeapGrowth: last.soakHeapGrowth } : {}),
  };
}

/** Numeric leaves by dotted path, such as `quiet.cpuPct` or `firstWord.worktree.toRequestMs.p90`. */
export function flatten(measured: Measured): Map<string, number> {
  const values = new Map<string, number>();
  const visit = (value: unknown, path: string) => {
    if (typeof value === "number") values.set(path, value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(measured, "");
  return values;
}

function noiseFloor(metric: string) {
  if (metric.startsWith("scaling.")) return metric.endsWith("cpuPctPerThread") ? 0.2 : 2;
  if (metric.startsWith("soak.")) return 20;
  if (metric.endsWith("cpuPct")) return 1;
  if (metric.endsWith("wakeupsPerSec")) return 20;
  if (metric.endsWith("MB")) return 15;
  return 300;
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** 95% bootstrap interval of median(b) - median(a), with a fixed seed so reruns agree. */
export function bootstrapMedianDifference(a: ReadonlyArray<number>, b: ReadonlyArray<number>) {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const resample = (values: ReadonlyArray<number>) =>
    median(Array.from(values, () => values[Math.floor(random() * values.length)]!));
  const differences = Array.from({ length: 2_000 }, () => resample(b) - resample(a)).toSorted(
    (x, y) => x - y,
  );
  return [differences[49]!, differences[1_949]!] as const;
}

/** Old single-run files hold the scenarios at the top level. */
const runsOf = (metrics: ServerMetrics | (Measured & { meta: ServerMetrics["meta"] })) =>
  "runs" in metrics && Array.isArray(metrics.runs)
    ? metrics.runs
    : [Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== "meta")) as Measured];

export function compareMetrics(before: ServerMetrics, after: ServerMetrics, threshold = 10) {
  const collect = (metrics: ServerMetrics) => {
    const values = new Map<string, number[]>();
    for (const run of runsOf(metrics)) {
      for (const [metric, value] of flatten(run))
        values.set(metric, [...(values.get(metric) ?? []), value]);
    }
    return values;
  };
  const a = collect(before);
  const b = collect(after);
  const lines = [
    "### Server metrics (lower is better)",
    "",
    `before \`${before.meta.commit}\` (${runsOf(before).length} runs), after \`${after.meta.commit}\` (${runsOf(after).length} runs), ${after.meta.platform}${after.meta.noAgentScope || after.meta.macPath ? ", no agent scope" : ""}`,
    "",
    "| metric | before | after | change | 95% interval | |",
    "| :-- | --: | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  const improved: string[] = [];
  for (const metric of new Set([...a.keys(), ...b.keys()])) {
    if (metric === "soak.minutes" || metric.startsWith("scaling.points")) continue;
    const x = a.get(metric);
    const y = b.get(metric);
    if (!x || !y) {
      lines.push(`| ${metric} | ${x ? median(x) : "–"} | ${y ? median(y) : "–"} | n/a | | |`);
      continue;
    }
    const mx = median(x);
    const my = median(y);
    // A change counts only past both the relative threshold and the absolute noise floor.
    const limit = Math.max(noiseFloor(metric), (Math.abs(mx) * threshold) / 100);
    const [low, high] =
      x.length > 1 && y.length > 1 ? bootstrapMedianDifference(x, y) : [my - mx, my - mx];
    const verdict = low > limit ? "worse" : high < -limit ? "better" : "";
    if (verdict === "worse") regressed.push(metric);
    if (verdict === "better") improved.push(metric);
    const percent = mx === 0 ? (my === 0 ? 0 : Infinity) : ((my - mx) / Math.abs(mx)) * 100;
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    const interval = x.length > 1 && y.length > 1 ? `${round(low, 2)} to ${round(high, 2)}` : "";
    lines.push(
      `| ${metric} | ${round(mx, 2)} | ${round(my, 2)} | ${shown} | ${interval} | ${verdict} |`,
    );
  }
  return { table: lines.join("\n"), regressed, improved };
}

function option(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runOptions(args: ReadonlyArray<string>, checkout: string): RunOptions {
  const only = (option(args, "--only") ?? "").split(",").filter(Boolean);
  const unknown = only.filter((name) => !(SCENARIOS as ReadonlyArray<string>).includes(name));
  if (unknown.length) throw new Error(`unknown scenario: ${unknown.join(", ")}`);
  const threads = (option(args, "--threads") ?? "0,5,10,20").split(",").map(Number);
  if (threads.some((count) => !Number.isInteger(count) || count < 0))
    throw new Error("--threads takes counts such as 0,5,10,20");
  return {
    checkout: NodePath.resolve(checkout),
    noAgentScope: args.includes("--no-agent-scope") || args.includes("--mac-path"),
    runs: Number(option(args, "--runs") ?? 5),
    threads,
    only: option(args, "--soak") && !option(args, "--only") ? ["none"] : only,
    soakMinutes: Number(option(args, "--soak") ?? 0),
    profileDir: undefined,
  };
}

const write = (path: string | undefined, metrics: ServerMetrics) => {
  const json = JSON.stringify(metrics, null, 2);
  if (path) NodeFS.writeFileSync(path, json + "\n");
  else console.log(json);
};

const printComparison = (before: ServerMetrics, after: ServerMetrics, threshold: number) => {
  const { table, regressed, improved } = compareMetrics(before, after, threshold);
  console.log(table);
  if (improved.length) console.error(`Better: ${improved.join(", ")}`);
  if (regressed.length) {
    console.error(`Worse: ${regressed.join(", ")}`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const threshold = Number(option(args, "--threshold") ?? 10);
  if (command === "run") {
    const out = option(args, "--out");
    const options = {
      ...runOptions(args, option(args, "--checkout") ?? harnessRoot),
      profileDir: out ? out.replace(/\.json$/, "") + "-profiles" : undefined,
    };
    write(out, await runMany(options, Number(option(args, "--repeat") ?? 1)));
  } else if (command === "ab" && args[0] && args[1] && !args[0].startsWith("--")) {
    const outDir = NodePath.resolve(option(args, "--out-dir") ?? "server-metrics-ab");
    NodeFS.mkdirSync(outDir, { recursive: true });
    const sides = [args[0], args[1]].map((checkout) => runOptions(args, checkout));
    const metas = sides.map((side) => metaFor(side));
    const runs: [Measured[], Measured[]] = [[], []];
    const rounds = Number(option(args, "--rounds") ?? 3);
    for (let round = 0; round < rounds; round++) {
      // A B, then B A, so a drift in machine load lands on both sides.
      for (const side of round % 2 === 0 ? [0, 1] : [1, 0]) {
        console.error(`round ${round + 1}/${rounds}: ${side === 0 ? "A" : "B"}`);
        runs[side]!.push((await runOnce(sides[side]!)).measured);
      }
    }
    const [before, after] = [0, 1].map((side) => ({
      meta: { ...metas[side]!, loadAfter: machineLoad() },
      runs: runs[side]!,
    }));
    write(NodePath.join(outDir, "a.json"), before!);
    write(NodePath.join(outDir, "b.json"), after!);
    printComparison(before!, after!, threshold);
  } else if (command === "compare" && args[0] && args[1]) {
    const read = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as ServerMetrics;
    printComparison(read(args[0]), read(args[1]), threshold);
  } else {
    console.log(HELP);
    if (command !== "--help" && command !== "-h" && command !== undefined) process.exitCode = 1;
  }
}
