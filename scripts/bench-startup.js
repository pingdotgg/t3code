import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const RESULT_PREFIX = "T3_STARTUP_BENCH_RESULT ";
const NOOP = () => undefined;

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv) {
  const config = {
    ref: "HEAD",
    projectCount: 100,
    threadsPerProject: 100,
    activitiesPerThread: 0,
    seedMode: "projected",
    serverReadyOnly: false,
    keep: false,
  };
  const mutable = { ...config };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--ref":
        mutable.ref = requireValue(arg, next);
        index += 1;
        break;
      case "--project-count":
        mutable.projectCount = parsePositiveInt(arg, requireValue(arg, next));
        index += 1;
        break;
      case "--threads-per-project":
        mutable.threadsPerProject = parsePositiveInt(arg, requireValue(arg, next));
        index += 1;
        break;
      case "--activities-per-thread":
        mutable.activitiesPerThread = parseNonNegativeInt(arg, requireValue(arg, next));
        index += 1;
        break;
      case "--seed-mode":
        mutable.seedMode = requireValue(arg, next);
        if (mutable.seedMode !== "events-only" && mutable.seedMode !== "projected") {
          throw new Error("--seed-mode must be events-only or projected.");
        }
        index += 1;
        break;
      case "--server-ready-only":
        mutable.serverReadyOnly = true;
        break;
      case "--keep":
        mutable.keep = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return mutable;
}

function printUsage() {
  console.log(`Usage: bun scripts/bench-startup.js [options]

Options:
  --ref <label>                  Result label. Default: HEAD
  --project-count <count>        Projects to seed. Default: 100
  --threads-per-project <count>  Threads per project. Default: 100
  --activities-per-thread <n>    Synthetic activities per thread. Default: 0
  --seed-mode <mode>             projected or events-only. Default: projected
  --server-ready-only            Stop after the server prints headless ready output
  --keep                         Keep .tmp/bench-startup working directory
`);
}

