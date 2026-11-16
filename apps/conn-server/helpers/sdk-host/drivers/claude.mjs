// The Claude driver of the SDK host: Anthropic's official Claude Agent SDK, used as the T3 server
// uses it. The host imports this module the first time a `claude` message arrives.
//
// The Rust side sends the whole `query()` option object. This module adds only what JSON cannot
// carry: the prompt stream, the callbacks (canUseTool, onElicitation, onUserDialog, hooks) and
// the process spawn, which copies the T3 server's (`spawnClaudeProcessGroup` and the descendant
// tracker in `ClaudeAdapterV2.ts`).

import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  query,
  resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";

/** Prompts waiting for the CLI to take them, per query. T3's queue is unbounded. */
const MAX_QUEUED_PROMPTS = 64;
/** T3's `CLAUDE_STDERR_TAIL_LENGTH`: what a CLI that fails before its first message said. */
const STDERR_TAIL_LENGTH = 2048;
/** T3's `CLAUDE_DESCENDANT_POLL`. */
const DESCENDANT_POLL_MS = 1000;
/** How long an ended query waits for its CLI to exit before it reports the end. */
const EXIT_WAIT_MS = 10_000;

// T3's CLAUDE_GROUP_WATCH_SCRIPT: the CLI runs as `t3-claude` under /bin/sh; a watcher stops the
// CLI's process group when fd 3 (a pipe only this process holds) closes, also when we crash.
// fd 4 gates the launch: T3 first records the process so a restarted server can reap it. This
// host has no such record (nothing reaps after a restart), so it opens the gate at once. The
// shell enters the cwd itself (`cd -P`), as T3 does, so a mount that hangs chdir hangs only it.
const GROUP_WATCH_SCRIPT = [
  "read -r _ <&4 || exit 1",
  "exec 4<&-",
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'cd -P -- "$1" || exit 125',
  "shift",
  'exec "$@" 3<&-',
].join("\n");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

// ---- process spawn (T3's spawnClaudeProcessGroup and trackDescendants) ----

function signalGroup(pid, signal) {
  if (pid > 0) process.kill(-pid, signal);
}

function readProcessTable() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        const rows = [];
        for (const line of stdout.split("\n")) {
          const [pid, ppid, pgid, ...started] = line.trim().split(/\s+/);
          const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started: started.join(" ") };
          if (
            Number.isSafeInteger(row.pid) &&
            Number.isSafeInteger(row.ppid) &&
            Number.isSafeInteger(row.pgid) &&
            row.started
          ) {
            rows.push(row);
          }
        }
        resolve(rows);
      },
    );
  });
}

function descendants(rows, roots) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row]);
    else list.push(row);
  }
  const found = [];
  const seen = new Set(roots);
  const pending = [...roots];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

/**
 * A job that left the CLI's group escapes the group kill. So the CLI's tree is recorded while it
 * runs, and what is still the same process (pid and start time) is stopped after it exits.
 */
function trackDescendants(cliPid) {
  const tracked = new Map();
  const identity = (row) => `${row.pid} ${row.started}`;
  const refresh = async (cliRunning) => {
    const rows = await readProcessTable();
    const running = new Set(rows.map(identity));
    for (const [key] of tracked) if (!running.has(key)) tracked.delete(key);
    const roots = [...(cliRunning ? [cliPid] : []), ...[...tracked.values()].map((row) => row.pid)];
    for (const row of descendants(rows, roots)) tracked.set(identity(row), row);
    return running;
  };
  const stop = async () => {
    const running = await refresh(false);
    for (const [key, row] of tracked) {
      if (!running.has(key)) continue;
      try {
        if (row.pgid === row.pid) signalGroup(row.pid, "SIGKILL");
        else process.kill(row.pid, "SIGKILL");
      } catch {}
    }
    tracked.clear();
  };
  return { refresh: () => refresh(true), stop };
}

