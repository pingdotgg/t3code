/* oxlint-disable t3code/no-global-process-runtime -- This bootstrap runs before dependencies are installed. */
// @effect-diagnostics globalDate:off globalFetch:off - bootstrap has no Effect dependencies.
// @effect-diagnostics nodeBuiltinImport:off - standalone collector installed outside the checkout.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface SummaryEvent {
  id: string;
  recordedAt: number;
  host: string;
  platform: string;
  arch: string;
  ci: boolean;
  runId: string;
  tasks: {
    package: string;
    task: string;
    source: "local" | "remote" | "unspecified" | "executed" | "failed";
    savedMs: number;
  }[];
}

export function summarize(value: unknown): SummaryEvent["tasks"] {
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks))
    return [];
  return value.tasks.flatMap((task: unknown) => {
    if (
      !task ||
      typeof task !== "object" ||
      !("package_name" in task) ||
      !("task_name" in task) ||
      !("result" in task)
    )
      return [];
    if (
      typeof task.package_name !== "string" ||
      typeof task.task_name !== "string" ||
      !task.result ||
      typeof task.result !== "object"
    )
      return [];
    let source: SummaryEvent["tasks"][number]["source"] = "executed";
    let savedMs = 0;
    if ("CacheHit" in task.result) {
      const hit = task.result.CacheHit;
      if (
        !hit ||
        typeof hit !== "object" ||
        !("saved_duration_ms" in hit) ||
        typeof hit.saved_duration_ms !== "number" ||
        !Number.isSafeInteger(hit.saved_duration_ms) ||
        hit.saved_duration_ms < 0
      )
        return [];
      if ("source" in hit && hit.source !== "Local" && hit.source !== "Remote") return [];
      source = !("source" in hit) ? "unspecified" : hit.source === "Remote" ? "remote" : "local";
      savedMs = hit.saved_duration_ms;
    } else if ("RestoreFailed" in task.result) source = "failed";
    else if (!("Spawned" in task.result)) return [];
    else if (
      task.result.Spawned &&
      typeof task.result.Spawned === "object" &&
      "cache_status" in task.result.Spawned &&
      task.result.Spawned.cache_status === "Disabled"
    )
      return [];
    return [
      {
        package: task.package_name.slice(0, 256),
        task: task.task_name.slice(0, 256),
        source,
        savedMs,
      },
    ];
  });
}

export function observeSummaries(
  root: string,
  endpoint: string,
  env: NodeJS.ProcessEnv,
  home = NodeOS.homedir(),
) {
  const cache = env.VITE_CACHE_PATH || NodePath.join(root, "node_modules/.vite/task-cache");
  const queue = NodePath.join(home, ".cache/t3-task-cache/telemetry");
  let host =
    env.T3_TASK_CACHE_HOST ||
    (env.GITHUB_ACTIONS === "true"
      ? `${env.RUNNER_ENVIRONMENT || "github"}/${env.RUNNER_OS || NodeOS.platform()}/${env.RUNNER_ARCH || NodeOS.arch()}`
      : NodeOS.hostname());
  try {
    host =
      env.T3_TASK_CACHE_HOST ||
      NodeFS.readFileSync(NodePath.join(home, ".agents/MACHINE"), "utf8").trim() ||
      host;
  } catch {
    /* Machine labels are optional outside the fleet. */
  }
  const seen = new Set<string>();
  const snapshot = (file: string, enqueue: boolean) => {
    try {
      const before = NodeFS.statSync(file, { bigint: true });
      const contents = NodeFS.readFileSync(file, "utf8");
      const after = NodeFS.statSync(file, { bigint: true });
      if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) return;
      // Nested/concurrent launchers see the same summary; stable ids prevent double counting.
      const id = NodeCrypto.createHash("sha256")
        .update(`${host}\0${root}\0${before.ino}\0${before.mtimeNs}\0${contents}`)
        .digest("hex");
      if (seen.has(id)) return;
      seen.add(id);
      if (!enqueue) return;
      const tasks = summarize(JSON.parse(contents));
      if (!tasks.length) return;
      const event: SummaryEvent = {
        id,
        recordedAt: Number(before.mtimeNs / 1_000_000n),
        host: host.slice(0, 256),
        platform: NodeOS.platform(),
        arch: NodeOS.arch(),
        ci: env.GITHUB_ACTIONS === "true",
        runId: env.GITHUB_RUN_ID || "",
        tasks,
      };
      NodeFS.mkdirSync(queue, { recursive: true, mode: 0o700 });
      const temporary = NodePath.join(queue, `${id}.${process.pid}.tmp`);
      NodeFS.writeFileSync(temporary, JSON.stringify({ endpoint, event }), { mode: 0o600 });
      NodeFS.renameSync(temporary, NodePath.join(queue, `${id}.json`));
    } catch {
      /* Telemetry must never prevent task execution. */
    }
  };
  const scan = (enqueue: boolean) => {
    for (const entry of NodeFS.readdirSync(cache, { withFileTypes: true })) {
      if (entry.isDirectory())
        snapshot(NodePath.join(cache, entry.name, "last-summary.json"), enqueue);
    }
  };
  try {
    NodeFS.mkdirSync(cache, { recursive: true });
    scan(false);
    // Capture nested runs before the parent's atomic summary replaces them.
    const watcher = NodeFS.watch(cache, { recursive: true }, (_event, file) => {
      if (file?.endsWith("last-summary.json")) snapshot(NodePath.join(cache, file), true);
    });
    watcher.on("error", () => watcher.close());
    return () => {
      watcher.close();
      try {
        scan(true);
      } catch {
        /* A task may remove its cache directory. */
      }
    };
  } catch {
    return () => {};
  }
}

