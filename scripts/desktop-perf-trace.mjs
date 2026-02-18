import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const marker = "<!-- desktop-perf-trace-summary -->";
const defaultSeedRelativePath = "apps/desktop/scripts/perf-seed.json";
const defaultPerfProjects = [
  {
    id: "perf-project-1",
    cwd: "/tmp/perf/codething-mvp",
    name: "codething-mvp",
  },
  {
    id: "perf-project-2",
    cwd: "/tmp/perf/contracts-bench",
    name: "contracts-bench",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  let postPr = false;
  let seedPath = null;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--post-pr") {
      postPr = true;
      continue;
    }
    if (arg === "--seed") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--seed requires a file path");
      }
      seedPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--seed=")) {
      const value = arg.slice("--seed=".length).trim();
      if (value.length === 0) {
        throw new Error("--seed= requires a non-empty path");
      }
      seedPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    postPr,
    seedPath,
  };
}

function toMs(us) {
  return us / 1000;
}

function round(n, digits = 3) {
  return Number(n.toFixed(digits));
}

function mb(bytes) {
  return bytes / (1024 * 1024);
}

function parseNumericEnv({ name, value, predicate, expectation, fallback }) {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (raw.length === 0) {
    console.warn(
      `[desktop-perf] invalid ${name}="${value}" (expected ${expectation}); using ${fallback}`,
    );
    return null;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && predicate(parsed)) {
    return {
      parsed,
      raw,
    };
  }
  console.warn(
    `[desktop-perf] invalid ${name}="${value}" (expected ${expectation}); using ${fallback}`,
  );
  return null;
}

function resolveNonNegativeNumberEnv({ name, value, fallback }) {
  const resolved = parseNumericEnv({
    name,
    value,
    predicate: (parsed) => parsed >= 0,
    expectation: "non-negative number",
    fallback,
  });
  return resolved?.parsed ?? fallback;
}

function resolveNonNegativeIntegerEnv({ name, value, fallback }) {
  const resolved = parseNumericEnv({
    name,
    value,
    predicate: (parsed) => parsed >= 0,
    expectation: "non-negative number",
    fallback,
  });
  if (!resolved) {
    return fallback;
  }
  const normalized = Math.trunc(resolved.parsed);
  if (normalized !== resolved.parsed) {
    console.warn(
      `[desktop-perf] non-integer ${name}="${resolved.raw}" truncated to ${normalized} for consistency`,
    );
  }
  return normalized;
}

function resolvePositiveIntegerEnv({ name, value, fallback }) {
  const resolved = parseNumericEnv({
    name,
    value,
    predicate: (parsed) => parsed > 0,
    expectation: "positive number",
    fallback,
  });
  if (!resolved) {
    return fallback;
  }
  const normalized = Math.trunc(resolved.parsed);
  if (normalized !== resolved.parsed) {
    console.warn(
      `[desktop-perf] non-integer ${name}="${resolved.raw}" truncated to ${normalized} for consistency`,
    );
  }
  return normalized;
}

