// The Conn Server's Claude helper: runs Claude through the official Claude Agent SDK, as the T3
// server does, and speaks JSON lines with the Rust server. See PROTOCOL.md.
//
// The Rust side sends the whole `query()` option object. This file adds only what JSON cannot
// carry: the prompt stream, the callbacks (canUseTool, onElicitation, onUserDialog, hooks) and
// the process spawn, which copies the T3 server's (`spawnClaudeProcessGroup` and the
// descendant tracker in `ClaudeAdapterV2.ts`).
//
// State is per open query and ends with it. Queues are bounded; stdout gives the backpressure.

import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  query,
  resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Prompts waiting for the CLI to take them, per query. T3's queue is unbounded. */
const MAX_QUEUED_PROMPTS = 64;
/** T3's `CLAUDE_STDERR_TAIL_LENGTH`: what a CLI that fails before its first message said. */
const STDERR_TAIL_LENGTH = 2048;
/** T3's `CLAUDE_DESCENDANT_POLL`. */
const DESCENDANT_POLL_MS = 1000;
/** After the input closes, how long open queries get to end before the helper exits. */
const SHUTDOWN_GRACE_MS = 15_000;
/** How long an ended query waits for its CLI to exit before it reports the end. */
const EXIT_WAIT_MS = 10_000;

// T3's CLAUDE_GROUP_WATCH_SCRIPT: the CLI runs as `t3-claude` under /bin/sh; a watcher stops the
// CLI's process group when fd 3 (a pipe only this process holds) closes, also when we crash.
const GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

// ---- output ----

let draining = null;

/** Writes one line. Returns a promise while stdout is full, so producers can wait. */
function emit(value) {
  const ok = process.stdout.write(`${JSON.stringify(value)}\n`);
  if (!ok && draining === null) {
    draining = once(process.stdout, "drain").then(() => {
      draining = null;
    });
  }
  return draining;
}

function log(text) {
  process.stderr.write(`conn-claude-sdk-helper: ${text}\n`);
}

function describeError(error) {
  if (error === null || typeof error !== "object") return { message: String(error) };
  const out = { message: typeof error.message === "string" ? error.message : String(error) };
  if (typeof error.errorClass === "string") out.errorClass = error.errorClass;
  if (typeof error.telemetryMessage === "string") out.telemetryMessage = error.telemetryMessage;
  return out;
}

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
          const row = {
            pid: Number(pid),
            ppid: Number(ppid),
            pgid: Number(pgid),
            started: started.join(" "),
          };
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
 * Bounded by the processes alive under the CLI.
 */