export async function flushTelemetry(home = NodeOS.homedir(), env = process.env) {
  const queue = NodePath.join(home, ".cache/t3-task-cache/telemetry");
  const deadline = Date.now() + 15_000;
  const skipped = new Set<string>();
  // A flusher that finds the lock taken exits and leaves its event to the holder. Re-check after
  // releasing, or an event queued after the holder's last scan waits for the next command.
  try {
    while (
      (await drainTelemetry(queue, home, env, deadline, skipped)) &&
      Date.now() < deadline &&
      NodeFS.readdirSync(queue).some((entry) => entry.endsWith(".json") && !skipped.has(entry))
    );
  } catch {
    /* Leave unsent events for a later invocation. */
  }
}

async function drainTelemetry(
  queue: string,
  home: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  skipped: Set<string>,
) {
  const lock = NodePath.join(queue, "flush.lock");
  try {
    NodeFS.mkdirSync(queue, { recursive: true, mode: 0o700 });
    try {
      if (Date.now() - NodeFS.statSync(lock).mtimeMs > 60_000) NodeFS.rmdirSync(lock);
    } catch {
      /* No previous flusher. */
    }
    NodeFS.mkdirSync(lock);
  } catch {
    return false;
  }
  try {
    const files = NodeFS.readdirSync(queue)
      .filter((file) => file.endsWith(".json"))
      .sort(
        (a, b) =>
          NodeFS.statSync(NodePath.join(queue, a)).mtimeMs -
          NodeFS.statSync(NodePath.join(queue, b)).mtimeMs,
      );
    // Bound disk use while offline. Unsent events retry on the next invocation.
    for (const file of files.slice(0, Math.max(0, files.length - 2000)))
      NodeFS.rmSync(NodePath.join(queue, file), { force: true });
    const credentialsFile = NodePath.join(home, ".config/t3-task-cache/credentials.json");
    const credentials = NodeFS.existsSync(credentialsFile)
      ? JSON.parse(NodeFS.readFileSync(credentialsFile, "utf8"))
      : {};
    // Re-scan between sends so a concurrent command's final summary joins this flush.
    for (let sent = 0; sent < 100 && Date.now() < deadline;) {
      const file = NodeFS.readdirSync(queue)
        .filter((entry) => entry.endsWith(".json") && !skipped.has(entry))
        .sort()[0];
      if (!file) return true;
      const path = NodePath.join(queue, file);
      const { endpoint, event } = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      const url = new URL(endpoint);
      const configured = env.VP_REMOTE_CACHE_URL ? new URL(env.VP_REMOTE_CACHE_URL) : undefined;
      const configuredEndpoint = configured && new URL(configured.href);
      if (configuredEndpoint) {
        configuredEndpoint.username = "";
        configuredEndpoint.password = "";
      }
      const credential =
        configured?.username && configuredEndpoint?.href.replace(/\/$/, "") === endpoint
          ? {
              name: decodeURIComponent(configured.username),
              token: decodeURIComponent(configured.password),
            }
          : credentials[endpoint];
      let authorization: string;
      if (
        credential &&
        !(
          env.GITHUB_ACTIONS === "true" &&
          env.ACTIONS_ID_TOKEN_REQUEST_URL &&
          env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
        )
      )
        authorization = `Basic ${Buffer.from(`${credential.name}:${credential.token}`).toString("base64")}`;
      else if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
        const tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
        tokenUrl.searchParams.set("audience", endpoint);
        const response = await fetch(tokenUrl, {
          headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) return false;
        const token = (await response.json()) as { value: string };
        authorization = `Bearer ${token.value}`;
      } else {
        skipped.add(file);
        continue;
      }
      sent++;
      url.pathname = `${url.pathname.replace(/\/$/, "")}/telemetry`;
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      if (response.ok || [400, 401, 403, 413].includes(response.status)) NodeFS.unlinkSync(path);
      else return false;
    }
  } catch {
    /* Leave unsent events for a later invocation. */
  } finally {
    NodeFS.rmdirSync(lock);
  }
}