function makeSpawner(state, describeError) {
  return (spawnOptions) => {
    if (process.platform === "win32") {
      const child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => state.appendStderr(chunk));
      return child;
    }
    // Relative to this process's cwd, as a native cwd is; the `./` keeps CDPATH out of it.
    const cwd = spawnOptions.cwd ?? ".";
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        GROUP_WATCH_SCRIPT,
        "t3-claude",
        cwd.startsWith("/") ? cwd : `./${cwd}`,
        spawnOptions.command,
        ...spawnOptions.args,
      ],
      {
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    state.child = child;
    state.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        try {
          signalGroup(child.pid ?? 0, "SIGKILL");
        } catch {}
        state.exit = { code, signal };
        resolve();
      });
      // A spawn that fails emits only "error".
      child.once("error", (error) => {
        state.spawnError = describeError(error);
        resolve();
      });
    });
    let stderrDone = () => {};
    state.stderrClosed = new Promise((resolve) => (stderrDone = resolve));
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (chunk) => state.appendStderr(chunk))
      .once("close", stderrDone);
    // Unhandled 'error' on the fd 3 pipe would throw; it only matters as an EOF signal.
    child.stdio[3]?.on("error", () => {});
    const gate = child.stdio[4];
    if (child.pid !== undefined && gate) {
      try {
        gate.on("error", () => child.kill("SIGKILL"));
        gate.end("ready\n");
      } catch (cause) {
        child.kill("SIGKILL");
        gate.destroy();
        throw cause;
      }
    }
    if (child.pid !== undefined) {
      const tracker = trackDescendants(child.pid);
      const timer = setInterval(() => {
        tracker.refresh().catch(() => {});
      }, DESCENDANT_POLL_MS);
      state.refreshDescendants = () => tracker.refresh().then(() => undefined, () => undefined);
      child.once("exit", () => {
        clearInterval(timer);
        state.refreshDescendants = () => Promise.resolve();
        tracker.stop().catch(() => {});
      });
    }
    return child;
  };
}

// ---- the driver ----

/** Query methods the Rust side may call, as the T3 adapter calls them. */
const QUERY_METHODS = new Set([
  "interrupt",
  "setModel",
  "setPermissionMode",
  "applyFlagSettings",
  "setMcpServers",
  "stopTask",
  "backgroundTasks",
  "initializationResult",
  "mcpServerStatus",
  "readMcpResource",
]);

/**
 * T3's `renameSession`: the `rename_session` control request through the Query's own `request`
 * (`sendClaudeControlRequest`), so `claude --resume` shows the thread's title.
 */
async function renameSession(q, title) {
  if (typeof title !== "string") throw new Error("renameSession needs a title");
  const send = q === undefined ? undefined : Reflect.get(q, "request");
  if (typeof send !== "function") {
    throw new Error("This Claude Agent SDK cannot send rename_session.");
  }
  const reply = await Reflect.apply(send, q, [{ subtype: "rename_session", title, source: "host" }]);
  return reply !== null && typeof reply === "object" ? (reply.response ?? null) : null;
}

/** T3's `DEFAULT_TIMEOUT_MS`: the deadline of the probe's optional usage and settings reads. */
const PROBE_READ_TIMEOUT_MS = 4_000;
/** The account fields the probe reports (`ClaudeCapabilitiesProbe`); never a token. */
const PROBE_ACCOUNT_FIELDS = ["email", "subscriptionType", "tokenSource", "apiKeySource", "apiProvider"];
const ENV_TRAMPOLINE = "/usr/bin/env";