function requireValue(flag, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(flag, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function isoTime(offsetSeconds) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

function buildEvents(config) {
  const events = [];
  let eventNumber = 1;

  for (let projectIndex = 0; projectIndex < config.projectCount; projectIndex += 1) {
    const projectId = `project-${projectIndex}`;
    events.push({
      type: "project.created",
      eventId: `evt-${eventNumber}`,
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: isoTime(eventNumber),
      commandId: `cmd-${eventNumber}`,
      causationEventId: null,
      correlationId: `cmd-${eventNumber}`,
      metadata: {},
      payload: {
        projectId,
        title: `Startup Project ${projectIndex}`,
        workspaceRoot: `/tmp/t3-startup-bench/project-${projectIndex}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: isoTime(eventNumber),
        updatedAt: isoTime(eventNumber),
      },
    });
    eventNumber += 1;

    for (let threadIndex = 0; threadIndex < config.threadsPerProject; threadIndex += 1) {
      const threadId = `thread-${projectIndex}-${threadIndex}`;
      events.push({
        type: "thread.created",
        eventId: `evt-${eventNumber}`,
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: isoTime(eventNumber),
        commandId: `cmd-${eventNumber}`,
        causationEventId: null,
        correlationId: `cmd-${eventNumber}`,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: `Startup Thread ${projectIndex}/${threadIndex}`,
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: threadIndex % 11 === 0 ? "plan" : "default",
          branch: null,
          worktreePath: null,
          createdAt: isoTime(eventNumber),
          updatedAt: isoTime(eventNumber),
        },
      });
      eventNumber += 1;

      for (let activityIndex = 0; activityIndex < config.activitiesPerThread; activityIndex += 1) {
        events.push({
          type: "thread.activity-appended",
          eventId: `evt-${eventNumber}`,
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: isoTime(eventNumber),
          commandId: `cmd-${eventNumber}`,
          causationEventId: null,
          correlationId: `cmd-${eventNumber}`,
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: `activity-${projectIndex}-${threadIndex}-${activityIndex}`,
              tone: "info",
              kind: "tool.output",
              summary: `Synthetic startup activity ${activityIndex}`,
              payload: {
                detail: `Synthetic startup activity payload ${activityIndex}`,
              },
              turnId: null,
              createdAt: isoTime(eventNumber),
            },
          },
        });
        eventNumber += 1;
      }
    }
  }

  return events;
}

async function importRepoModule(root, relativePath) {
  return import(pathToFileURL(join(root, relativePath)).href);
}

async function seedDatabase(root, baseDir, config) {
  const [
    Effect,
    Layer,
    NodeServices,
    OrchestrationEventStoreLayer,
    OrchestrationEventStoreService,
    SqliteLayer,
    ServerConfigModule,
    ProjectionPipelineLayer,
    ProjectionPipelineService,
  ] = await Promise.all([
    import("effect/Effect"),
    import("effect/Layer"),
    import("@effect/platform-node/NodeServices"),
    importRepoModule(root, "apps/server/src/persistence/Layers/OrchestrationEventStore.ts"),
    importRepoModule(root, "apps/server/src/persistence/Services/OrchestrationEventStore.ts"),
    importRepoModule(root, "apps/server/src/persistence/Layers/Sqlite.ts"),
    importRepoModule(root, "apps/server/src/config.ts"),
    importRepoModule(root, "apps/server/src/orchestration/Layers/ProjectionPipeline.ts"),
    importRepoModule(root, "apps/server/src/orchestration/Services/ProjectionPipeline.ts"),
  ]);

  const projectionPipelineLayer = ProjectionPipelineLayer.OrchestrationProjectionPipelineLive.pipe(
    Layer.provide(OrchestrationEventStoreLayer.OrchestrationEventStoreLive),
  );
  const appLayer = Layer.mergeAll(
    OrchestrationEventStoreLayer.OrchestrationEventStoreLive,
    projectionPipelineLayer,
  ).pipe(
    Layer.provideMerge(ServerConfigModule.ServerConfig.layerTest(root, baseDir)),
    Layer.provideMerge(
      SqliteLayer.makeSqlitePersistenceLive(join(baseDir, "userdata", "state.sqlite")),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  const events = buildEvents(config);
  const startedAt = performance.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStoreService.OrchestrationEventStore;
      const projectionPipeline = yield* ProjectionPipelineService.OrchestrationProjectionPipeline;
      for (const event of events) {
        yield* eventStore.append(event);
      }
      if (config.seedMode === "projected") {
        yield* projectionPipeline.bootstrap;
      }
    }).pipe(Effect.provide(Layer.fresh(appLayer))),
  );
  return {
    eventCount: events.length,
    seedMs: performance.now() - startedAt,
  };
}

function startServer(root, baseDir) {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "serve", "--base-dir", baseDir, root],
    {
      cwd: root,
      env: {
        ...process.env,
        T3CODE_LOG_LEVEL: "Error",
        T3CODE_TRACE_MIN_LEVEL: "Debug",
        T3CODE_TRACE_BATCH_WINDOW_MS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let connectionString = null;
  let token = null;
  let resolved = false;

  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(`Timed out waiting for server ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 60_000);

    const inspect = () => {
      const connectionMatch = stdout.match(/^Connection string: (.+)$/m);
      const tokenMatch = stdout.match(/^Token: (.+)$/m);
      connectionString = connectionMatch?.[1]?.trim() ?? connectionString;
      token = tokenMatch?.[1]?.trim() ?? token;
      if (!resolved && connectionString && token) {
        resolved = true;
        clearTimeout(timeout);
        resolveReady({
          bootReadyMs: performance.now() - startedAt,
          connectionString,
          token,
        });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectReady);
    child.on("exit", (code, signal) => {
      if (!resolved) {
        clearTimeout(timeout);
        rejectReady(
          new Error(
            `Server exited before ready: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
  });

  return {
    child,
    ready,
    output: () => ({ stdout, stderr }),
  };
}

async function postJson(url, body, bearerToken) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function firstSubscriptionValue(subscribe) {
  return new Promise((resolveValue, rejectValue) => {
    let cleanup = NOOP;
    const timeout = setTimeout(() => {
      cleanup();
      rejectValue(new Error("Timed out waiting for subscription snapshot."));
    }, 60_000);
    cleanup = subscribe((value) => {
      clearTimeout(timeout);
      cleanup();
      resolveValue(value);
    });
  });
}

async function measureInitialWebSync(root, connectionString, token) {
  const authStartedAt = performance.now();
  const bearer = await postJson(`${connectionString}/api/auth/bootstrap/bearer`, {
    credential: token,
  });
  const bearerMs = performance.now() - authStartedAt;

  const wsTokenStartedAt = performance.now();
  const wsToken = await postJson(`${connectionString}/api/auth/ws-token`, {}, bearer.sessionToken);
  const wsTokenMs = performance.now() - wsTokenStartedAt;

  const [{ WsTransport }, { createWsRpcClient }] = await Promise.all([
    importRepoModule(root, "apps/web/src/rpc/wsTransport.ts"),
    importRepoModule(root, "apps/web/src/rpc/wsRpcClient.ts"),
  ]);
  const wsUrl = new URL(connectionString);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("wsToken", wsToken.token);

  const transport = new WsTransport(wsUrl.toString());
  const client = createWsRpcClient(transport);

  const syncStartedAt = performance.now();
  const lifecyclePromise = firstSubscriptionValue((listener) =>
    client.server.subscribeLifecycle(listener),
  );
  const configPromise = firstSubscriptionValue((listener) =>
    client.server.subscribeConfig(listener),
  );
  const shellPromise = firstSubscriptionValue((listener) =>
    client.orchestration.subscribeShell(listener),
  );
  const [lifecycle, config, shell] = await Promise.all([
    lifecyclePromise,
    configPromise,
    shellPromise,
  ]);
  const initialSyncMs = performance.now() - syncStartedAt;

  await client.dispose();

  return {
    bearerMs,
    wsTokenMs,
    initialSyncMs,
    lifecycleEventCount: Array.isArray(lifecycle) ? lifecycle.length : 1,
    providerCount: config?.type === "snapshot" ? config.config.providers.length : null,
    projectCount: shell?.kind === "snapshot" ? shell.snapshot.projects.length : null,
    threadCount: shell?.kind === "snapshot" ? shell.snapshot.threads.length : null,
  };
}

function recordSlowSpan(spans, span) {
  const insertAt = spans.findIndex((candidate) => span.durationMs > candidate.durationMs);
  if (insertAt === -1) {
    if (spans.length < 12) {
      spans.push(span);
    }
    return;
  }
  spans.splice(insertAt, 0, span);
  if (spans.length > 12) {
    spans.length = 12;
  }
}

async function readTraceSummary(baseDir) {
  const tracePath = join(baseDir, "userdata", "logs", "server.trace.ndjson");
  if (!existsSync(tracePath)) {
    return { tracePath, slowestSpans: [] };
  }
  const spans = [];
  const byName = new Map();
  const lines = createInterface({
    input: createReadStream(tracePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.name === "string" && typeof parsed.durationMs === "number") {
        const span = { name: parsed.name, durationMs: parsed.durationMs };
        recordSlowSpan(spans, span);
        const existing = byName.get(span.name) ?? {
          name: span.name,
          count: 0,
          totalMs: 0,
          maxMs: 0,
        };
        existing.count += 1;
        existing.totalMs += span.durationMs;
        existing.maxMs = Math.max(existing.maxMs, span.durationMs);
        byName.set(span.name, existing);
      }
    } catch {
      // Ignore incomplete trace lines from a just-killed server.
    }
  }
  const topSpanTotals = Array.from(byName.values())
    .toSorted((left, right) => right.totalMs - left.totalMs)
    .slice(0, 12);
  return {
    tracePath,
    slowestSpans: spans,
    topSpanTotals,
  };
}

function currentCommit(root) {
  const result = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    const commit = result.stdout.trim();
    if (commit.length > 0) {
      return { commit, gitCommitError: null };
    }
  }
  return {
    commit: "unknown",
    gitCommitError: result.error?.message ?? result.stderr?.trim() ?? "git rev-parse failed",
  };
}

function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const benchRoot = join(root, ".tmp", "bench-startup", `${Date.now()}`);
  const baseDir = join(benchRoot, "t3-home");
  mkdirSync(baseDir, { recursive: true });

  const { commit, gitCommitError } = currentCommit(root);

  let server = null;
  try {
    const seed = await seedDatabase(root, baseDir, config);
    server = startServer(root, baseDir);
    const ready = await server.ready;
    const web = config.serverReadyOnly
      ? null
      : await measureInitialWebSync(root, ready.connectionString, ready.token);
    await stopServer(server.child);
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 50));
    const trace = await readTraceSummary(baseDir);

    const result = {
      ref: config.ref,
      commit,
      ...(gitCommitError ? { gitCommitError } : {}),
      config,
      baseDir,
      seed,
      metrics: {
        "startup.seedDatabase": { ms: seed.seedMs },
        "startup.serverReady": { ms: ready.bootReadyMs },
        ...(web
          ? {
              "startup.authBearer": { ms: web.bearerMs },
              "startup.authWsToken": { ms: web.wsTokenMs },
              "startup.initialWebSync": { ms: web.initialSyncMs },
            }
          : {}),
      },
      observed: {
        eventCount: seed.eventCount,
        projectCount: web?.projectCount ?? null,
        threadCount: web?.threadCount ?? null,
        providerCount: web?.providerCount ?? null,
        lifecycleEventCount: web?.lifecycleEventCount ?? null,
      },
      trace,
    };
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
  } finally {
    if (server) {
      await stopServer(server.child);
    }
    if (!config.keep) {
      rmSync(benchRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