function summarizeTrace(tracePath) {
  const payload = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const events = payload.traceEvents;

  const durationByName = new Map();
  const dispatchRows = [];
  const functionRows = [];
  const userTiming = new Map();
  const updateCounters = [];

  for (const event of events) {
    if (event.name === "UpdateCounters" && event.args?.data) {
      const heap = event.args.data.jsHeapSizeUsed;
      if (typeof heap === "number") {
        updateCounters.push(heap);
      }
    }

    if (event.cat === "blink.user_timing" && typeof event.name === "string") {
      userTiming.set(event.name, (userTiming.get(event.name) ?? 0) + 1);
    }

    if (event.ph !== "X" || typeof event.dur !== "number" || typeof event.name !== "string") {
      continue;
    }

    const byName = durationByName.get(event.name) ?? { count: 0, dur: 0, max: 0 };
    byName.count += 1;
    byName.dur += event.dur;
    byName.max = Math.max(byName.max, event.dur);
    durationByName.set(event.name, byName);

    if (event.name === "EventDispatch") {
      const type = event.args?.data?.type ?? "";
      dispatchRows.push({ type, dur: event.dur });
    }

    if (event.name === "FunctionCall") {
      const functionName = event.args?.data?.functionName ?? "(unknown)";
      functionRows.push({ functionName, dur: event.dur });
    }
  }

  const aggregateDispatchType = (type) => {
    const rows = dispatchRows.filter((row) => row.type === type);
    if (rows.length === 0) {
      return {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
      };
    }
    const totalDur = rows.reduce((sum, row) => sum + row.dur, 0);
    const maxDur = rows.reduce((max, row) => Math.max(max, row.dur), 0);
    return {
      count: rows.length,
      totalMs: round(toMs(totalDur)),
      avgMs: round(toMs(totalDur / rows.length)),
      maxMs: round(toMs(maxDur)),
    };
  };

  const aggregateFunction = (name) => {
    const rows = functionRows.filter((row) => row.functionName === name);
    if (rows.length === 0) {
      return {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
      };
    }
    const totalDur = rows.reduce((sum, row) => sum + row.dur, 0);
    const maxDur = rows.reduce((max, row) => Math.max(max, row.dur), 0);
    return {
      count: rows.length,
      totalMs: round(toMs(totalDur)),
      avgMs: round(toMs(totalDur / rows.length)),
      maxMs: round(toMs(maxDur)),
    };
  };

  const topUserTiming = [...userTiming.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topDurationEvents = [...durationByName.entries()]
    .map(([name, value]) => ({
      name,
      count: value.count,
      totalMs: round(toMs(value.dur), 2),
      avgMs: round(toMs(value.dur / value.count)),
      maxMs: round(toMs(value.max)),
    }))
    .toSorted((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const heap = (() => {
    if (updateCounters.length === 0) return null;
    const first = updateCounters[0];
    const last = updateCounters[updateCounters.length - 1];
    const min = Math.min(...updateCounters);
    const max = Math.max(...updateCounters);
    return {
      firstMb: round(mb(first), 1),
      lastMb: round(mb(last), 1),
      minMb: round(mb(min), 1),
      maxMb: round(mb(max), 1),
      deltaMb: round(mb(last - first), 1),
    };
  })();

  const longDispatchCount = dispatchRows.filter((row) => row.dur >= 50_000).length;

  return {
    keypress: aggregateDispatchType("keypress"),
    textInput: aggregateDispatchType("textInput"),
    input: aggregateDispatchType("input"),
    keydown: aggregateDispatchType("keydown"),
    dispatchDiscreteEvent: aggregateFunction("dispatchDiscreteEvent"),
    performWorkUntilDeadline: aggregateFunction("performWorkUntilDeadline"),
    longDispatchCount,
    heap,
    topUserTiming,
    topDurationEvents,
  };
}

const pad = (value, width) => String(value).padEnd(width, " ");

function evaluateThresholds(summary, thresholds) {
  const checks = [
    {
      label: "keypress avg",
      actual: summary.keypress.avgMs,
      threshold: thresholds.maxKeypressAvgMs,
      ok: summary.keypress.avgMs <= thresholds.maxKeypressAvgMs,
    },
    {
      label: "keypress max",
      actual: summary.keypress.maxMs,
      threshold: thresholds.maxKeypressMaxMs,
      ok: summary.keypress.maxMs <= thresholds.maxKeypressMaxMs,
    },
    {
      label: "long EventDispatch spikes",
      actual: summary.longDispatchCount,
      threshold: thresholds.maxLongDispatchCount,
      ok: summary.longDispatchCount <= thresholds.maxLongDispatchCount,
    },
  ];

  const failures = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label} ${check.actual} exceeds ${check.threshold}`);

  return {
    checks,
    failures,
    passed: failures.length === 0,
  };
}

function createMarkdownSummary({ tracePath, donePayload, summary, thresholds, thresholdCheck }) {
  const THREAD_COL_WIDTH = 8;
  const TITLE_COL_WIDTH = 15;
  const largeThreadRenderStats = Array.isArray(donePayload.interactions?.largeThreadRenderStats)
    ? donePayload.interactions.largeThreadRenderStats
    : [];
  const formatThreadRenderRow = (stat) => {
    const threadShort =
      typeof stat.threadId === "string" ? stat.threadId.slice(0, THREAD_COL_WIDTH) : "n/a";
    const titleShort =
      typeof stat.threadTitleShort === "string"
        ? stat.threadTitleShort
        : typeof stat.threadId === "string"
          ? stat.threadId.slice(0, 15)
          : "n/a";
    const firstRenderMs =
      typeof stat.firstRenderMs === "number"
        ? stat.firstRenderMs
        : typeof stat.renderMs === "number"
          ? stat.renderMs
          : "n/a";
    const followUpRenderMs =
      typeof stat.followUpRenderMs === "number" ? stat.followUpRenderMs : "n/a";
    const followUpMinMs = typeof stat.followUpMinMs === "number" ? stat.followUpMinMs : "n/a";
    const followUpMaxMs = typeof stat.followUpMaxMs === "number" ? stat.followUpMaxMs : "n/a";
    const followUpSampleCount =
      typeof stat.followUpSampleCount === "number" ? stat.followUpSampleCount : "n/a";
    const deltaMs = typeof stat.deltaMs === "number" ? stat.deltaMs : "n/a";
    const deltaPct = typeof stat.deltaPct === "number" ? stat.deltaPct : "n/a";
    const followUpRange =
      typeof followUpMinMs === "number" && typeof followUpMaxMs === "number"
        ? `${followUpMinMs}-${followUpMaxMs} (${followUpSampleCount}x)`
        : "n/a";
    return `| ${pad(threadShort, THREAD_COL_WIDTH)} | ${pad(titleShort, TITLE_COL_WIDTH)} | ${stat.messageCount} | ${firstRenderMs} | ${followUpRenderMs} | ${followUpRange} | ${deltaMs} | ${deltaPct}% |`;
  };
  const benchmarkThreadIds = Array.isArray(donePayload.interactions?.benchmarkThreadIds)
    ? donePayload.interactions.benchmarkThreadIds
    : [];
  const seedSource =
    donePayload.seed?.source === "file"
      ? `file (\`${donePayload.seed?.path ?? "unknown"}\`)`
      : (donePayload.seed?.source ?? "generated");
  const topDurationHead = summary.topDurationEvents.slice(0, 3);
  const topDurationSummary =
    topDurationHead.length === 0
      ? "none"
      : topDurationHead.map((entry) => `${entry.name} (${entry.totalMs}ms total)`).join(", ");
  const actionLines = thresholdCheck.passed
    ? [
        "- Action: no threshold regressions detected in this run.",
        "- Follow-up: keep watching top duration events for drift in future traces.",
      ]
    : [
        "- Action: threshold regression detected; profile and optimize the failing path(s) before merge.",
        ...thresholdCheck.failures.map((failure) => `- Failing metric: ${failure}`),
      ];
  const lines = [
    marker,
    "## Desktop Dev Perf Trace",
    "",
    `- Status: ${thresholdCheck.passed ? "PASS" : "FAIL"}`,
    `- Thresholds: keypress avg ${summary.keypress.avgMs}/${thresholds.maxKeypressAvgMs}ms, keypress max ${summary.keypress.maxMs}/${thresholds.maxKeypressMaxMs}ms, long dispatch spikes ${summary.longDispatchCount}/${thresholds.maxLongDispatchCount}`,
    `- Coverage: seed=${seedSource}; projects=${donePayload.seed?.projectCount ?? "n/a"}; threads=${donePayload.seed?.threadCount ?? "n/a"}; benchmark threads exercised=${benchmarkThreadIds.length}`,
    `- Interaction volume: thread clicks=${donePayload.interactions?.threadClicks ?? "n/a"}, typed chars=${donePayload.interactions?.typedChars ?? "n/a"}`,
    `- Top hotspots: ${topDurationSummary}`,
    "",
    ...actionLines,
    "",
    "<details>",
    "<summary>Detailed trace metrics and diagnostics</summary>",
    "",
    "### Run Metadata",
    "",
    `- Command: \`bun dev:desktop\``,
    `- Trace: \`${tracePath}\``,
    `- Started: ${donePayload.startedAt ?? "n/a"}`,
    `- Completed: ${donePayload.completedAt ?? "n/a"}`,
    `- Duration: ${donePayload.durationMs ?? "n/a"} ms`,
    "",
    "### Interaction Run",
    "",
    `- Thread clicks: ${donePayload.interactions?.threadClicks ?? "n/a"}`,
    `- Typed chars: ${donePayload.interactions?.typedChars ?? "n/a"}`,
    `- Benchmark thread ids exercised: ${benchmarkThreadIds.length > 0 ? benchmarkThreadIds.join(", ") : "none"}`,
    `- Model selected: ${donePayload.interactions?.selectedModel ?? "n/a"}`,
    `- Terminal opened by shortcut: ${donePayload.interactions?.terminal?.openedByShortcut ?? "n/a"}`,
    `- Terminal shortcut modifier: ${donePayload.interactions?.terminal?.modifierUsed ?? "n/a"}`,
    `- Terminal splits: ${donePayload.interactions?.terminal?.splitCount ?? "n/a"}`,
    `- Terminal command executed: ${donePayload.interactions?.terminal?.commandFileTouched ?? "n/a"}`,
    `- Terminal output observed: ${donePayload.interactions?.terminal?.commandEchoObserved ?? "n/a"}`,
    `- Terminal marker: ${donePayload.interactions?.terminal?.commandMarker ?? "n/a"}`,
    `- Terminal interactions enabled: ${donePayload.config?.runTerminalInteractions ?? "n/a"}`,
    `- Optional renderer interactions enabled: ${donePayload.config?.runOptionalRendererInteractions ?? "n/a"}`,
    `- Benchmark sweep enabled: ${donePayload.config?.runBenchmarkThreadSweep ?? "n/a"}`,
    `- Benchmark follow-up pass count: ${donePayload.config?.benchmarkFollowUpPassCount ?? "n/a"}`,
    "",
    "### Threshold Config",
    "",
    `- keypress avg max: ${thresholds.maxKeypressAvgMs}ms`,
    `- keypress max max: ${thresholds.maxKeypressMaxMs}ms`,
    `- long EventDispatch spike cap: ${thresholds.maxLongDispatchCount}`,
    "",
    "### Benchmark Thread Render",
    "",
    "| Thread | Title (15) | Messages | First Nav (ms) | Follow-up Median (ms) | Follow-up Range | Delta (ms) | Delta (%) |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |",
    ...(largeThreadRenderStats.length > 0
      ? largeThreadRenderStats.map((stat) => formatThreadRenderRow(stat))
      : ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |"]),
    "",
    "### Input Event Metrics",
    "",
    "| Event | Count | Avg (ms) | Max (ms) | Total (ms) |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| keypress | ${summary.keypress.count} | ${summary.keypress.avgMs} | ${summary.keypress.maxMs} | ${summary.keypress.totalMs} |`,
    `| textInput | ${summary.textInput.count} | ${summary.textInput.avgMs} | ${summary.textInput.maxMs} | ${summary.textInput.totalMs} |`,
    `| input | ${summary.input.count} | ${summary.input.avgMs} | ${summary.input.maxMs} | ${summary.input.totalMs} |`,
    `| keydown | ${summary.keydown.count} | ${summary.keydown.avgMs} | ${summary.keydown.maxMs} | ${summary.keydown.totalMs} |`,
    "",
    "### Scheduler/Event Hotspots",
    "",
    `- dispatchDiscreteEvent: ${summary.dispatchDiscreteEvent.totalMs}ms total (${summary.dispatchDiscreteEvent.count} calls)`,
    `- performWorkUntilDeadline: ${summary.performWorkUntilDeadline.totalMs}ms total (${summary.performWorkUntilDeadline.count} calls)`,
    `- EventDispatch spikes >= 50ms: ${summary.longDispatchCount}`,
    "",
    "### Threshold Check",
    "",
    ...thresholdCheck.checks.map(
      (check) =>
        `- ${check.label} <= ${check.threshold}: ${check.ok ? "pass" : `fail (actual ${check.actual})`}`,
    ),
    "",
  ];

  if (summary.heap) {
    lines.push("### Heap Counters", "");
    lines.push(
      `- first=${summary.heap.firstMb}MB, last=${summary.heap.lastMb}MB, min=${summary.heap.minMb}MB, max=${summary.heap.maxMb}MB, delta=${summary.heap.deltaMb}MB`,
      "",
    );
  }

  lines.push("### Top User Timing Marks", "");
  for (const entry of summary.topUserTiming) {
    lines.push(`- ${entry.count}x ${entry.name}`);
  }
  lines.push("", "### Top Duration Events", "");
  for (const entry of summary.topDurationEvents) {
    lines.push(
      `- ${entry.name}: total=${entry.totalMs}ms, avg=${entry.avgMs}ms, max=${entry.maxMs}ms, count=${entry.count}`,
    );
  }
  lines.push("", "</details>", "");

  return lines.join("\n");
}

async function waitForDoneFile(donePath, child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(donePath)) {
      return JSON.parse(fs.readFileSync(donePath, "utf8"));
    }
    if (child.exitCode !== null) {
      throw new Error(`desktop dev process exited early (code ${child.exitCode})`);
    }
    // oxlint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  throw new Error(`Timed out waiting for done marker at ${donePath}`);
}

function tailLogText(logChunks, lineCount = 120) {
  const lines = logChunks.join("").split(/\r?\n/);
  return lines.slice(-lineCount).join("\n").trim();
}

function inferDesktopPerfTimeoutHint(logChunks) {
  const joined = logChunks.join("");
  const lowered = joined.toLowerCase();

  if (lowered.includes("waiting for bundles") && lowered.includes("outdated:")) {
    return "Desktop bundles were present but older than desktop source files; dev bundler did not refresh outputs in time.";
  }
  if (lowered.includes("waiting for bundles") && lowered.includes("stale:")) {
    return "Desktop bundles were detected as stale by startup freshness checks.";
  }
  if (lowered.includes("error while loading shared libraries")) {
    return "Electron failed to start due missing Linux shared libraries.";
  }
  if (lowered.includes("setuid_sandbox_host.cc") || lowered.includes("chrome-sandbox")) {
    return "Electron sandbox setup failed on Linux CI (setuid sandbox helper).";
  }
  if (lowered.includes("no usable sandbox")) {
    return "Electron sandbox failed to initialize in CI.";
  }
  if (lowered.includes("port is already in use")) {
    return "Dev server port collision prevented Electron from loading the renderer.";
  }
  if (!joined.includes("[desktop-perf]")) {
    return "Desktop perf automation never started; Electron likely did not boot successfully.";
  }
  if (joined.includes("[desktop-perf]") && !joined.includes("[desktop-perf] trace recorded")) {
    return "Desktop perf automation started but did not complete trace recording.";
  }

  return "Desktop perf automation timed out before writing the done marker.";
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill("SIGTERM");
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  await sleep(1_500);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function detectPrNumber() {
  const githubRef = process.env.GITHUB_REF ?? "";
  const match = githubRef.match(/refs\/pull\/(\d+)\//);
  if (match?.[1]) {
    return match[1];
  }

  return execFileSync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function postSummaryToPr(summaryPath) {
  const prNumber = detectPrNumber();
  execFileSync(
    "gh",
    ["pr", "comment", prNumber, "--body-file", summaryPath, "--edit-last", "--create-if-none"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
}

function prepareDesktopPerfState(stateDir, perfProjects = defaultPerfProjects) {
  fs.mkdirSync(stateDir, { recursive: true });

  for (const project of perfProjects) {
    try {
      fs.mkdirSync(project.cwd, { recursive: true });
    } catch {
      // Some seeded paths may point to unavailable locations in CI; registry entries still work.
    }
  }

  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, "projects.json"),
    JSON.stringify(
      {
        version: 1,
        projects: perfProjects.map((project) => ({
          id: project.id,
          cwd: project.cwd,
          name: project.name,
          createdAt: now,
          updatedAt: now,
        })),
      },
      null,
      2,
    ),
  );
}

function resolveSeedPath(seedPathArg) {
  const candidateArg = seedPathArg ?? process.env.T3CODE_DESKTOP_PERF_SEED_PATH ?? "";
  if (!candidateArg || candidateArg.trim().length === 0) {
    const resolvedDefault = path.resolve(repoRoot, defaultSeedRelativePath);
    if (!fs.existsSync(resolvedDefault)) {
      throw new Error(
        `Default desktop perf seed file is required but missing: ${resolvedDefault}. Pass --seed to override.`,
      );
    }
    return resolvedDefault;
  }

  const resolved = path.isAbsolute(candidateArg)
    ? candidateArg
    : path.resolve(repoRoot, candidateArg);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Seed file not found: ${resolved}`);
  }
  return resolved;
}

function normalizeProjectPathForRuntime(rawCwd, projectName, projectId, projectIndex) {
  const attemptedPath = path.resolve(rawCwd);
  try {
    fs.mkdirSync(attemptedPath, { recursive: true });
    return attemptedPath;
  } catch {
    const safeName = (projectName || projectId || `project-${projectIndex + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const fallbackPath = path.join(
      os.tmpdir(),
      "t3code-desktop-perf-seed-projects",
      `${String(projectIndex + 1).padStart(2, "0")}-${safeName || "project"}`,
    );
    fs.mkdirSync(fallbackPath, { recursive: true });
    return fallbackPath;
  }
}

function materializeRuntimeSeed(seedPath, artifactsDir) {
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) {
    return { runtimeSeedPath: seedPath, projects: null };
  }

  const rewrittenProjects = [];
  let rewroteAnyProject = false;
  for (let index = 0; index < raw.projects.length; index += 1) {
    const project = raw.projects[index];
    if (!project || typeof project !== "object") {
      rewrittenProjects.push(project);
      continue;
    }

    const id = typeof project.id === "string" ? project.id : "";
    const name = typeof project.name === "string" ? project.name : "";
    const cwd = typeof project.cwd === "string" ? project.cwd : "";
    if (id.length === 0 || name.length === 0 || cwd.length === 0) {
      rewrittenProjects.push(project);
      continue;
    }

    const runtimeCwd = normalizeProjectPathForRuntime(cwd, name, id, index);
    if (runtimeCwd !== cwd) {
      rewroteAnyProject = true;
    }
    rewrittenProjects.push({
      ...project,
      cwd: runtimeCwd,
    });
  }

  if (!rewroteAnyProject) {
    const projects = rewrittenProjects
      .map((project) => {
        if (!project || typeof project !== "object") return null;
        const id = typeof project.id === "string" ? project.id : "";
        const cwd = typeof project.cwd === "string" ? project.cwd : "";
        const name = typeof project.name === "string" ? project.name : "";
        if (id.length === 0 || cwd.length === 0 || name.length === 0) return null;
        return { id, cwd, name };
      })
      .filter((project) => project !== null);

    return {
      runtimeSeedPath: seedPath,
      projects: projects.length > 0 ? projects : null,
    };
  }

  const runtimeSeedPath = path.join(artifactsDir, "perf-seed.runtime.json");
  fs.writeFileSync(
    runtimeSeedPath,
    JSON.stringify(
      {
        ...raw,
        projects: rewrittenProjects,
      },
      null,
      2,
    ),
  );

  const projects = rewrittenProjects
    .map((project) => {
      if (!project || typeof project !== "object") return null;
      const id = typeof project.id === "string" ? project.id : "";
      const cwd = typeof project.cwd === "string" ? project.cwd : "";
      const name = typeof project.name === "string" ? project.name : "";
      if (id.length === 0 || cwd.length === 0 || name.length === 0) return null;
      return { id, cwd, name };
    })
    .filter((project) => project !== null);

  return {
    runtimeSeedPath,
    projects: projects.length > 0 ? projects : null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = path.join(os.tmpdir(), "t3code-perf-artifacts", `desktop-dev-${timestamp}`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const tracePath = path.join(artifactsDir, "trace.json");
  const donePath = path.join(artifactsDir, "done.json");
  const summaryPath = path.join(artifactsDir, "summary.md");
  const logPath = path.join(artifactsDir, "run.log");
  const stateDir = path.join(artifactsDir, "state");
  const seedPath = resolveSeedPath(args.seedPath);
  const materializedSeed = seedPath ? materializeRuntimeSeed(seedPath, artifactsDir) : null;
  const runtimeSeedPath = materializedSeed?.runtimeSeedPath ?? seedPath;
  const seedProjects = materializedSeed?.projects ?? null;
  if (seedPath && runtimeSeedPath && runtimeSeedPath !== seedPath) {
    console.log(
      `[desktop-perf] rewrote seed project cwd paths for runtime compatibility: ${runtimeSeedPath}`,
    );
  }
  prepareDesktopPerfState(stateDir, seedProjects ?? defaultPerfProjects);

  const maxKeypressAvgMs = resolveNonNegativeNumberEnv({
    name: "T3CODE_PERF_MAX_KEYPRESS_AVG_MS",
    value: process.env.T3CODE_PERF_MAX_KEYPRESS_AVG_MS,
    fallback: 12,
  });
  const maxKeypressMaxMs = resolveNonNegativeNumberEnv({
    name: "T3CODE_PERF_MAX_KEYPRESS_MAX_MS",
    value: process.env.T3CODE_PERF_MAX_KEYPRESS_MAX_MS,
    fallback: 24,
  });
  const maxLongDispatchCount = resolveNonNegativeIntegerEnv({
    name: "T3CODE_PERF_MAX_LONG_DISPATCH_COUNT",
    value: process.env.T3CODE_PERF_MAX_LONG_DISPATCH_COUNT,
    fallback: 0,
  });
  const timeoutMs = resolvePositiveIntegerEnv({
    name: "T3CODE_PERF_TIMEOUT_MS",
    value: process.env.T3CODE_PERF_TIMEOUT_MS,
    fallback: 420000,
  });
  console.log(
    `[desktop-perf] thresholds: keypressAvg<=${maxKeypressAvgMs}ms, keypressMax<=${maxKeypressMaxMs}ms, longDispatch<=${maxLongDispatchCount}, timeoutMs=${timeoutMs}`,
  );

  const child = spawn("bun", ["dev:desktop"], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      T3CODE_DESKTOP_PERF_AUTOMATION: "1",
      T3CODE_DESKTOP_PERF_TRACE_OUT: tracePath,
      T3CODE_DESKTOP_PERF_DONE_OUT: donePath,
      ...(runtimeSeedPath ? { T3CODE_DESKTOP_PERF_SEED_PATH: runtimeSeedPath } : {}),
      T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP:
        process.env.T3CODE_DESKTOP_PERF_RUN_BENCHMARK_SWEEP ?? "1",
      T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES:
        process.env.T3CODE_DESKTOP_PERF_BENCHMARK_FOLLOW_UP_PASSES ?? "1",
      T3CODE_DEV_INSTANCE: `desktop-perf-${timestamp}`,
      T3CODE_LOG_WS_EVENTS: "0",
      T3CODE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  const appendLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 1200) {
      logs.splice(0, logs.length - 1200);
    }
    fs.appendFileSync(logPath, text);
    process.stdout.write(text);
  };

  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);

  let donePayload;
  try {
    donePayload = await waitForDoneFile(donePath, child, timeoutMs);
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const hint = inferDesktopPerfTimeoutHint(logs);
    const logTail = tailLogText(logs);
    throw new Error(
      [
        baseMessage,
        `Hint: ${hint}`,
        `Artifacts dir: ${artifactsDir}`,
        `Run log: ${logPath}`,
        logTail.length > 0 ? `Recent log tail:\n${logTail}` : "Recent log tail: <empty>",
      ].join("\n"),
      { cause: error },
    );
  } finally {
    await terminateProcessTree(child);
  }

  if (!donePayload || donePayload.status !== "ok") {
    throw new Error(
      `Desktop perf automation failed. ${donePayload?.error ?? "No completion payload written."}`,
    );
  }

  const interactionChecks = [];
  const threadClicks = Number(donePayload.interactions?.threadClicks ?? 0);
  const typedChars = Number(donePayload.interactions?.typedChars ?? 0);
  if (threadClicks <= 0) {
    interactionChecks.push("thread clicks");
  }
  if (typedChars <= 0) {
    interactionChecks.push("typed chars");
  }
  if (interactionChecks.length > 0) {
    throw new Error(
      `Desktop perf automation completed without required scripted interactions: ${interactionChecks.join(", ")}`,
    );
  }

  const summary = summarizeTrace(tracePath);
  const thresholdCheck = evaluateThresholds(summary, {
    maxKeypressAvgMs,
    maxKeypressMaxMs,
    maxLongDispatchCount,
  });
  const markdown = createMarkdownSummary({
    tracePath,
    donePayload,
    summary,
    thresholds: {
      maxKeypressAvgMs,
      maxKeypressMaxMs,
      maxLongDispatchCount,
    },
    thresholdCheck,
  });
  fs.writeFileSync(summaryPath, markdown);

  console.log(`\nPerf summary written to ${summaryPath}\n`);
  console.log(markdown);

  if (args.postPr) {
    postSummaryToPr(summaryPath);
  }

  if (!thresholdCheck.passed) {
    throw new Error(`Performance thresholds failed:\n- ${thresholdCheck.failures.join("\n- ")}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("\nDesktop perf trace test failed:\n" + message);
  process.exit(1);
});
