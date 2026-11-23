// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off globalDate:off - a standalone benchmark driver around one server process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const HELP = `Usage:
  node scripts/server-metrics.ts run [--out <file>] [--mac-path] [--runs <n>] [--only <scenario,...>]
  node scripts/server-metrics.ts compare <before.json> <after.json> [--threshold <percent>]

run      Starts this checkout's server (apps/server/src/bin.ts) against a temp base dir, a temp
         HOME, a temp git project and a fake Anthropic Messages API, drives the real \`claude\`
         CLI through it, and writes one JSON object of measurements. Each scenario gets a fresh
         server. Takes about 6 minutes.

  startup    spawn to the first HTTP answer, in ms.
  rest       30 s idle: server CPU %, wakeups/s, RSS peak, heap after a forced GC.
  firstWord  --runs (default 5) sequential \`thread start\` runs in the project folder and in a
             new worktree: ms until the fake API receives the agent's request, and until the
             reply finished. Median and p90.
  quiet      20 Claude threads that answered and stay open, idle 20 s, then a 60 s window.
  streaming  5 threads streaming a 2,000-word reply at 50 ms a word, 60 s window.

--mac-path  Linux only: starts the server without XDG_RUNTIME_DIR, so it has no agent scope and
            takes the per-process path macOS always takes (apps/server/src/process/agentScope.ts).
Wakeups are voluntary plus involuntary context switches of the server's threads (Linux /proc);
they are null on macOS. Only the server process is measured, not the agent CLIs.

compare  Prints a markdown table of every metric (lower is better) and exits 1 when one got
         worse by more than --threshold percent (default 10) and by more than its noise floor:
         1 point of CPU, 20 wakeups/s, 15 MB, 300 ms. With 5 runs a p90 is the
         slowest run, so read a lone p90 change as noise unless the median moved too.

Comparing two refs needs both checkouts, since the server runs each tree's code:
  node scripts/server-metrics.ts run --out ../main-server.json        # on main
  node scripts/server-metrics.ts run --out ../branch-server.json      # on the branch
  node scripts/server-metrics.ts compare ../main-server.json ../branch-server.json`;

const root = NodePath.resolve(import.meta.dirname, "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const platform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
const architecture = NodeOS.arch();
const serverDir = NodePath.join(root, "apps/server");
const MODEL = "claude-haiku-4-5";
const SLOW_MARKER = "[[stream-slowly]]";

interface Window {
  readonly cpuPct: number;
  readonly wakeupsPerSec: number | null;
  readonly rssPeakMB: number;
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
export interface ServerMetrics {
  readonly meta: Readonly<Record<string, string | boolean | null>>;
  readonly startup?: { readonly readyMs: number };
  readonly rest?: Window;
  readonly firstWord?: { readonly inPlace: FirstWord; readonly worktree: FirstWord };
  readonly quiet?: Window;
  readonly streaming?: Window;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number) => Math.round(value * 10) / 10;

function spread(values: ReadonlyArray<number>): Spread {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { median: Math.round(at(0.5) ?? 0), p90: Math.round(at(0.9) ?? 0) };
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

const commandOutput = (command: string, args: ReadonlyArray<string>, cwd = root) => {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** CPU seconds, context switches and RSS bytes of one process. */
function sample(pid: number): { cpuSeconds: number; switches: number | null; rss: number } {
  if (platform === "linux") {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
    const ticks = Number(stat[11]) + Number(stat[12]);
    let switches = 0;
    for (const task of NodeFS.readdirSync(`/proc/${pid}/task`)) {
      try {
        const status = NodeFS.readFileSync(`/proc/${pid}/task/${task}/status`, "utf8");
        for (const match of status.matchAll(/ctxt_switches:\s+(\d+)/g))
          switches += Number(match[1]);
      } catch {}
    }
    const status = NodeFS.readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      cpuSeconds: ticks / 100,
      switches,
      rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
    };
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
  return { cpuSeconds, switches: null, rss: Number(rss) * 1024 };
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
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
    if (message.id !== undefined) pending.get(message.id)?.(message.result);
  });
  const send = (method: string) =>
    new Promise<unknown>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method }));
    });
  return {
    heapAfterGc: async () => {
      await send("HeapProfiler.collectGarbage");
      await send("HeapProfiler.collectGarbage");
      const { usedSize } = (await send("Runtime.getHeapUsage")) as { usedSize: number };
      return usedSize;
    },
    close: () => socket.close(),
  };
}

