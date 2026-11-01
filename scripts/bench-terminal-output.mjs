// Run with Node >= 26: node --expose-gc scripts/bench-terminal-output.mjs [baseline-ref] [artifact-dir] [captured-pipe-chunks.json] [--verify-only]
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeInspectorPromises from "node:inspector/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const source = "packages/shared/src/terminalOutput.ts";
const baselineRef = process.argv[2] ?? "HEAD";
const baselineSha = NodeChildProcess.execFileSync(
  "git",
  ["rev-parse", "--verify", `${baselineRef}^{commit}`],
  {
    cwd: root,
    encoding: "utf8",
  },
).trim();
NodeAssert.equal(typeof globalThis.gc, "function", "Run node with --expose-gc");
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-terminal-bench-"));
const artifacts =
  process.argv[3] ??
  (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-terminal-results-")));
await NodeFSP.mkdir(artifacts, { recursive: true });
const session = new NodeInspectorPromises.Session();
session.connect();
try {
  const baselinePath = NodePath.join(temporary, "terminalOutput.ts");
  await NodeFSP.writeFile(
    baselinePath,
    NodeChildProcess.execFileSync("git", ["show", `${baselineSha}:${source}`], { cwd: root }),
  );
  const baseline = await import(NodeURL.pathToFileURL(baselinePath).href);
  const current = await import(NodeURL.pathToFileURL(NodePath.join(root, source)).href);
  const modules = { baseline, current };
  const fixtures = {
    "plain-4k": Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(4096)}\n`),
    "plain-64k": Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(65536)}\n`),
    "ansi-4k": Array.from(
      { length: 500 },
      (_, i) => `\x1b[31mline ${i} ${"x".repeat(4096)}\x1b[0m\n`,
    ),
    "logs-120": Array.from(
      { length: 3000 },
      (_, i) => `[2026-11-01] INFO item=${i} ${"x".repeat(90)}\n`,
    ),
    progress: Array.from({ length: 3000 }, (_, i) => `\r\x1b[2K${i}% ${"x".repeat(80)}`),
  };
  let pipeChunks;
  const capturePath = process.argv[4] === "--verify-only" ? undefined : process.argv[4];
  if (capturePath) {
    pipeChunks = JSON.parse(await NodeFSP.readFile(capturePath, "utf8"));
    NodeAssert.ok(
      Array.isArray(pipeChunks) &&
        pipeChunks.length > 0 &&
        pipeChunks.every((chunk) => typeof chunk === "string"),
    );
  } else {
    pipeChunks = [];
    const producer = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `for (let i = 0; i < 500; i++) process.stdout.write(JSON.stringify({time:'2026-11-01T10:00:00.000Z',level:'INFO',message:'processed '+i,payload:'x'.repeat(4096)})+'\\n');`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    producer.stdout.setEncoding("utf8").on("data", (chunk) => pipeChunks.push(chunk));
    await new Promise((resolve, reject) => {
      producer.once("error", reject);
      producer.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Producer exited ${code}`)),
      );
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(artifacts, "captured-pipe-chunks.json"),
    JSON.stringify(pipeChunks),
  );
  const scenarios = Object.fromEntries(
    Object.entries(fixtures).map(([name, chunks]) => [name, { chunks, consumeEveryAppend: true }]),
  );
  scenarios["os-pipe-server-final"] = { chunks: pipeChunks, consumeEveryAppend: false };
  scenarios["os-pipe-every-tail"] = { chunks: pipeChunks, consumeEveryAppend: true };
  let consumed = 0;
  function run(module, { chunks, consumeEveryAppend }) {
    let state = module.EMPTY_TERMINAL_OUTPUT;
    let checksum = 0;
    for (const chunk of chunks) {
      state = module.appendTerminalOutput(state, chunk);
      // Consume every returned UTF-8 byte, including intermediate output, inside the timed region.
      if (consumeEveryAppend) checksum = NodeZlib.crc32(state.text, checksum);
    }
    const digest = NodeCrypto.createHash("sha256").update(state.text).digest("hex");
    consumed = (consumed + checksum + Number.parseInt(digest.slice(0, 8), 16)) >>> 0;
    return `${checksum}:${digest}`;
  }
  function equivalent(chunks, maxChars) {
    let left = baseline.EMPTY_TERMINAL_OUTPUT;
    let right = current.EMPTY_TERMINAL_OUTPUT;
    for (const chunk of chunks) {
      left = baseline.appendTerminalOutput(left, chunk, maxChars);
      right = current.appendTerminalOutput(right, chunk, maxChars);
      NodeAssert.deepEqual(right, left);
      NodeAssert.equal(
        current.terminalOutputResumeText(right),
        baseline.terminalOutputResumeText(left),
      );
    }
  }
  for (let code = 0; code < 256; code += 1) {
    const input = `a\t界😀${String.fromCharCode(code)}z`;
    for (let cut = 0; cut <= input.length; cut += 1)
      equivalent([input.slice(0, cut), input.slice(cut)]);
  }
  let seed = 328923;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const atoms = [
    "abc",
    "\t",
    "\n",
    "\r",
    "\b",
    "\x1b[31m",
    "\x1b[0m",
    "\x1b[2K",
    "\x1b[1A",
    "\x1b7",
    "\x1b8",
    "\x1b]0;title\x07",
    "😀",
    "\u009f",
    "\x1b[999999999C",
    "\x1b[3J",
  ];
  for (let trial = 0; trial < 300; trial += 1) {
    const input = Array.from({ length: 30 }, () => atoms[random() % atoms.length]).join("");
    const chunks = [];
    for (let offset = 0; offset < input.length;) {
      const end = offset + 1 + (random() % 24);
      chunks.push(input.slice(offset, end));
      offset = end;
    }
    equivalent(chunks, trial % 2 === 0 ? 64 : 65536);
  }
  for (const { chunks } of Object.values(scenarios)) equivalent(chunks);
  const summary = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1) };
  };
  const sampling = {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
  const report = {
    verificationOnly: process.argv.includes("--verify-only"),
    node: process.version,
    baselineSha,
    source,
    batches: 11,
    runsPerBatch: 5,
    allocationRuns: 10,
    sampling,
    pipeCapture: {
      source: capturePath ?? "fresh Node subprocess OS stdout pipe capture",
      chunks: pipeChunks.length,
      minChars: Math.min(...pipeChunks.map((chunk) => chunk.length)),
      maxChars: Math.max(...pipeChunks.map((chunk) => chunk.length)),
      inputSha256: NodeCrypto.createHash("sha256").update(pipeChunks.join("")).digest("hex"),
      description:
        "Generated 500 JSON log records with 4KiB payloads; real OS chunk boundaries, not recorded user traffic",
    },
    scenarios: [],
  };
  console.log(
    JSON.stringify({
      ...report,
      artifacts,
      equivalence: "all intermediate states and resume text match",
    }),
  );
  for (const [name, scenario] of Object.entries(scenarios)) {
    const { chunks, consumeEveryAppend } = scenario;
    for (let i = 0; i < 5; i += 1) {
      NodeAssert.equal(run(baseline, scenario), run(current, scenario));
    }
    if (report.verificationOnly) continue;
    const times = { baseline: [], current: [] };
    for (let batch = 0; batch < report.batches; batch += 1) {
      for (const side of batch % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"]) {
        globalThis.gc();
        const start = NodePerfHooks.performance.now();
        for (let i = 0; i < report.runsPerBatch; i += 1) run(modules[side], scenario);
        times[side].push((NodePerfHooks.performance.now() - start) / report.runsPerBatch);
      }
    }
    const allocated = { baseline: [], current: [] };
    for (let batch = 0; batch < 3; batch += 1) {
      for (const side of batch % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"]) {
        globalThis.gc();
        await session.post("HeapProfiler.startSampling", sampling);
        for (let i = 0; i < report.allocationRuns; i += 1) run(modules[side], scenario);
        const { profile } = await session.post("HeapProfiler.stopSampling");
        await NodeFSP.writeFile(
          NodePath.join(artifacts, `${name}-${side}-${batch}.heapprofile`),
          JSON.stringify(profile),
        );
        allocated[side].push(
          profile.samples.reduce((sum, sample) => sum + sample.size, 0) / report.allocationRuns,
        );
      }
    }
    const cpu = {};
    await session.post("Profiler.enable");
    for (const side of ["baseline", "current"]) {
      await session.post("Profiler.start");
      for (let i = 0; i < 30; i += 1) run(modules[side], scenario);
      const { profile } = await session.post("Profiler.stop");
      await NodeFSP.writeFile(
        NodePath.join(artifacts, `${name}-${side}.cpuprofile`),
        JSON.stringify(profile),
      );
      const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
      const counts = new Map();
      for (const id of profile.samples ?? []) {
        const frame = frames.get(id);
        const key = `${frame.functionName} ${frame.url}:${frame.lineNumber + 1}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      cpu[side] = {
        samples: profile.samples?.length ?? 0,
        top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8),
      };
    }
    const milliseconds = { baseline: summary(times.baseline), current: summary(times.current) };
    const row = {
      name,
      consumption: consumeEveryAppend
        ? "CRC32 of every returned tail plus final SHA256"
        : "server-shaped fold with final full SHA256 only",
      checksum: run(current, scenario),
      chunks: chunks.length,
      inputBytes: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0),
      milliseconds,
      speedup: milliseconds.baseline.median / milliseconds.current.median,
      sampledAllocatedBytesPerRun: {
        baseline: summary(allocated.baseline),
        current: summary(allocated.current),
      },
      times,
      allocated,
      cpu,
    };
    report.scenarios.push(row);
    console.log(JSON.stringify(row));
  }
  await NodeFSP.writeFile(
    NodePath.join(artifacts, "results.json"),
    JSON.stringify({ ...report, consumed }, null, 2),
  );
  console.log(JSON.stringify({ consumed, artifacts }));
} finally {
  session.disconnect();
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
