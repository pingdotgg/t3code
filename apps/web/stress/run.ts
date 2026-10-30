// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - a standalone CLI that drives a browser and a server.
/**
 * `vp run stress`: puts a production build of T3 Code under concurrent load and records how
 * the page holds up. Several Replay threads stream long replies and stop for approvals while
 * a scripted user switches threads, approves, types, and opens panels. See README.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium, type Page } from "playwright";

import { longFrameScripts, summarizeFrames, summarizeProfile, type CpuProfile } from "./analyze.ts";
import { installStressProbe } from "./probe.ts";

const repo = NodePath.resolve(import.meta.dirname, "../../..");
const webDir = NodePath.join(repo, "apps/web");
const serverBin = NodePath.join(repo, "apps/server/src/bin.ts");
const replayAgent = NodePath.join(repo, "apps/server/scripts/dev-replay-agent.ts");

const { values: options } = NodeUtil.parseArgs({
  options: {
    threads: { type: "string", default: "5" },
    duration: { type: "string", default: "60" },
    "turns-per-thread": { type: "string", default: "4" },
    out: { type: "string" },
    "skip-build": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const THREADS = Number(options.threads);
const DURATION_MS = Number(options.duration) * 1000;
const TURNS_PER_THREAD = Number(options["turns-per-thread"]);
const runId = new Date().toISOString().replaceAll(":", "-").replace(/\..+/, "");
const outDir = NodePath.resolve(options.out ?? NodePath.join(repo, ".t3/stress/runs", runId));
const home = NodePath.join(repo, ".t3/stress/home");
const log = (message: string) => console.error(`[stress] ${message}`);

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const t3 = (...args: string[]) =>
  NodeChildProcess.execFileSync(process.execPath, [serverBin, ...args, "--base-dir", home], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function prepareHome(): string {
  NodeFS.rmSync(home, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  // The entry `vp run dev` seeds, written up front because this server runs without a dev URL.
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        devReplay: {
          driver: "acpRegistry",
          displayName: "Replay (dev)",
          config: { source: "local", commandPath: process.execPath, commandArgs: [replayAgent] },
        },
      },
    }),
  );
  const workspace = NodePath.join(home, "workspace");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# Stress workspace\n");
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspace });
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: workspace });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=stress", "-c", "user.email=stress@example.com", "commit", "-qm", "init"],
    { cwd: workspace },
  );
  return workspace;
}

async function startServer(port: number) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [serverBin, "serve", "--base-dir", home, "--port", String(port), "--no-browser"],
    {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  const serverLog = NodeFS.createWriteStream(NodePath.join(outDir, "server.log"));
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  const pairingUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /Pairing URL: (\S+)/.exec(buffered);
      if (match) resolve(match[1]!);
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}; see server.log`)));
  });
  return { child, pairingUrl };
}

// Threads sit in sidebar groups (Working, Settled) that start collapsed.
async function threadItem(page: Page, title: string) {
  const item = page.getByRole("treeitem", { name: new RegExp(`${title}\\b`) }).first();
  // Expanding one group re-renders the tree, so look for the next collapsed group each time.
  for (let attempt = 0; attempt < 5 && !(await item.isVisible()); attempt++) {
    const group = page.getByRole("treeitem", { expanded: false }).first();
    if ((await group.count()) === 0) break;
    await group.click();
  }
  return item;
}

async function act(page: Page, step: number) {
  const thread = `Stress ${(step % THREADS) + 1}`;
  await (await threadItem(page, thread)).click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  if (await approve.first().isVisible()) await approve.first().click();
  if (step % 3 === 0) {
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.click();
    await composer.pressSequentially("checking how this behaves under load", { delay: 20 });
    await composer.press("ControlOrMeta+a");
    await composer.press("Backspace");
  }
  if (step % 4 === 1) {
    await page.getByRole("button", { name: "Toggle right panel" }).click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Toggle right panel" }).click();
  }
  await page.mouse.wheel(0, step % 2 === 0 ? -1500 : 1500);
}

async function main() {
  NodeFS.mkdirSync(outDir, { recursive: true });
  if (!options["skip-build"]) {
    log("building the web client (production, unminified for readable profiles)");
    NodeChildProcess.execFileSync("vp", ["build", "--minify", "false"], {
      cwd: webDir,
      stdio: "inherit",
    });
  }
  const workspace = prepareHome();
  const port = await freePort();
  const { child, pairingUrl } = await startServer(port);
  const stopServer = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("exit", stopServer);
  try {
    t3("project", "add", workspace);
    const threadIds: string[] = [];
    for (let index = 1; index <= THREADS; index++) {
      const started = JSON.parse(
        t3(
          "thread",
          "start",
          workspace,
          "Stress turn",
          "--title",
          `Stress ${index}`,
          "--provider",
          "devReplay",
          "--model",
          "stress",
          "--json",
        ),
      ) as { threadId?: string; id?: string };
      const threadId = started.threadId ?? started.id;
      if (!threadId) throw new Error(`thread start printed no id for Stress ${index}`);
      threadIds.push(threadId);
      for (let turn = 1; turn < TURNS_PER_THREAD; turn++)
        t3("thread", "send", threadId, "Next stress turn");
    }
    log(`${THREADS} threads started with ${TURNS_PER_THREAD} turns each`);

    const browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 300)));
    await page.addInitScript(installStressProbe);
    await page.goto(pairingUrl);
    await page.getByRole("treeitem").first().waitFor({ timeout: 60_000 });
    await (
      await threadItem(page, "Stress 1")
    )
      .waitFor({ timeout: 30_000 })
      .catch(async (error: Error) => {
        await page.screenshot({ path: NodePath.join(outDir, "startup-failure.png") });
        NodeFS.writeFileSync(
          NodePath.join(outDir, "startup-failure.txt"),
          await page.innerText("body"),
        );
        throw error;
      });
    await page.waitForTimeout(3000);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
          metric.name,
          metric.value,
        ]),
      );
    const samples: Array<{ atMs: number; heapMb: number; nodes: number }> = [];
    const before = await metrics();
    await cdp.send("Profiler.start");
    await page.evaluate(() =>
      (window as unknown as { __stress: { start(): void } }).__stress.start(),
    );
    const started = Date.now();
    log(`recording for ${DURATION_MS / 1000}s`);
    let step = 0;
    while (Date.now() - started < DURATION_MS) {
      await act(page, step++).catch((error: Error) =>
        log(`step ${step} failed: ${error.message.split("\n")[0]}`),
      );
      const sample = await metrics();
      samples.push({
        atMs: Date.now() - started,
        heapMb: Math.round((sample.JSHeapUsedSize ?? 0) / 2 ** 20),
        nodes: sample.Nodes ?? 0,
      });
      if (step % 5 === 0)
        await page.screenshot({ path: NodePath.join(outDir, `step-${step}.png`) });
    }
    const probe = (await page.evaluate(() =>
      (window as unknown as { __stress: { stop(): unknown } }).__stress.stop(),
    )) as {
      frames: number[];
      longFrames: Array<{
        duration: number;
        blocking: number;
        scripts: Array<{ source: string; duration: number }>;
      }>;
      commits: number;
      renders: Record<string, number>;
      errors: string[];
    };
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
    const after = await metrics();
    NodeFS.writeFileSync(NodePath.join(outDir, "profile.cpuprofile"), JSON.stringify(profile));
    const crashed = await page.getByText("Something went wrong").count();
    await browser.close();

    const threads = threadIds.map((threadId) => t3("thread", "show", threadId, "--json"));
    const seconds = (key: string) => Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000);
    const summary = {
      runId,
      config: {
        threads: THREADS,
        turnsPerThread: TURNS_PER_THREAD,
        durationS: DURATION_MS / 1000,
        steps: step,
      },
      mainThreadMs: {
        task: seconds("TaskDuration"),
        script: seconds("ScriptDuration"),
        layout: seconds("LayoutDuration"),
        style: seconds("RecalcStyleDuration"),
      },
      frames: summarizeFrames(probe.frames),
      longAnimationFrames: {
        count: probe.longFrames.length,
        totalMs: Math.round(probe.longFrames.reduce((sum, frame) => sum + frame.duration, 0)),
        blockingMs: Math.round(probe.longFrames.reduce((sum, frame) => sum + frame.blocking, 0)),
        worstMs: Math.round(Math.max(0, ...probe.longFrames.map((frame) => frame.duration))),
        topScripts: longFrameScripts(probe.longFrames),
      },
      memory: {
        heapMbStart: samples[0]?.heapMb ?? 0,
        heapMbEnd: samples.at(-1)?.heapMb ?? 0,
        heapMbMax: Math.max(0, ...samples.map((sample) => sample.heapMb)),
        domNodesEnd: samples.at(-1)?.nodes ?? 0,
        samples,
      },
      react: {
        commits: probe.commits,
        renders: Object.values(probe.renders).reduce((sum, count) => sum + count, 0),
        topComponents: Object.entries(probe.renders).slice(0, 25),
      },
      cpu: summarizeProfile(profile, NodePath.join(webDir, "dist/assets")),
      health: {
        errorBoundaries: crashed,
        pageErrors: probe.errors,
        consoleErrors: consoleErrors.slice(0, 50),
        threadsShown: threads.length,
      },
    };
    NodeFS.writeFileSync(NodePath.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    NodeFS.writeFileSync(NodePath.join(outDir, "report.md"), report(summary));
    console.log(report(summary));
    log(`artifacts in ${outDir}`);
  } finally {
    stopServer();
  }
}

function report(summary: {
  runId: string;
  config: Record<string, number>;
  mainThreadMs: Record<string, number>;
  frames: ReturnType<typeof summarizeFrames>;
  longAnimationFrames: {
    count: number;
    totalMs: number;
    blockingMs: number;
    worstMs: number;
    topScripts: Array<[string, number]>;
  };
  memory: { heapMbStart: number; heapMbEnd: number; heapMbMax: number; domNodesEnd: number };
  react: { commits: number; renders: number; topComponents: Array<[string, number]> };
  cpu: ReturnType<typeof summarizeProfile>;
  health: { errorBoundaries: number; pageErrors: string[]; consoleErrors: string[] };
}): string {
  const rows = (entries: ReadonlyArray<readonly [string, number]>, unit: string) =>
    entries.map(([name, value]) => `| ${value} ${unit} | \`${name}\` |`).join("\n");
  const { frames, longAnimationFrames: laf, memory, react, cpu, health } = summary;
  return `# Stress run ${summary.runId}

${summary.config.threads} streaming threads, ${summary.config.durationS}s, ${summary.config.steps} user steps.

| Measure | Value |
| --- | ---: |
| Main-thread task / script / layout / style | ${summary.mainThreadMs.task} / ${summary.mainThreadMs.script} / ${summary.mainThreadMs.layout} / ${summary.mainThreadMs.style} ms |
| Frames: p50 / p95 / p99 / max | ${frames.p50Ms} / ${frames.p95Ms} / ${frames.p99Ms} / ${frames.maxMs} ms |
| Frames over 33 ms (dropped) | ${frames.droppedFrames} of ${frames.frames} |
| Long animation frames: count / total / blocking / worst | ${laf.count} / ${laf.totalMs} / ${laf.blockingMs} / ${laf.worstMs} ms |
| JS heap: start / end / max | ${memory.heapMbStart} / ${memory.heapMbEnd} / ${memory.heapMbMax} MB |
| DOM nodes at end | ${memory.domNodesEnd} |
| React commits / component renders | ${react.commits} / ${react.renders} |
| CPU busy (profile) | ${cpu.busyMs} ms |
| Error boundaries / page errors / console errors | ${health.errorBoundaries} / ${health.pageErrors.length} / ${health.consoleErrors.length} |

## CPU self time by module

| Time | Module |
| ---: | --- |
${rows(cpu.byModule, "ms")}

## CPU self time by function

| Time | Function |
| ---: | --- |
${rows(cpu.byFunction, "ms")}

## Scripts in long animation frames

| Time | Script |
| ---: | --- |
${rows(laf.topScripts, "ms")}

## Most rendered components

| Renders | Component |
| ---: | --- |
${rows(react.topComponents, "")}
`;
}

await main();