interface Environment {
  readonly home: string;
  readonly api: Awaited<ReturnType<typeof startFakeAnthropic>>;
  readonly macPath: boolean;
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
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.api.port}`,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OTEL_SDK_DISABLED: "true",
    T3CODE_DEV_SEED: "0",
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.T3CODE_HOME;
  if (environment.macPath) delete env.XDG_RUNTIME_DIR;
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
    { cwd: serverDir, env, stdio: ["ignore", "ignore", "pipe"] },
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
        { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      command.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      command.on("exit", (code) => resolve({ code, stdout }));
    });
  const added = await cli(["project", "add", project]);
  if (added.code !== 0) throw new Error(`project add failed: ${added.stdout}`);

  const measure = async (seconds: number): Promise<Window> => {
    const first = sample(pid);
    let rssPeak = first.rss;
    const start = performance.now();
    while (performance.now() - start < seconds * 1_000) {
      await sleep(1_000);
      rssPeak = Math.max(rssPeak, sample(pid).rss);
    }
    const last = sample(pid);
    const elapsed = (performance.now() - start) / 1_000;
    return {
      cpuPct: round(((last.cpuSeconds - first.cpuSeconds) / elapsed) * 100),
      wakeupsPerSec:
        first.switches === null || last.switches === null
          ? null
          : round((last.switches - first.switches) / elapsed),
      rssPeakMB: Math.round(rssPeak / 1e6),
      heapAfterGcMB: round((await devtools.heapAfterGc()) / 1e6),
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

  const descendants = () => {
    if (platform !== "linux") return [];
    const children = new Map<number, number[]>();
    for (const entry of NodeFS.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const ppid = Number(
          NodeFS.readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ")[1],
        );
        children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
      } catch {}
    }
    const found: number[] = [];
    const pending = [pid];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      for (const child of children.get(next) ?? []) {
        found.push(child);
        pending.push(child);
      }
    }
    return found;
  };

  const stop = async () => {
    devtools.close();
    const spawned = descendants();
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await sleep(100);
    if (child.exitCode === null) child.kill("SIGKILL");
    for (const leftover of spawned) {
      try {
        process.kill(leftover, "SIGKILL");
      } catch {}
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  };

  return { readyMs, measure, threadStart, stop };
}

async function firstWord(
  environment: Environment,
  server: Awaited<ReturnType<typeof startServer>>,
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

const SCENARIOS = ["startup", "rest", "firstWord", "quiet", "streaming"] as const;

export async function runOnce(options: {
  macPath: boolean;
  runs: number;
  only: ReadonlyArray<string>;
}): Promise<ServerMetrics> {
  const claude = commandOutput("claude", ["--version"]);
  if (claude === null) throw new Error("The real `claude` CLI must be on PATH.");
  if (options.macPath && platform !== "linux") throw new Error("--mac-path is Linux only.");
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-metrics-"));
  const api = await startFakeAnthropic();
  const environment: Environment = { home, api, macPath: options.macPath };
  const wanted = (scenario: string) => options.only.length === 0 || options.only.includes(scenario);
  const agentScope =
    platform === "linux" &&
    !options.macPath &&
    !!process.env.XDG_RUNTIME_DIR &&
    commandOutput("sh", ["-c", "command -v systemd-run"]) !== null;
  const result: {
    -readonly [K in keyof ServerMetrics]: ServerMetrics[K];
  } = {
    meta: {
      platform: `${platform}-${architecture}`,
      node: process.version,
      claude,
      commit: commandOutput("git", ["rev-parse", "--short=12", "HEAD"]),
      macPath: options.macPath,
      agentScope,
      measuredAt: new Date().toISOString(),
    },
  };
  try {
    if (wanted("startup") || wanted("rest") || wanted("firstWord")) {
      const server = await startServer(environment, "rest");
      try {
        result.startup = { readyMs: server.readyMs };
        if (wanted("rest")) {
          await sleep(15_000);
          result.rest = await server.measure(30);
        }
        if (wanted("firstWord")) {
          result.firstWord = {
            inPlace: await firstWord(environment, server, options.runs, false),
            worktree: await firstWord(environment, server, options.runs, true),
          };
        }
      } finally {
        await server.stop();
      }
    }
    if (wanted("quiet")) {
      const server = await startServer(environment, "quiet");
      try {
        const answers = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            server.threadStart(`Say hello ${index}.`, ["--wait"]),
          ),
        );
        const failed = answers.filter((answer) => answer.code !== 0).length;
        if (failed) throw new Error(`${failed} of 20 quiet threads failed`);
        await sleep(20_000);
        result.quiet = await server.measure(60);
      } finally {
        await server.stop();
      }
    }
    if (wanted("streaming")) {
      const server = await startServer(environment, "streaming");
      try {
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
        result.streaming = await server.measure(60);
      } finally {
        await server.stop();
      }
    }
  } finally {
    api.close();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
  return result;
}

/** Numeric leaves by dotted path, such as `quiet.cpuPct` or `firstWord.worktree.toRequestMs.p90`. */
export function flatten(metrics: ServerMetrics): Map<string, number> {
  const values = new Map<string, number>();
  const visit = (value: unknown, path: string) => {
    if (typeof value === "number") values.set(path, value);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    }
  };
  const { meta: _meta, ...measured } = metrics;
  visit(measured, "");
  return values;
}

function noiseFloor(metric: string) {
  if (metric.endsWith("cpuPct")) return 1;
  if (metric.endsWith("wakeupsPerSec")) return 20;
  if (metric.endsWith("MB")) return 15;
  return 300;
}

export function compareMetrics(before: ServerMetrics, after: ServerMetrics, threshold = 10) {
  const a = flatten(before);
  const b = flatten(after);
  const lines = [
    "### Server metrics (lower is better)",
    "",
    `before \`${before.meta.commit}\`, after \`${after.meta.commit}\`, ${after.meta.platform}${after.meta.macPath ? ", mac path" : ""}`,
    "",
    "| metric | before | after | change | |",
    "| :-- | --: | --: | --: | :-- |",
  ];
  const regressed: string[] = [];
  for (const metric of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(metric);
    const y = b.get(metric);
    if (x === undefined || y === undefined) {
      lines.push(`| ${metric} | ${x ?? "–"} | ${y ?? "–"} | n/a | |`);
      continue;
    }
    const delta = y - x;
    const percent = x === 0 ? (y === 0 ? 0 : Infinity) : (delta / x) * 100;
    const beyondFloor = Math.abs(delta) > noiseFloor(metric);
    const verdict =
      beyondFloor && percent > threshold
        ? "worse"
        : beyondFloor && percent < -threshold
          ? "better"
          : "";
    if (verdict === "worse") regressed.push(metric);
    const shown = Number.isFinite(percent)
      ? `${percent > 0 ? "+" : ""}${Math.round(percent)}%`
      : "new";
    lines.push(`| ${metric} | ${x} | ${y} | ${shown} | ${verdict} |`);
  }
  return { table: lines.join("\n"), regressed };
}

function option(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") {
    const only = (option(args, "--only") ?? "").split(",").filter(Boolean);
    const unknown = only.filter((name) => !(SCENARIOS as ReadonlyArray<string>).includes(name));
    if (unknown.length) throw new Error(`unknown scenario: ${unknown.join(", ")}`);
    const metrics = await runOnce({
      macPath: args.includes("--mac-path"),
      runs: Number(option(args, "--runs") ?? 5),
      only,
    });
    const json = JSON.stringify(metrics, null, 2);
    const out = option(args, "--out");
    if (out) NodeFS.writeFileSync(out, json + "\n");
    else console.log(json);
  } else if (command === "compare" && args[0] && args[1]) {
    const read = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as ServerMetrics;
    const { table, regressed } = compareMetrics(
      read(args[0]),
      read(args[1]),
      Number(option(args, "--threshold") ?? 10),
    );
    console.log(table);
    if (regressed.length) {
      console.error(`Worse: ${regressed.join(", ")}`);
      process.exitCode = 1;
    }
  } else {
    console.log(HELP);
    if (command !== "--help" && command !== "-h" && command !== undefined) process.exitCode = 1;
  }
}