function trackDescendants(cliPid) {
  const tracked = new Map();
  const identity = (row) => `${row.pid} ${row.started}`;
  const refresh = async (cliRunning) => {
    const rows = await readProcessTable();
    const running = new Set(rows.map(identity));
    for (const [key] of tracked) if (!running.has(key)) tracked.delete(key);
    const roots = [
      ...(cliRunning ? [cliPid] : []),
      ...[...tracked.values()].map((row) => row.pid),
    ];
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

function makeSpawner(state) {
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
      state.child = child;
      return child;
    }
    const child = spawn(
      "/bin/sh",
      ["-c", GROUP_WATCH_SCRIPT, "t3-claude", spawnOptions.command, ...spawnOptions.args],
      {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
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

// ---- queries ----

/** Open queries by the Rust side's id. */
const sessions = new Map();

/** Ends after this many concurrent queries; one per live Claude thread. */
const MAX_SESSIONS = 256;

function openSession(command) {
  const id = command.s;
  if (typeof id !== "string" || sessions.has(id) || sessions.size >= MAX_SESSIONS) {
    emit({ t: "end", s: id, error: { message: "the helper cannot open this query" } });
    return;
  }
  const state = {
    prompts: [],
    waiting: null,
    inputClosed: false,
    pending: new Map(),
    child: undefined,
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
  };
  sessions.set(id, state);

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

  let nextLocalId = 0;
  const ask = (kind, requestId, args, signal) =>
    new Promise((resolve, reject) => {
      const key = typeof requestId === "string" ? requestId : `helper-${++nextLocalId}`;
      if (signal?.aborted) return reject(new Error("aborted"));
      state.pending.set(key, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (state.pending.delete(key)) {
            emit({ t: "cancel", s: id, id: key });
            reject(new Error("aborted"));
          }
        },
        { once: true },
      );
      emit({ t: "callback", s: id, id: key, kind, args });
    });

  const options = { ...(command.options ?? {}) };
  options.canUseTool = (toolName, input, callbackOptions) => {
    const { signal, ...rest } = callbackOptions ?? {};
    return ask("canUseTool", rest.requestId, { toolName, input, options: rest }, signal);
  };
  options.onElicitation = (request, callbackOptions) =>
    ask("elicitation", callbackOptions?.requestId, request, callbackOptions?.signal);
  options.onUserDialog = (request, callbackOptions) =>
    ask("userDialog", callbackOptions?.requestId, request, callbackOptions?.signal);
  if (typeof command.subagentStartContext === "string") {
    const additionalContext = command.subagentStartContext;
    options.hooks = {
      SubagentStart: [
        {
          hooks: [
            () =>
              Promise.resolve({
                hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext },
              }),
          ],
        },
      ],
    };
  }
  if (command.wrap !== false) options.spawnClaudeCodeProcess = makeSpawner(state);

  let q;
  try {
    q = query({ prompt, options });
  } catch (error) {
    sessions.delete(id);
    emit({ t: "end", s: id, error: describeError(error) });
    return;
  }
  state.query = q;

  (async () => {
    let error;
    try {
      // Iterate Query itself (T3's claudeQueryMessages).
      for await (const message of { [Symbol.asyncIterator]: () => q }) {
        state.answered = true;
        const wait = emit({ t: "msg", s: id, m: message });
        if (wait !== null) await wait;
      }
    } catch (cause) {
      error = describeError(cause);
    }
    // Node can report "exit" before it has read the stderr the CLI wrote.
    if (!state.answered) await Promise.race([state.stderrClosed, delay(1000)]);
    await Promise.race([state.exited, delay(EXIT_WAIT_MS)]);
    sessions.delete(id);
    for (const pending of state.pending.values()) pending.reject(new Error("query ended"));
    state.pending.clear();
    const end = { t: "end", s: id };
    if (error !== undefined) end.error = error;
    if (state.exit !== undefined) end.exit = state.exit;
    if (state.spawnError !== undefined) end.spawnError = state.spawnError;
    if (!state.answered && state.stderrTail.length > 0) end.stderr = state.stderrTail;
    emit(end);
    maybeExit();
  })();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function offerPrompt(state, message) {
  if (state.inputClosed) throw new Error("the query's input is closed");
  if (state.prompts.length >= MAX_QUEUED_PROMPTS) throw new Error("too many queued prompts");
  if (state.waiting !== null) {
    const resolve = state.waiting;
    state.waiting = null;
    resolve({ value: message, done: false });
  } else {
    state.prompts.push(message);
  }
}

async function closeSession(state) {
  if (state.query === undefined) return;
  // A job started since the last poll is recorded before the CLI is told to exit.
  if (state.exit === undefined) await state.refreshDescendants();
  state.inputClosed = true;
  if (state.waiting !== null) {
    const resolve = state.waiting;
    state.waiting = null;
    resolve({ value: undefined, done: true });
  }
  state.query.close();
}

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
]);

async function callSession(state, method, args) {
  if (method === "offer") {
    offerPrompt(state, args[0]);
    return null;
  }
  if (!QUERY_METHODS.has(method)) throw new Error(`unknown query method ${method}`);
  const fn = state.query?.[method];
  if (typeof fn !== "function") throw new Error(`this SDK has no Query.${method}`);
  const value = await fn.apply(state.query, args);
  return value === undefined ? null : value;
}

// ---- session-file functions ----

const FUNCTIONS = { forkSession, getSessionMessages, getSubagentMessages, resolveSettings };

// The SDK reads CLAUDE_CONFIG_DIR from process.env. Calls run one at a time, each with its own
// value, so concurrent callers with different homes do not mix (T3 uses a worker process).
let functionChain = Promise.resolve();

function callFunction(name, args, configDir) {
  const fn = FUNCTIONS[name];
  if (typeof fn !== "function") return Promise.reject(new Error(`unknown function ${name}`));
  const run = async () => {
    // Without a configDir the SDK reads the helper's own environment, as T3's in-process calls do.
    if (typeof configDir !== "string") {
      const value = await fn(...args);
      return value === undefined ? null : value;
    }
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const value = await fn(...args);
      return value === undefined ? null : value;
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
}

// ---- commands ----

let shuttingDown = false;

function reply(id, promise) {
  promise.then(
    (value) => emit({ t: "reply", id, ok: true, value }),
    (error) => emit({ t: "reply", id, ok: false, error: describeError(error) }),
  );
}

function handle(command) {
  switch (command.t) {
    case "open":
      if (shuttingDown) {
        emit({ t: "end", s: command.s, error: { message: "the helper is stopping" } });
        return;
      }
      openSession(command);
      return;
    case "call": {
      const state = sessions.get(command.s);
      const args = Array.isArray(command.args) ? command.args : [];
      reply(
        command.id,
        state === undefined
          ? Promise.reject(new Error("no such query"))
          : callSession(state, command.method, args),
      );
      return;
    }
    case "answer": {
      const pending = sessions.get(command.s)?.pending.get(command.id);
      if (pending === undefined) return;
      sessions.get(command.s)?.pending.delete(command.id);
      if (command.error !== undefined) pending.reject(new Error(String(command.error)));
      else pending.resolve(command.value ?? null);
      return;
    }
    case "close": {
      const state = sessions.get(command.s);
      if (state !== undefined) closeSession(state).catch((error) => log(describeError(error).message));
      return;
    }
    case "fn":
      reply(
        command.id,
        callFunction(command.name, Array.isArray(command.args) ? command.args : [], command.configDir),
      );
      return;
    case "shutdown":
      shutdown();
      return;
    default:
      log(`unknown command ${String(command.t)}`);
  }
}

function maybeExit() {
  if (shuttingDown && sessions.size === 0) {
    process.stdout.end(() => process.exit(0));
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const state of sessions.values()) {
    closeSession(state).catch(() => {});
  }
  maybeExit();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}

process.on("unhandledRejection", (error) => log(`unhandled: ${describeError(error).message}`));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdout.on("error", () => process.exit(0));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.length === 0) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    log("dropped a line that is not JSON");
    return;
  }
  if (command === null || typeof command !== "object") return;
  try {
    handle(command);
  } catch (error) {
    log(describeError(error).message);
  }
});
input.on("close", shutdown);
emit({ t: "ready", node: process.versions.node });