const withTimeout = (ms, promise) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** T3's `spawnClaudeProbeThroughEnv` (Linux, when `env -C` works): `env` enters the cwd. */
function spawnProbeThroughEnv({ command, args, cwd, env, signal }) {
  const usable = command !== "" && command !== "-" && !command.includes("=");
  const launch = usable
    ? { command: ENV_TRAMPOLINE, args: [...(cwd === undefined ? [] : ["-C", cwd]), "--", command, ...args] }
    : { command, args, cwd };
  return spawn(launch.command, launch.args, {
    ...("cwd" in launch ? { cwd: launch.cwd } : {}),
    env,
    signal,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

/**
 * T3's `probeClaudeCapabilities`: a query whose prompt never yields, so the CLI initializes
 * and no request reaches the API. `options` is T3's `buildClaudeCapabilitiesProbeQueryOptions`
 * as JSON; `unsetEnv` names variables T3 sets to undefined. Returns the account status fields,
 * the slash commands and models from initialization, and, with `includeStatus`, the usage
 * windows and each settings source's effort caps. The CLI is stopped before this returns
 * (after `graceMs` when gateway model discovery runs).
 */
async function probeCapabilities(options, extra = {}) {
  const abort = new AbortController();
  const env = { ...(options.env ?? {}) };
  for (const name of extra.unsetEnv ?? []) env[name] = undefined;
  const queryOptions = { ...options, env, abortController: abort, stderr: () => {} };
  if (extra.spawnThroughEnv === true) queryOptions.spawnClaudeCodeProcess = spawnProbeThroughEnv;
  const stop = () => {
    if (!abort.signal.aborted) abort.abort();
  };
  const prompt = (async function* () {
    await new Promise((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener("abort", resolve, { once: true });
    });
  })();
  let ok = false;
  try {
    const q = query({ prompt, options: queryOptions });
    const init = await withTimeout(extra.timeoutMs ?? 25_000, q.initializationResult());
    const usageCheckedAt = new Date().toISOString();
    const includeStatus = extra.includeStatus !== false;
    const [usage, settings] = await Promise.allSettled([
      includeStatus
        ? withTimeout(
            PROBE_READ_TIMEOUT_MS,
            q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
          )
        : Promise.reject(new Error("skipped")),
      includeStatus && typeof q.getSettings === "function"
        ? withTimeout(PROBE_READ_TIMEOUT_MS, q.getSettings())
        : Promise.reject(new Error("skipped")),
    ]);
    const account = {};
    for (const field of PROBE_ACCOUNT_FIELDS) {
      const value = init.account?.[field];
      if (typeof value === "string") account[field] = value;
    }
    // Only the effort caps of each settings source leave the host, never other settings.
    const caps = (raw) => {
      if (!raw || typeof raw !== "object") return {};
      const modelSettings = {};
      for (const [model, entry] of Object.entries(raw.modelSettings ?? {})) {
        if (entry && typeof entry === "object" && "maxEffortLevel" in entry) {
          modelSettings[model] = { maxEffortLevel: entry.maxEffortLevel };
        }
      }
      return { maxEffortLevel: raw.maxEffortLevel, modelSettings };
    };
    const settingsValue =
      settings.status === "fulfilled"
        ? Array.isArray(settings.value?.sources)
          ? { sources: settings.value.sources.map((source) => ({ settings: caps(source?.settings) })) }
          : { effective: caps(settings.value?.effective) }
        : null;
    ok = true;
    return {
      account,
      commands: init.commands ?? [],
      models: init.models ?? [],
      ...(usage.status === "fulfilled"
        ? {
            usage: {
              rate_limits_available: usage.value?.rate_limits_available,
              rate_limits: usage.value?.rate_limits,
            },
            usageCheckedAt,
          }
        : {}),
      ...(settingsValue === null ? {} : { settings: settingsValue }),
    };
  } finally {
    // A failed probe stops at once; a good one after the gateway's discovery grace.
    const grace = ok ? (extra.graceMs ?? 0) : 0;
    if (grace > 0) setTimeout(stop, grace);
    else stop();
  }
}

const FUNCTIONS = {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  resolveSettings,
  probeCapabilities,
};

/**
 * `host` gives `describeError`. A session handle from the host gives `emit(message)` for SDK
 * messages, `request(kind, id, args, signal)` for questions to Rust, and `end(info)`.
 */
export function createDriver(host) {
  const { describeError } = host;
  // The SDK reads CLAUDE_CONFIG_DIR from process.env. Calls with a configDir run one at a time,
  // each with its own value, so callers with different homes do not mix (T3 uses a worker).
  let functionChain = Promise.resolve();

  return {
    open(session, command) {
      const state = {
        prompts: [],
        waiting: null,
        inputClosed: false,
        exit: undefined,
        exited: Promise.resolve(),
        stderrClosed: Promise.resolve(),
        spawnError: undefined,
        answered: false,
        stderrTail: "",
        refreshDescendants: () => Promise.resolve(),
        appendStderr(text) {
          if (state.answered) return;
          state.stderrTail = (state.stderrTail + text).slice(-STDERR_TAIL_LENGTH);
        },
        query: undefined,
        child: undefined,
      };
      session.state = state;
      const prompt = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const value = state.prompts.shift();
              if (value !== undefined) return Promise.resolve({ value, done: false });
              if (state.inputClosed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => {
                state.waiting = resolve;
              });
            },
            return() {
              state.inputClosed = true;
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
      const options = { ...(command.options ?? {}) };
      options.canUseTool = (toolName, input, callbackOptions) => {
        const { signal, ...rest } = callbackOptions ?? {};
        return session.request("canUseTool", rest.requestId, { toolName, input, options: rest }, signal);
      };
      options.onElicitation = (request, callbackOptions) =>
        session.request("elicitation", callbackOptions?.requestId, request, callbackOptions?.signal);
      options.onUserDialog = (request, callbackOptions) =>
        session.request("userDialog", callbackOptions?.requestId, request, callbackOptions?.signal);
      // T3's `hooks`: SubagentStart first, then Stop, so the CLI numbers their callbacks alike.
      const hooks = {};
      if (typeof command.subagentStartContext === "string") {
        const additionalContext = command.subagentStartContext;
        hooks.SubagentStart = [
          {
            hooks: [
              () =>
                Promise.resolve({
                  hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext },
                }),
            ],
          },
        ];
      }
      // T3's `onStop` answers `{continue: false}` only while a Claude goal is active and a
      // delegated task will wake the thread. The Conn Server tracks no Claude goals, so it gives
      // T3's answer for a thread without an active goal.
      if (command.stopHook === true) hooks.Stop = [{ hooks: [() => Promise.resolve({})] }];
      if (Object.keys(hooks).length > 0) options.hooks = hooks;
      if (command.wrap !== false) options.spawnClaudeCodeProcess = makeSpawner(state, describeError);

      let q;
      try {
        q = query({ prompt, options });
      } catch (error) {
        session.end({ error: describeError(error) });
        return;
      }
      state.query = q;
      (async () => {
        let error;
        try {
          // Iterate Query itself (T3's claudeQueryMessages).
          for await (const message of { [Symbol.asyncIterator]: () => q }) {
            state.answered = true;
            const wait = session.emit(message);
            if (wait !== null) await wait;
          }
        } catch (cause) {
          error = describeError(cause);
        }
        // Node can report "exit" before it has read the stderr the CLI wrote.
        if (!state.answered) await Promise.race([state.stderrClosed, delay(1000)]);
        await Promise.race([state.exited, delay(EXIT_WAIT_MS)]);
        const end = {};
        if (error !== undefined) end.error = error;
        if (state.exit !== undefined) end.exit = state.exit;
        if (state.spawnError !== undefined) end.spawnError = state.spawnError;
        if (!state.answered && state.stderrTail.length > 0) end.stderr = state.stderrTail;
        session.end(end);
      })();
    },

    async input(session, message) {
      const state = session.state;
      if (state === undefined || state.inputClosed) throw new Error("the query's input is closed");
      if (state.prompts.length >= MAX_QUEUED_PROMPTS) throw new Error("too many queued prompts");
      if (state.waiting !== null) {
        const resolve = state.waiting;
        state.waiting = null;
        resolve({ value: message, done: false });
      } else {
        state.prompts.push(message);
      }
      return null;
    },

    async call(session, method, args) {
      const state = session.state;
      const mcp = ["mcpServerStatus", "readMcpResource", "callMcpTool", "listPermissionRules"].includes(method);
      if (mcp) {
        state.mcpRequests ??= 0;
        if (state.mcpRequests >= 32) throw new Error("Too many pending MCP App requests.");
        state.mcpRequests += 1;
      }
      try {
        if (method === "callMcpTool" || method === "listPermissionRules") {
          const q = session.state?.query;
          const send = q === undefined ? undefined : Reflect.get(q, "request");
          const subtype = method === "callMcpTool" ? "mcp_call" : "list_permission_rules";
          if (typeof send !== "function") throw new Error(`This Claude Agent SDK cannot send ${subtype}.`);
          const reply = await Reflect.apply(send, q, [method === "callMcpTool"
            ? { subtype, tool: args[0].tool, arguments: args[0].arguments, result_not_for_model: true }
            : { subtype }]);
          if (method === "callMcpTool") return reply?.response ?? null;
          const state = reply?.response?.state;
          if (!Array.isArray(state?.rules) || (state.errors !== undefined && (!Array.isArray(state.errors) || state.errors.length !== 0)) || state.rules.some((rule) => !rule || !["allow", "deny", "ask"].includes(rule.behavior) || typeof rule.rule !== "string" || (rule.notInEffect !== undefined && typeof rule.notInEffect !== "boolean"))) {
            throw new Error("Claude's permission rules could not be read.");
          }
          return state.rules;
        }
        if (method === "renameSession") return renameSession(session.state?.query, args?.[0]);
        if (!QUERY_METHODS.has(method)) throw new Error(`unknown query method ${method}`);
        const q = session.state?.query;
        const fn = q?.[method];
        if (typeof fn !== "function") throw new Error(`this SDK has no Query.${method}`);
        const value = await fn.apply(q, args);
        return value === undefined ? null : value;
      } finally {
        if (mcp) state.mcpRequests -= 1;
      }
    },

    async close(session) {
      const state = session.state;
      if (state?.query === undefined) return;
      // A job started since the last poll is recorded before the CLI is told to exit.
      if (state.exit === undefined) await state.refreshDescendants();
      state.inputClosed = true;
      if (state.waiting !== null) {
        const resolve = state.waiting;
        state.waiting = null;
        resolve({ value: undefined, done: true });
      }
      state.query.close();
    },

    /**
     * The T3 server's teardown of a query whose open was interrupted (a Stop while it waits for
     * `initializationResult` or `setMcpServers`, `ClaudeAdapterV2` `openQuery`): the prompt
     * stream ends, the CLI's wrapper gets SIGKILL (its exit kills the CLI's group), up to 10 s
     * for it to exit, then the query is disposed. `end` follows as for any query.
     */
    async abort(session) {
      const state = session.state;
      if (state?.query === undefined) return;
      state.inputClosed = true;
      if (state.waiting !== null) {
        const resolve = state.waiting;
        state.waiting = null;
        resolve({ value: undefined, done: true });
      }
      try {
        if (state.child !== undefined && state.exit === undefined && state.spawnError === undefined) {
          state.child.kill("SIGKILL");
        }
        await Promise.race([state.exited, delay(EXIT_WAIT_MS)]);
      } finally {
        const dispose = state.query[Symbol.asyncDispose];
        await (typeof dispose === "function" ? dispose.call(state.query) : state.query.close());
      }
    },

    fn(name, args, configDir) {
      const fn = FUNCTIONS[name];
      if (typeof fn !== "function") return Promise.reject(new Error(`unknown function ${name}`));
      const run = async () => {
        // Without a configDir the SDK reads the host's own environment, as T3's in-process calls do.
        if (typeof configDir !== "string") return (await fn(...args)) ?? null;
        const before = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDir;
        try {
          return (await fn(...args)) ?? null;
        } finally {
          if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = before;
        }
      };
      const result = functionChain.then(run, run);
      functionChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
