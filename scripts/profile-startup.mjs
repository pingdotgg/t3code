// Opt in with T3CODE_STARTUP_PROFILE_DIR=/absolute/path NODE_OPTIONS="--no-node-snapshot --import=/absolute/path/to/this/file".
import * as NodeFS from "node:fs";
import * as NodeInspector from "node:inspector";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeURL from "node:url";

import { profileStartupModules } from "./profile-startup-modules.mjs";

const directory = process.env.T3CODE_STARTUP_PROFILE_DIR;
const isLauncher = process.argv[1] === NodeURL.fileURLToPath(import.meta.url);
if (directory && !isLauncher) {
  NodeFS.mkdirSync(directory, { recursive: true });
  const { threadId } = NodeWorkerThreads;
  const prefix = NodePath.join(directory, `${process.pid}-${threadId}`);
  const origin = NodePerfHooks.performance.timeOrigin;
  const events = [];
  const session = new NodeInspector.Session();
  session.connect();
  session.post("Profiler.setSamplingInterval", { interval: 1000 });
  session.post("Profiler.enable");
  const profileStartTimeUnixMs = origin + NodePerfHooks.performance.now();
  session.post("Profiler.start");

  const moduleDetails = profileStartupModules(session, events, threadId);

  const measure = (name, operation, cat = "module", attributes = {}) => {
    const start = NodePerfHooks.performance.now();
    try {
      return operation();
    } finally {
      events.push({
        name,
        cat,
        ph: "X",
        pid: process.pid,
        tid: threadId,
        ts: (origin + start) * 1000,
        dur: (NodePerfHooks.performance.now() - start) * 1000,
        args: attributes,
      });
    }
  };

  const recordMeasures = (entries) => {
    for (const entry of entries) {
      events.push({
        name: entry.name,
        cat: "startup",
        ph: "X",
        pid: process.pid,
        tid: threadId,
        ts: (origin + entry.startTime) * 1000,
        dur: entry.duration * 1000,
      });
    }
  };
  const observer = new NodePerfHooks.PerformanceObserver((list) =>
    recordMeasures(list.getEntries()),
  );
  observer.observe({ entryTypes: ["measure"] });
  const execFileSync = NodeChildProcess.default.execFileSync;
  NodeChildProcess.default.execFileSync = function (file, ...args) {
    return measure(
      `execFileSync ${file}`,
      () => execFileSync.call(this, file, ...args),
      "subprocess",
    );
  };
  NodeModule.syncBuiltinESMExports();

  const hooks = NodeModule.registerHooks({
    resolve(specifier, context, next) {
      const attributes = { specifier, parentURL: context.parentURL };
      return measure(
        `resolve ${specifier}`,
        () => {
          const result = next(specifier, context);
          attributes.url = result.url;
          attributes.format = result.format;
          return result;
        },
        "module",
        attributes,
      );
    },
    load(url, context, next) {
      const result = measure(`load ${url}`, () => next(url, context), "module", {
        url,
        format: context.format,
      });
      return moduleDetails.sourceReady(url, result);
    },
  });

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    hooks.deregister();
    moduleDetails.finish();
    recordMeasures(observer.takeRecords());
    observer.disconnect();
    NodeChildProcess.default.execFileSync = execFileSync;
    NodeModule.syncBuiltinESMExports();
    session.post("Profiler.stop", (error, result) => {
      if (!error) NodeFS.writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(result.profile));
      session.disconnect();
    });
    NodeFS.writeFileSync(`${prefix}.modules.json`, JSON.stringify({ traceEvents: events }));
    NodeFS.writeFileSync(
      `${prefix}.process.json`,
      JSON.stringify({
        pid: process.pid,
        parentPid: process.ppid,
        threadId,
        nodeVersion: process.version,
        executable: process.execPath,
        entry: process.argv[1],
        timeOrigin: origin,
        profileStartTimeUnixMs,
        captureEnd: origin + NodePerfHooks.performance.now(),
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
      }),
    );
  };
  // Bound the capture without keeping dev servers or short-lived helpers alive.
  setTimeout(finish, 20_000).unref();
  process.once("exit", finish);
}

if (isLauncher) {
  const output = NodePath.resolve(
    directory ??
      NodePath.join(".t3/startup-profiles", new Date().toISOString().replaceAll(":", "-")),
  );
  console.log(`[profile-startup] Writing CPU profiles and timeline events to ${output}`);
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/dev-runner.ts", "dev", ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        T3CODE_STARTUP_PROFILE_DIR: output,
        // Node 26's snapshotted loader cannot accept the debugger breakpoint used by this profiler.
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --no-node-snapshot --import=${import.meta.url}`.trim(),
      },
    },
  );
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
